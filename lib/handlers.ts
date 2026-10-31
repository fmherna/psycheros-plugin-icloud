/**
 * Shared action handlers for my four iCloud omni-tools.
 *
 * Both of my hosts — the Psycheros embodiment and entity-core (which is
 * what Hermes and any other embodiment see) — call these with the same
 * argument objects and get back { text, data }: `text` is the human-shaped
 * result the chat surface shows, `data` is the structured version MCP
 * clients can reason over. Host-specific concerns (zod schemas, tool-call
 * IDs) live in the entrypoints; everything iCloud lives here.
 */

import {
  CalDAVError,
  createEvent,
  createTask,
  deleteObject,
  getDiscovery,
  invalidateDiscovery,
  listEvents,
  listTasks,
  setTaskCompleted,
  type TaskRecord,
} from "./caldav.ts";
import { buildVevent, buildVtodo, icsValueToMs } from "./ics.ts";
import { checkMail, listUnread, readMessage } from "./mail.ts";
import {
  type GlanceDeps,
  isConfigured,
  readGlance,
  refreshGlance,
} from "./glance.ts";

export interface HandlerDeps extends GlanceDeps {}

export interface HandlerResult {
  text: string;
  data?: unknown;
  isError?: boolean;
}

export const SECRETS_KEYS = {
  APPLE_ID: "PSYCHEROS_PLUGIN_ICLOUD_APPLE_ID",
  APP_PASSWORD: "PSYCHEROS_PLUGIN_ICLOUD_APP_PASSWORD",
} as const;

function notConfigured(): HandlerResult {
  return {
    isError: true,
    text:
      `My iCloud integration is not configured yet. The operator needs to fill ` +
      `${SECRETS_KEYS.APPLE_ID} and ${SECRETS_KEYS.APP_PASSWORD} in ` +
      `.psycheros/plugin-secrets/icloud.env (app-specific password from ` +
      `account.apple.com), then restart the daemon. See plugins/icloud/README.md.`,
    data: { configured: false },
  };
}

function errorResult(error: unknown, what: string): HandlerResult {
  if (error instanceof CalDAVError && error.status === 401) {
    return {
      isError: true,
      text:
        `iCloud rejected my credentials (401) for ${what}. The app-specific ` +
        `password may have been revoked — a new one can be generated at ` +
        `account.apple.com and placed in plugin-secrets/icloud.env, then restart.`,
      data: { error: "auth", status: 401 },
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    text: `${what} failed: ${message}`,
    data: { error: message },
  };
}

// ---------------------------------------------------------------------------
// arg coercion helpers
// ---------------------------------------------------------------------------

function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function num(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (
    typeof value === "string" && value.trim() !== "" && Number.isFinite(+value)
  ) {
    return +value;
  }
  return undefined;
}

function actionOf(args: Record<string, unknown>): string {
  return str(args, "action") ?? "";
}

// ---------------------------------------------------------------------------
// formatting helpers
// ---------------------------------------------------------------------------

function fmtDateTime(ms: number, allDay: boolean): string {
  if (allDay) {
    return new Date(ms).toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  }
  return new Date(ms).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtDue(task: TaskRecord): string {
  if (task.dueMs === undefined) return "";
  const when = task.dueDateOnly
    ? new Date(task.dueMs).toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    })
    : new Date(task.dueMs).toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  return ` — due ${when}`;
}

// ---------------------------------------------------------------------------
// icloud_status
// ---------------------------------------------------------------------------

export async function statusHandler(
  args: Record<string, unknown>,
  deps: HandlerDeps,
): Promise<HandlerResult> {
  void actionOf(args);
  if (!isConfigured(deps)) return notConfigured();
  const data: Record<string, unknown> = { configured: true };
  const lines: string[] = [`configured as ${deps.appleId}`];

  try {
    const discovery = await getDiscovery(deps);
    data.discovery = {
      principalUrl: discovery.principalUrl,
      homeUrl: discovery.homeUrl,
      collections: discovery.collections.map((c) => ({
        name: c.displayName,
        kinds: c.kinds,
      })),
    };
    if (discovery.collections.length === 0) {
      lines.push(
        "calendar home reachable but EMPTY — brand-new Apple IDs need " +
          "icloud.com signed in once with Calendar and Reminders opened, so " +
          "Apple creates the default lists; then I can retry",
      );
    } else {
      lines.push(
        `calendar home reachable — ${discovery.collections.length} collections: ` +
          discovery.collections.map((c) =>
            `"${c.displayName}" (${c.kinds.join("+")})`
          ).join(", "),
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    data.discoveryError = message;
    lines.push(`CalDAV discovery failed: ${message}`);
  }

  try {
    await checkMail({ appleId: deps.appleId, appPassword: deps.appPassword });
    data.mail = "reachable";
    lines.push("IMAP mail reachable");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    data.mailError = message;
    lines.push(`IMAP mail not reachable: ${message}`);
  }

  const glance = await readGlance(deps);
  if (glance) {
    data.lastGlanceAgeMinutes = Math.round(
      (Date.now() - glance.fetchedAtMs) / 60_000,
    );
    lines.push(`last glance refresh ${data.lastGlanceAgeMinutes} min ago`);
  }
  return { text: lines.join(" · "), data };
}

// ---------------------------------------------------------------------------
// icloud_calendar
// ---------------------------------------------------------------------------

export async function calendarHandler(
  args: Record<string, unknown>,
  deps: HandlerDeps,
): Promise<HandlerResult> {
  if (!isConfigured(deps)) return notConfigured();
  const calendar = str(args, "calendar");

  try {
    switch (actionOf(args)) {
      case "list": {
        const days = num(args, "days") ?? 7;
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        const end = new Date(start.getTime() + days * 86_400_000);
        const events = await listEvents(deps, { start, end }, calendar);
        if (events.length === 0) {
          return {
            text: `No events on my calendar${
              calendar ? ` "${calendar}"` : ""
            } in the next ${days} day(s).`,
            data: { events: [] },
          };
        }
        const lines = events.slice(0, 50).map((event) =>
          `- [${event.calendar}] ${event.title} — ${
            fmtDateTime(event.startMs, event.allDay)
          }` +
          (event.location ? ` @ ${event.location}` : "") +
          ` (uid ${event.uid})`
        );
        return {
          text: `My next ${days} day(s), ${events.length} event(s):\n${
            lines.join("\n")
          }`,
          data: { events },
        };
      }
      case "create": {
        const title = str(args, "title");
        const start = str(args, "start");
        if (!title || !start) {
          return {
            isError: true,
            text:
              'action "create" needs `title` and `start` (YYYY-MM-DD for all-day, or ISO datetime).',
          };
        }
        const uid = crypto.randomUUID() + "@psycheros";
        const ics = buildVevent({
          uid,
          title,
          start,
          end: str(args, "end"),
          location: str(args, "location"),
          notes: str(args, "notes"),
        });
        const target = await createEvent(deps, {
          uid,
          ics,
          calendarName: calendar,
        });
        void refreshGlance(deps); // keep the hook fresh; don't block the reply
        return {
          text:
            `Created "${title}" on my calendar "${target.displayName}" (uid ${uid}).`,
          data: { uid, calendar: target.displayName, title },
        };
      }
      case "delete": {
        const uid = str(args, "uid");
        if (!uid) {
          return {
            isError: true,
            text: 'action "delete" needs `uid` (from a list result).',
          };
        }
        const events = await listEvents(deps, {
          start: new Date(Date.now() - 366 * 86_400_000),
          end: new Date(Date.now() + 366 * 86_400_000),
        }, calendar);
        const found = events.find((event) => event.uid === uid);
        if (!found) {
          return {
            isError: true,
            text: `No event with uid ${uid} in the ±1 year window I searched.`,
          };
        }
        await deleteObject(deps, found.href);
        return {
          text: `Deleted "${found.title}" (uid ${uid}).`,
          data: { uid, title: found.title },
        };
      }
      default:
        return {
          isError: true,
          text:
            'Unknown action — icloud_calendar supports action: "list" | "create" | "delete".',
        };
    }
  } catch (error) {
    return errorResult(error, "calendar");
  }
}

// ---------------------------------------------------------------------------
// icloud_tasks
// ---------------------------------------------------------------------------

export async function tasksHandler(
  args: Record<string, unknown>,
  deps: HandlerDeps,
): Promise<HandlerResult> {
  if (!isConfigured(deps)) return notConfigured();
  const list = str(args, "list");

  try {
    switch (actionOf(args)) {
      case "list": {
        const includeCompleted = args["include_completed"] === true;
        const tasks = await listTasks(deps, {
          includeCompleted,
          listName: list,
        });
        if (tasks.length === 0) {
          return {
            text: `No ${includeCompleted ? "" : "open "}tasks${
              list ? ` in "${list}"` : ""
            }.`,
            data: { tasks: [] },
          };
        }
        const lines = tasks.slice(0, 50).map((task) =>
          `- ${task.completed ? "[x] " : "[ ] "}${task.title}${fmtDue(task)}` +
          (task.notes ? ` — ${task.notes.slice(0, 80)}` : "") +
          ` (uid ${task.uid}, list "${task.list}")`
        );
        return {
          text: `${tasks.length} task(s):\n${lines.join("\n")}`,
          data: { tasks },
        };
      }
      case "add": {
        const title = str(args, "title");
        if (!title) {
          return { isError: true, text: 'action "add" needs `title`.' };
        }
        const due = str(args, "due");
        if (due) {
          // Validate early so a typo'd date fails before any write happens.
          const probe = icsValueToMs(due.replace(/-/g, "").slice(0, 8), true);
          if (Number.isNaN(probe)) {
            return {
              isError: true,
              text: `Could not parse due date "${due}".`,
            };
          }
        }
        const uid = crypto.randomUUID() + "@psycheros";
        const ics = buildVtodo({ uid, title, due, notes: str(args, "notes") });
        const target = await createTask(deps, { uid, ics, listName: list });
        void refreshGlance(deps);
        return {
          text: `Added "${title}"${
            due ? ` (due ${due})` : ""
          } to my Reminders list "${target.displayName}" (uid ${uid}).`,
          data: { uid, list: target.displayName, title },
        };
      }
      case "complete":
      case "uncomplete": {
        const uid = str(args, "uid");
        if (!uid) {
          return {
            isError: true,
            text: `action "${
              actionOf(args)
            }" needs \`uid\` (from a list result).`,
          };
        }
        const task = await setTaskCompleted(
          deps,
          uid,
          actionOf(args) === "complete",
          list,
        );
        void refreshGlance(deps);
        return {
          text: `${
            actionOf(args) === "complete" ? "Completed" : "Reopened"
          } "${task.title}" (uid ${uid}).`,
          data: {
            uid,
            completed: actionOf(args) === "complete",
            title: task.title,
          },
        };
      }
      case "delete": {
        const uid = str(args, "uid");
        if (!uid) {
          return {
            isError: true,
            text: 'action "delete" needs `uid` (from a list result).',
          };
        }
        const tasks = await listTasks(deps, {
          includeCompleted: true,
          listName: list,
        });
        const found = tasks.find((task) => task.uid === uid);
        if (!found) {
          return {
            isError: true,
            text: `No task with uid ${uid} in ${
              list ? `"${list}"` : "any list"
            }.`,
          };
        }
        await deleteObject(deps, found.href);
        void refreshGlance(deps);
        return {
          text: `Deleted "${found.title}" permanently (uid ${uid}).`,
          data: { uid },
        };
      }
      default:
        return {
          isError: true,
          text:
            'Unknown action — icloud_tasks supports action: "list" | "add" | "complete" | "uncomplete" | "delete".',
        };
    }
  } catch (error) {
    return errorResult(error, "tasks");
  }
}

// ---------------------------------------------------------------------------
// icloud_mail
// ---------------------------------------------------------------------------

export async function mailHandler(
  args: Record<string, unknown>,
  deps: HandlerDeps,
): Promise<HandlerResult> {
  if (!isConfigured(deps)) return notConfigured();
  const auth = { appleId: deps.appleId, appPassword: deps.appPassword };

  try {
    switch (actionOf(args)) {
      case "list_unread": {
        const limit = Math.min(Math.max(num(args, "limit") ?? 10, 1), 25);
        const messages = await listUnread(auth, limit);
        if (messages.length === 0) {
          return {
            text: "Inbox is clear — no unread mail.",
            data: { messages: [] },
          };
        }
        const lines = messages.map((message) =>
          `- [uid ${message.uid}] ${message.from}: "${message.subject}"` +
          (message.date ? ` (${new Date(message.date).toLocaleString()})` : "")
        );
        return {
          text: `${messages.length} unread message(s):\n${lines.join("\n")}`,
          data: { messages },
        };
      }
      case "read": {
        const uid = num(args, "uid");
        if (uid === undefined) {
          return {
            isError: true,
            text: 'action "read" needs `uid` (from list_unread).',
          };
        }
        const message = await readMessage(auth, uid);
        return {
          text: `From ${message.from} — "${message.subject}"\n` +
            (message.date
              ? `Received ${new Date(message.date).toLocaleString()}\n`
              : "") +
            `\n${message.body}`,
          data: message,
        };
      }
      default:
        return {
          isError: true,
          text:
            'Unknown action — icloud_mail supports action: "list_unread" | "read". (Sending mail is intentionally not available yet — it waits for an approval gate.)',
        };
    }
  } catch (error) {
    return errorResult(error, "mail");
  }
}

/** Force re-discovery on the next call — for icloud_status action="rediscover". */
export function rediscover(): void {
  invalidateDiscovery();
}
