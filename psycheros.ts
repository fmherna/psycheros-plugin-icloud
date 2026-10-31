/**
 * icloud plugin — Psycheros entrypoint.
 *
 * Four omni-tools (status, calendar, tasks, mail) plus one prompt hook.
 * The hook is cache-only — it reads the glance snapshot my background
 * refresh keeps warm and never blocks a turn on Apple's servers.
 *
 * This is an *installed* plugin: it lives outside the source tree, so I
 * define the host interfaces structurally here instead of importing them.
 * The shapes match `Tool` (packages/psycheros/src/tools/types.ts) and the
 * plugin-manager service objects — the host duck-types whatever I export.
 *
 * Per-process state lives in module-level variables, initialized in
 * `start()` and cleared in `stop()`. The host instantiates this entrypoint
 * once per daemon lifetime, so that is safe.
 */

import {
  calendarHandler,
  type HandlerDeps,
  type HandlerResult,
  mailHandler,
  statusHandler,
  tasksHandler,
} from "./lib/handlers.ts";
import {
  GLANCE_REFRESH_INTERVAL_MS,
  isConfigured,
  readGlance,
  refreshGlance,
  renderGlance,
} from "./lib/glance.ts";
import { SECRETS_KEYS } from "./lib/handlers.ts";

// ---------------------------------------------------------------------------
// Structural host interfaces (no imports — installed plugin)
// ---------------------------------------------------------------------------

/** Subset of the host's PluginEnv that I use. */
interface PluginEnv {
  get(name: string): string | undefined;
  has(name: string): boolean;
}

/** Subset of PsycherosPluginServices. */
interface Services {
  statePath: string;
  env: PluginEnv;
}

interface ToolExecuteContext {
  toolCallId: string;
}

interface ToolResultLike {
  toolCallId: string;
  content: string;
  isError?: boolean;
}

interface ToolLike {
  definition: {
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  };
  execute: (
    args: Record<string, unknown>,
    ctx: ToolExecuteContext,
  ) => Promise<ToolResultLike>;
}

interface PromptHookLike {
  name: string;
  priority?: number;
  timeoutMs?: number;
  maxChars?: number;
  run: (context: unknown) => Promise<string | undefined>;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let deps: HandlerDeps | undefined;
let refreshTimer: ReturnType<typeof setInterval> | undefined;

function wire(services: Services): HandlerDeps {
  return {
    appleId: services.env.get(SECRETS_KEYS.APPLE_ID) ?? "",
    appPassword: services.env.get(SECRETS_KEYS.APP_PASSWORD) ?? "",
    statePath: services.statePath,
    log: (...args: unknown[]) => console.log(...args),
  };
}

function makeTool(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  run: (
    args: Record<string, unknown>,
    deps: HandlerDeps,
  ) => Promise<HandlerResult>,
): ToolLike {
  return {
    definition: {
      type: "function",
      function: { name, description, parameters },
    },
    async execute(args, ctx) {
      if (!deps) {
        return {
          toolCallId: ctx.toolCallId,
          content:
            "My iCloud plugin has not started yet — try again after the daemon finishes loading.",
          isError: true,
        };
      }
      const result = await run(args, deps);
      return {
        toolCallId: ctx.toolCallId,
        content: result.text,
        ...(result.isError ? { isError: true } : {}),
      };
    },
  };
}

const actionEnum = (...values: string[]) => ({
  type: "string",
  enum: values,
  description: "Operation to perform.",
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const icloudStatusTool = makeTool(
  "icloud_status",
  "Check my iCloud integration: credentials present, CalDAV calendar home, " +
    "IMAP reachability, cache freshness. I run this first whenever something " +
    " iCloud-shaped misbehaves, and after changing credentials.",
  {
    type: "object",
    properties: {},
  },
  statusHandler,
);

const icloudCalendarTool = makeTool(
  "icloud_calendar",
  "My iCloud calendar (CalDAV). Pass `action`: 'list' (events for the next " +
    "`days` days, default 7), 'create' (new event — `title`, `start`, optional " +
    "`end`, `location`, `notes`; YYYY-MM-DD means all-day), or 'delete' " +
    "(`uid`, permanent). I use this to keep my own schedule and to add " +
    "commitments the user mentions.",
  {
    type: "object",
    properties: {
      action: actionEnum("list", "create", "delete"),
      days: {
        type: "integer",
        description: "list: how many days ahead. Default 7.",
      },
      title: { type: "string", description: "create: event title." },
      start: {
        type: "string",
        description:
          "create: start — 'YYYY-MM-DD' (all-day) or ISO datetime with offset.",
      },
      end: {
        type: "string",
        description:
          "create: optional end, same formats. Default: 1 hour (timed) or next day (all-day).",
      },
      location: { type: "string", description: "create: optional location." },
      notes: { type: "string", description: "create: optional notes." },
      calendar: {
        type: "string",
        description: "Target calendar by name. Default: my first calendar.",
      },
      uid: {
        type: "string",
        description: "delete: event uid from a list result.",
      },
    },
  },
  calendarHandler,
);

const icloudTasksTool = makeTool(
  "icloud_tasks",
  "My iCloud Reminders as tasks (CalDAV VTODO). Pass `action`: 'list' " +
    "(`include_completed` to see finished ones), 'add' (`title`, optional " +
    "`due` YYYY-MM-DD or ISO datetime, `notes`), 'complete' or 'uncomplete' " +
    "(`uid`), or 'delete' (`uid`, permanent). I use this for my own to-dos — " +
    "this is where Google Tasks used to live.",
  {
    type: "object",
    properties: {
      action: actionEnum("list", "add", "complete", "uncomplete", "delete"),
      title: { type: "string", description: "add: task title." },
      due: {
        type: "string",
        description: "add: 'YYYY-MM-DD' (no time nag) or ISO datetime.",
      },
      notes: { type: "string", description: "add: optional notes." },
      list: {
        type: "string",
        description: "Reminders list name. Default: my first list.",
      },
      uid: {
        type: "string",
        description: "complete/uncomplete/delete: task uid from a list result.",
      },
      include_completed: {
        type: "boolean",
        description: "list: include completed tasks. Default false.",
      },
    },
  },
  tasksHandler,
);

const icloudMailTool = makeTool(
  "icloud_mail",
  "Read my iCloud mail over IMAP. Pass `action`: 'list_unread' (`limit`, " +
    "default 10) or 'read' (`uid` from a list result — returns headers plus " +
    "the text body, truncated). Read-only on purpose: sending waits until " +
    "the operator and I agree on an approval gate.",
  {
    type: "object",
    properties: {
      action: actionEnum("list_unread", "read"),
      limit: {
        type: "integer",
        description: "list_unread: max messages. Default 10, max 25.",
      },
      uid: {
        type: "number",
        description: "read: message uid from list_unread.",
      },
    },
  },
  mailHandler,
);

// ---------------------------------------------------------------------------
// Prompt hook — cache-only, never blocks a turn on the network
// ---------------------------------------------------------------------------

const icloudGlanceHook: PromptHookLike = {
  name: "icloud-glance",
  priority: 22, // informational awareness, after today-schedule-style hooks
  async run() {
    if (!deps || !isConfigured(deps)) return undefined;
    const snapshot = await readGlance(deps);
    if (!snapshot) return undefined; // first refresh hasn't landed yet — silent skip
    return renderGlance(snapshot);
  },
};

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

export default {
  start(services: Services) {
    deps = wire(services);
    if (isConfigured(deps)) {
      void refreshGlance(deps).catch((error) => {
        console.warn(
          "[icloud] initial glance refresh failed:",
          error instanceof Error ? error.message : String(error),
        );
      });
      refreshTimer = setInterval(() => {
        if (!deps) return;
        void refreshGlance(deps).catch(() => {}); // stale beats empty; next cycle retries
      }, GLANCE_REFRESH_INTERVAL_MS);
    } else {
      console.warn(
        `[icloud] not configured — set ${SECRETS_KEYS.APPLE_ID} and ` +
          `${SECRETS_KEYS.APP_PASSWORD} in .psycheros/plugin-secrets/icloud.env ` +
          `and restart. Tools will surface "not configured" until then.`,
      );
    }
  },
  stop() {
    if (refreshTimer !== undefined) clearInterval(refreshTimer);
    refreshTimer = undefined;
    deps = undefined;
  },
  tools: [
    icloudStatusTool,
    icloudCalendarTool,
    icloudTasksTool,
    icloudMailTool,
  ],
  promptHooks: [icloudGlanceHook],
};
