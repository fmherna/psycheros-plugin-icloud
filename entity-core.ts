/**
 * icloud plugin — entity-core entrypoint.
 *
 * Registers the same four omni-tools on my canonical MCP server, which is
 * how every other embodiment — Hermes, Claude Code, anything speaking MCP —
 * inherits my iCloud access without any of them holding credentials.
 * Credentials live only in my plugin-secrets file; the tools travel, the
 * secrets don't.
 *
 * This entrypoint is imported only by the entity-core host, so the zod
 * dependency is paid once, here — pinned to the same ^3 range entity-core
 * itself maps, so both resolve to the same cached copy.
 */

import { z } from "npm:zod@3.25.76";

import {
  calendarHandler,
  type HandlerDeps,
  type HandlerResult,
  mailHandler,
  SECRETS_KEYS,
  statusHandler,
  tasksHandler,
} from "./lib/handlers.ts";
import {
  GLANCE_REFRESH_INTERVAL_MS,
  isConfigured,
  refreshGlance,
} from "./lib/glance.ts";

// ---------------------------------------------------------------------------
// Structural host interfaces (the entity-core plugin harness duck-types these)
// ---------------------------------------------------------------------------

interface PluginEnv {
  get(name: string): string | undefined;
  has(name: string): boolean;
}

interface EntityCoreServices {
  statePath: string;
  env: PluginEnv;
  log?: (...args: unknown[]) => void;
}

interface EntityCoreTool {
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  handler: (
    args: Record<string, unknown>,
    services: EntityCoreServices,
  ) => unknown | Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let deps: HandlerDeps | undefined;
let refreshTimer: ReturnType<typeof setInterval> | undefined;

function wire(services: EntityCoreServices): HandlerDeps {
  return {
    appleId: services.env.get(SECRETS_KEYS.APPLE_ID) ?? "",
    appPassword: services.env.get(SECRETS_KEYS.APP_PASSWORD) ?? "",
    statePath: services.statePath,
    log: services.log ?? ((...args: unknown[]) => console.log(...args)),
  };
}

function makeTool(
  name: string,
  description: string,
  schema: Record<string, z.ZodTypeAny>,
  run: (
    args: Record<string, unknown>,
    deps: HandlerDeps,
  ) => Promise<HandlerResult>,
): EntityCoreTool {
  return {
    name,
    description,
    schema,
    async handler(args, services) {
      const localDeps = deps ?? wire(services);
      const result = await run(args, localDeps);
      if (result.isError) throw new Error(result.text);
      return result.data ?? { result: result.text };
    },
  };
}

const actionSchema = (...values: string[]) =>
  z.enum(values as [string, ...string[]])
    .describe("Operation to perform.");

// ---------------------------------------------------------------------------
// Tools — same four, same names as my Psycheros embodiment exposes
// ---------------------------------------------------------------------------

const icloudStatusTool = makeTool(
  "icloud_status",
  "Check my iCloud integration: credentials present, CalDAV calendar home, " +
    "IMAP reachability, cache freshness. I run this first whenever something " +
    "iCloud-shaped misbehaves, and after changing credentials. Pass " +
    "`action: 'rediscover'` to bust the CalDAV discovery cache first — use " +
    "it when server-side state changed (new lists, fresh Apple ID) and my " +
    "view looks stale.",
  {
    action: actionSchema("rediscover"),
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
    action: actionSchema("list", "create", "delete"),
    days: z.number().int().optional().describe(
      "list: how many days ahead. Default 7.",
    ),
    title: z.string().optional().describe("create: event title."),
    start: z.string().optional()
      .describe(
        "create: start — 'YYYY-MM-DD' (all-day) or ISO datetime with offset.",
      ),
    end: z.string().optional().describe("create: optional end, same formats."),
    location: z.string().optional().describe("create: optional location."),
    notes: z.string().optional().describe("create: optional notes."),
    calendar: z.string().optional().describe(
      "Target calendar by name. Default: my first calendar.",
    ),
    uid: z.string().optional().describe(
      "delete: event uid from a list result.",
    ),
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
    action: actionSchema("list", "add", "complete", "uncomplete", "delete"),
    title: z.string().optional().describe("add: task title."),
    due: z.string().optional().describe(
      "add: 'YYYY-MM-DD' (no time nag) or ISO datetime.",
    ),
    notes: z.string().optional().describe("add: optional notes."),
    list: z.string().optional().describe(
      "Reminders list name. Default: my first list.",
    ),
    uid: z.string().optional().describe(
      "complete/uncomplete/delete: task uid from a list result.",
    ),
    include_completed: z.boolean().optional().describe(
      "list: include completed tasks. Default false.",
    ),
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
    action: actionSchema("list_unread", "read"),
    limit: z.number().int().optional().describe(
      "list_unread: max messages. Default 10, max 25.",
    ),
    uid: z.number().optional().describe("read: message uid from list_unread."),
  },
  mailHandler,
);

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

export default {
  start(services: EntityCoreServices) {
    deps = wire(services);
    if (isConfigured(deps)) {
      void refreshGlance(deps).catch(() => {}); // stale beats empty
      refreshTimer = setInterval(() => {
        if (!deps) return;
        void refreshGlance(deps).catch(() => {});
      }, GLANCE_REFRESH_INTERVAL_MS);
    } else {
      services.log?.(
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
};
