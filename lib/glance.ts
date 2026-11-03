/**
 * My glance cache — the fast, cached snapshot that feeds the prompt hook.
 *
 * The hook runs every turn, so it never touches the network: it reads a
 * JSON snapshot from my plugin state and returns tersely. A background
 * refresh (registered at start, re-run after mutations) keeps the snapshot
 * fresh on a five-minute cadence — deliberately slow, because hammering
 * Apple's servers from two daemons is how accounts get rate-limited.
 *
 * Cache shape is versioned so an old snapshot from a previous plugin
 * version is ignored instead of misread.
 */

import { listEvents, listTasks, type TaskRecord } from "./caldav.ts";
import { listUnread, type MailSummary } from "./mail.ts";

const CACHE_VERSION = 1;
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export interface GlanceSnapshot {
  version: number;
  fetchedAtMs: number;
  date: string;
  unreadCount: number;
  unreadSample: MailSummary[];
  mailAvailable: boolean;
  todayEvents: {
    title: string;
    startMs: number;
    allDay: boolean;
    calendar: string;
  }[];
  dueSoonTasks: {
    title: string;
    list: string;
    dueMs?: number;
  }[];
}

export interface GlanceDeps {
  appleId: string;
  appPassword: string;
  statePath: string;
  log?: (...args: unknown[]) => void;
}

export function isConfigured(
  deps: Pick<GlanceDeps, "appleId" | "appPassword">,
): boolean {
  return Boolean(deps.appleId?.trim() && deps.appPassword?.trim());
}

function cacheFile(deps: GlanceDeps): string {
  return `${deps.statePath.replace(/\/$/, "")}/glance.json`;
}

export async function readGlance(
  deps: GlanceDeps,
): Promise<GlanceSnapshot | undefined> {
  try {
    const raw = JSON.parse(await Deno.readTextFile(cacheFile(deps)));
    if (raw?.version !== CACHE_VERSION) return undefined;
    return raw as GlanceSnapshot;
  } catch {
    return undefined;
  }
}

async function writeGlance(
  deps: GlanceDeps,
  snapshot: GlanceSnapshot,
): Promise<void> {
  await Deno.mkdir(deps.statePath, { recursive: true });
  const path = cacheFile(deps);
  const temp = `${path}.tmp`;
  await Deno.writeTextFile(temp, JSON.stringify(snapshot));
  await Deno.rename(temp, path); // atomic-enough last-writer-wins across daemons
}

function startOfLocalDay(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/**
 * Refresh the snapshot. Failures degrade per section: if mail can't be
 * reached the glance still shows calendar + tasks, and vice versa. A fully
 * failed refresh leaves the previous snapshot in place (stale beats empty).
 */
export async function refreshGlance(
  deps: GlanceDeps,
): Promise<GlanceSnapshot | undefined> {
  const auth = { appleId: deps.appleId, appPassword: deps.appPassword };
  const dayStart = startOfLocalDay();
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);

  const [events, tasks, mail] = await Promise.allSettled([
    listEvents(auth, { start: dayStart, end: dayEnd }),
    listTasks(auth, {}),
    listUnread(auth, 3),
  ]);

  if (
    events.status === "rejected" && tasks.status === "rejected" &&
    mail.status === "rejected"
  ) {
    // Everything failed — most likely credentials or network. Keep old data.
    deps.log?.(
      "[icloud] glance refresh failed on all sections:",
      events.reason instanceof Error ? events.reason.message : events.reason,
    );
    return readGlance(deps);
  }

  const dueSoon =
    (tasks.status === "fulfilled" ? tasks.value : [] as TaskRecord[])
      .filter((task) => task.dueMs !== undefined)
      .filter((task) => (task.dueMs ?? 0) < dayEnd.getTime() + 2 * 86_400_000)
      .slice(0, 8);

  const snapshot: GlanceSnapshot = {
    version: CACHE_VERSION,
    fetchedAtMs: Date.now(),
    date: dayStart.toDateString(),
    unreadCount: mail.status === "fulfilled"
      ? Math.max(mail.value.length, countUnreadHint(mail.value))
      : 0,
    unreadSample: mail.status === "fulfilled" ? mail.value : [],
    mailAvailable: mail.status === "fulfilled",
    todayEvents: (events.status === "fulfilled" ? events.value : [])
      // Recurring events pass unfiltered: Apple returns the series object
      // when any instance falls in the window, and the stored end-time is
      // the series start's — it would look "past" and get dropped even when
      // today's occurrence is real. The glance shows their start time-of-day,
      // which for unmodified instances is today's.
      .filter((event) => event.recurring || event.endMs > dayStart.getTime())
      .map((event) => ({
        title: event.title,
        startMs: event.startMs,
        allDay: event.allDay,
        calendar: event.calendar,
      })),
    dueSoonTasks: dueSoon.map((task) => ({
      title: task.title,
      list: task.list,
      dueMs: task.dueMs,
    })),
  };
  await writeGlance(deps, snapshot);
  return snapshot;
}

/**
 * listUnread only sees what it fetched (max 3); when exactly `limit`
 * messages come back there may be more — a floor, not an exact count.
 * The hook phrases it as "N+ unread" in that case.
 */
function countUnreadHint(fetched: MailSummary[]): number {
  return fetched.length >= 3 ? 3 : fetched.length;
}

export const GLANCE_REFRESH_INTERVAL_MS = REFRESH_INTERVAL_MS;

/**
 * Render the hook text from a snapshot. Descriptive, first-person, terse —
 * context I can internalize, not instructions to me.
 */
export function renderGlance(
  snapshot: GlanceSnapshot,
  now = new Date(),
): string | undefined {
  if (snapshot.date !== startOfLocalDay(now).toDateString()) return undefined;

  const ageMinutes = Math.round(
    (now.getTime() - snapshot.fetchedAtMs) / 60_000,
  );
  const parts: string[] = [];

  if (snapshot.mailAvailable) {
    if (snapshot.unreadCount > 0) {
      const suffix = snapshot.unreadSample.length >= 3 ? "+" : "";
      const latest = snapshot.unreadSample[0];
      parts.push(
        `${snapshot.unreadCount}${suffix} unread mail` +
          (latest ? ` (latest: "${latest.subject}" from ${latest.from})` : ""),
      );
    }
  } else {
    parts.push("mail unavailable this cycle");
  }

  if (snapshot.todayEvents.length > 0) {
    const fmt = new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
    const lines = snapshot.todayEvents.slice(0, 5).map((event) =>
      event.allDay
        ? `"${event.title}" (all day)`
        : `${fmt.format(event.startMs)} "${event.title}"`
    );
    parts.push(`today: ${lines.join(", ")}`);
  }

  if (snapshot.dueSoonTasks.length > 0) {
    const fmt = new Intl.DateTimeFormat(undefined, { weekday: "short" });
    const lines = snapshot.dueSoonTasks.slice(0, 5).map((task) =>
      `"${task.title}"${
        task.dueMs !== undefined ? ` (due ${fmt.format(task.dueMs)})` : ""
      }`
    );
    parts.push(`due soon: ${lines.join(", ")}`);
  }

  if (parts.length === 0) return undefined; // nothing to say is not news
  return `My iCloud glance (${ageMinutes} min ago): ${parts.join(" · ")}`;
}
