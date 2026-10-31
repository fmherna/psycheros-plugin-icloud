/**
 * My CalDAV client for iCloud (caldav.icloud.com).
 *
 * Auth is HTTP Basic with an app-specific password — Apple's only supported
 * path for third-party access to a personal calendar, and one that never
 * expires on a weekly timer. Discovery (current-user-principal →
 * calendar-home-set → collections) is cached per process and reused for
 * every call; requests that hit server-side throttling (429/503) are
 * retried with honored Retry-After or jittered backoff, because repeated
 * failures can temporarily lock the Apple ID and I don't want that.
 */

import {
  icsValueToMs,
  parseComponent,
  type ParsedComponent,
  unfoldIcs,
} from "./ics.ts";

export const CALDAV_HOST = "https://caldav.icloud.com";

export interface CalDAVCollection {
  /** Full URL of the calendar collection. */
  href: string;
  displayName: string;
  kinds: ("VEVENT" | "VTODO")[];
  color?: string;
}

export interface CalDAVObject {
  /** Full URL of the individual resource (.ics). */
  href: string;
  etag: string;
  uid?: string;
  component: ParsedComponent;
  /** Raw ICS body (unfolded on demand by callers via lib/ics helpers). */
  ics: string;
}

export interface CalDAVDeps {
  /** Apple ID (typically the @icloud.com address). */
  appleId: string;
  /** App-specific password generated at account.apple.com. */
  appPassword: string;
  log?: (...args: unknown[]) => void;
}

export class CalDAVError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "CalDAVError";
  }
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function authHeader(deps: CalDAVDeps): string {
  const creds = btoa(`${deps.appleId}:${deps.appPassword}`);
  return `Basic ${creds}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One authenticated request with timeout + retry on transient status codes.
 * 4xx other than 429 fail immediately — retrying a 401 just burns login
 * attempts toward an account lock.
 */
async function davRequest(
  deps: CalDAVDeps,
  method: string,
  url: string,
  body?: string,
  extraHeaders: Record<string, string> = {},
  depth?: number,
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: authHeader(deps),
    ...extraHeaders,
  };
  if (depth !== undefined) headers["Depth"] = String(depth);
  if (body !== undefined) {
    headers["Content-Type"] = "application/xml; charset=utf-8";
  }

  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= 2; attempt++) {
    if (attempt > 0) {
      const base = 800 * 2 ** (attempt - 1);
      await sleep(base + Math.floor(Math.random() * 400));
    }
    try {
      const response = await fetch(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(20_000),
        redirect: "follow",
      });
      if (response.status === 429 || response.status === 503) {
        const retryAfter = Number(response.headers.get("Retry-After"));
        if (attempt < 2) {
          await sleep(
            Number.isFinite(retryAfter) && retryAfter > 0
              ? retryAfter * 1000
              : 2_000,
          );
          continue;
        }
      }
      return response;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError ?? new Error("request failed after retries");
}

function assertStatus(response: Response, expected: number[], what: string) {
  if (!expected.includes(response.status)) {
    throw new CalDAVError(
      `${what} failed: HTTP ${response.status} ${response.statusText}`,
      response.status,
    );
  }
}

// ---------------------------------------------------------------------------
// XML response parsing (prefix-tolerant — Apple's prefixes vary)
// ---------------------------------------------------------------------------

function decodeXmlEntities(text: string): string {
  return text
    .replace(
      /&#x([0-9a-fA-F]+);/g,
      (_, hex) => String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(+dec))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

const LOCAL = (tag: string) =>
  new RegExp(
    `<(?:[A-Za-z0-9]+:)?${tag}(\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9]+:)?${tag}>`,
    "g",
  );

function firstElement(xml: string, tag: string): string | undefined {
  const match = LOCAL(tag).exec(xml);
  return match ? decodeXmlEntities(match[2]!) : undefined;
}

/**
 * First `<href>` inside an XML fragment. Apple writes DAV elements with
 * default namespaces and attributes (`<href xmlns="DAV:">`), so the tag
 * name alone isn't enough — attributes must be tolerated. Callers pass a
 * *fragment* (a prop or response block), never a whole document, so "first"
 * is unambiguous.
 */
function firstHref(fragment: string): string | undefined {
  const match = /<(?:[A-Za-z0-9]+:)?href(?:\s[^>]*)?>([^<]+)</.exec(fragment);
  return match ? decodeXmlEntities(match[1]!.trim()) : undefined;
}

/** Strip XML comments and CDATA wrappers, normalize entity-decoded iCal text. */
function icsFromCalendarData(raw: string): string {
  let text = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  text = decodeXmlEntities(text);
  return text.replace(/^\s+/, "");
}

// ---------------------------------------------------------------------------
// Discovery (cached per process — Apple rate-limits discovery chains)
// ---------------------------------------------------------------------------

export interface CalDAVDiscovery {
  principalUrl: string;
  homeUrl: string;
  collections: CalDAVCollection[];
  discoveredAt: number;
}

let cachedDiscovery: CalDAVDiscovery | undefined;
let inFlightDiscovery: Promise<CalDAVDiscovery> | undefined;
const DISCOVERY_TTL_MS = 6 * 60 * 60 * 1000;

export function invalidateDiscovery(): void {
  cachedDiscovery = undefined;
  inFlightDiscovery = undefined;
}

async function discover(deps: CalDAVDeps): Promise<CalDAVDiscovery> {
  if (inFlightDiscovery) return inFlightDiscovery;
  inFlightDiscovery = listCollections(deps);
  try {
    return await inFlightDiscovery;
  } finally {
    inFlightDiscovery = undefined;
  }
}

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

/** All calendar collections in my home, split by what they hold. */
export async function listCollections(
  deps: CalDAVDeps,
): Promise<CalDAVDiscovery> {
  const propfindHome = `<?xml version="1.0" encoding="utf-8"?>` +
    `<d:propfind xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">` +
    `<d:prop><d:resourcetype/><d:displayname/><cal:supported-calendar-component-set/>` +
    `<x:calendar-color xmlns:x="http://apple.com/ns/ical/"/></d:prop></d:propfind>`;

  const principalRes = await davRequest(
    deps,
    "PROPFIND",
    CALDAV_HOST + "/",
    `<?xml version="1.0" encoding="utf-8"?>` +
      `<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`,
    {},
    0,
  );
  assertStatus(principalRes, [207], "current-user-principal");
  const principalXml = await principalRes.text();
  const cupBlock = firstElement(principalXml, "current-user-principal") ?? "";
  // Search only inside the current-user-principal property — a whole-document
  // search would grab the response's own href ("/") and send discovery to a
  // URL that can never hold a calendar home.
  const principalHref = firstHref(cupBlock);
  if (!principalHref) {
    throw new CalDAVError("could not find current-user-principal");
  }
  const principalUrl = new URL(principalHref, CALDAV_HOST + "/").href;

  const homeRes = await davRequest(
    deps,
    "PROPFIND",
    principalUrl,
    `<?xml version="1.0" encoding="utf-8"?>` +
      `<d:propfind xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">` +
      `<d:prop><cal:calendar-home-set/></d:prop></d:propfind>`,
    {},
    0,
  );
  assertStatus(homeRes, [207], "calendar-home-set");
  const homeXml = await homeRes.text();
  const homeBlock = firstElement(homeXml, "calendar-home-set") ?? "";
  const homeHref = firstHref(homeBlock);
  if (!homeHref) throw new CalDAVError("could not find calendar-home-set");
  const homeUrl = new URL(homeHref, CALDAV_HOST + "/").href;

  const collectionsRes = await davRequest(
    deps,
    "PROPFIND",
    homeUrl,
    propfindHome,
    {},
    1,
  );
  assertStatus(collectionsRes, [207], "collection listing");
  const collections = parseMultistatusCollections(await collectionsRes.text());

  const discovery: CalDAVDiscovery = {
    principalUrl,
    homeUrl,
    collections,
    discoveredAt: Date.now(),
  };
  cachedDiscovery = discovery;
  return discovery;
}

/** Cached discovery (shared by every tool call; refetched when expired). */
export function getDiscovery(deps: CalDAVDeps): Promise<CalDAVDiscovery> {
  if (
    cachedDiscovery &&
    Date.now() - cachedDiscovery.discoveredAt < DISCOVERY_TTL_MS
  ) {
    return Promise.resolve(cachedDiscovery);
  }
  return discover(deps);
}

function parseMultistatusCollections(xml: string): CalDAVCollection[] {
  const collections: CalDAVCollection[] = [];
  const responseSplit =
    /<(?:[A-Za-z0-9]+:)?response>([\s\S]*?)<\/(?:[A-Za-z0-9]+:)?response>/g;
  for (const match of xml.matchAll(responseSplit)) {
    const body = match[1]!;
    const href = firstHref(body);
    if (!href) continue;
    const resourceType = firstElement(body, "resourcetype") ?? "";
    if (!/<(?:[A-Za-z0-9]+:)?calendar[\s/>]/.test(resourceType)) continue;

    const displayName = firstElement(body, "displayname") ??
      decodeURIComponent(href.split("/").filter(Boolean).pop() ?? "calendar");
    const compSet = firstElement(body, "supported-calendar-component-set") ??
      "";
    const kinds: CalDAVCollection["kinds"] = [];
    for (const comp of compSet.matchAll(/comp\s+name="(VEVENT|VTODO)"/g)) {
      kinds.push(comp[1] as "VEVENT" | "VTODO");
    }
    if (kinds.length === 0) kinds.push("VEVENT", "VTODO");
    const color = firstElement(body, "calendar-color")?.trim();
    collections.push({
      href: new URL(href, CALDAV_HOST + "/").href,
      displayName,
      kinds,
      color: color && color.startsWith("#") ? color.slice(0, 7) : undefined,
    });
  }
  return collections;
}

function pickCollection(
  discovery: CalDAVDiscovery,
  kind: "VEVENT" | "VTODO",
  name?: string,
): CalDAVCollection {
  const matching = discovery.collections.filter((c) => c.kinds.includes(kind));
  if (matching.length === 0) {
    const emptyHomeHint = discovery.collections.length === 0
      ? " — my calendar home is empty, which happens with a brand-new Apple " +
        "ID: sign in at icloud.com once and open both Calendar and Reminders " +
        "so Apple provisions the default lists, then try again"
      : "";
    throw new CalDAVError(
      (kind === "VTODO"
        ? "no Reminders (task) list found in my iCloud calendar home"
        : "no calendar found in my iCloud calendar home") + emptyHomeHint,
    );
  }
  if (!name) return matching[0]!;
  const found = matching.find(
    (c) => c.displayName.trim().toLowerCase() === name.trim().toLowerCase(),
  );
  if (!found) {
    throw new CalDAVError(
      `no ${
        kind === "VTODO" ? "Reminders list" : "calendar"
      } named "${name}" — ` +
        `available: ${matching.map((c) => c.displayName).join(", ")}`,
    );
  }
  return found;
}

function icsContentType(): Record<string, string> {
  return { "Content-Type": "text/calendar; charset=utf-8" };
}

/** REPORT calendar-query with a time range (events) or no range (all VTODOs). */
async function queryCollection(
  deps: CalDAVDeps,
  collection: CalDAVCollection,
  component: "VEVENT" | "VTODO",
  range?: { start: Date; end: Date },
): Promise<CalDAVObject[]> {
  const fmt = (d: Date) => toCompactUtc(d);
  const rangeXml = range
    ? `<C:time-range start="${fmt(range.start)}" end="${fmt(range.end)}"/>`
    : "";
  const body = `<?xml version="1.0" encoding="utf-8"?>` +
    `<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">` +
    `<D:prop><D:getetag/><C:calendar-data/></D:prop>` +
    `<C:filter><C:comp-filter name="VCALENDAR">` +
    `<C:comp-filter name="${component}">${rangeXml}</C:comp-filter>` +
    `</C:comp-filter></C:filter></C:calendar-query>`;

  const response = await davRequest(
    deps,
    "REPORT",
    collection.href,
    body,
    {},
    1,
  );
  assertStatus(response, [207], `${component} query`);
  return parseMultistatusObjects(await response.text());
}

async function queryByUid(
  deps: CalDAVDeps,
  collection: CalDAVCollection,
  uid: string,
): Promise<CalDAVObject | undefined> {
  const body = `<?xml version="1.0" encoding="utf-8"?>` +
    `<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">` +
    `<D:prop><D:getetag/><C:calendar-data/></D:prop>` +
    `<C:filter><C:comp-filter name="VCALENDAR">` +
    `<C:comp-filter name="VTODO">` +
    `<C:prop-filter name="UID"><C:text-match collation="exact">${uid}</C:text-match></C:prop-filter>` +
    `</C:comp-filter></C:comp-filter></C:filter></C:calendar-query>`;

  const response = await davRequest(
    deps,
    "REPORT",
    collection.href,
    body,
    {},
    1,
  );
  assertStatus(response, [207], "UID lookup");
  return parseMultistatusObjects(await response.text())[0];
}

function toCompactUtc(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${
      pad(d.getUTCSeconds())
    }Z`
  );
}

function parseMultistatusObjects(xml: string): CalDAVObject[] {
  const objects: CalDAVObject[] = [];
  for (
    const match of xml.matchAll(
      /<(?:[A-Za-z0-9]+:)?response>([\s\S]*?)<\/(?:[A-Za-z0-9]+:)?response>/g,
    )
  ) {
    const body = match[1]!;
    const href = firstHref(body);
    const etagMatch = /<(?:[A-Za-z0-9]+:)?getetag[^>]*>([^<]*)</.exec(body);
    const dataMatch =
      /<(?:[A-Za-z0-9]+:)?calendar-data[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9]+:)?calendar-data>/
        .exec(
          body,
        );
    if (!href || !dataMatch) continue;
    const ics = icsFromCalendarData(dataMatch[1]!);
    const component = parseComponent(ics);
    if (!component) continue;
    objects.push({
      href: new URL(href, CALDAV_HOST + "/").href,
      etag: (etagMatch?.[1] ?? "").trim().replace(/^"|"$/g, ""),
      uid: component.uid,
      component,
      ics,
    });
  }
  return objects;
}

export interface EventRecord {
  uid: string;
  href: string;
  calendar: string;
  title: string;
  startMs: number;
  endMs: number;
  allDay: boolean;
  location?: string;
  notes?: string;
}

/** Events across all my calendars inside a window (start inclusive). */
export async function listEvents(
  deps: CalDAVDeps,
  range: { start: Date; end: Date },
  calendarName?: string,
): Promise<EventRecord[]> {
  const discovery = await getDiscovery(deps);
  const calendars = calendarName
    ? [pickCollection(discovery, "VEVENT", calendarName)]
    : discovery.collections.filter((c) => c.kinds.includes("VEVENT"));

  const events: EventRecord[] = [];
  for (const calendar of calendars) {
    const objects = await queryCollection(deps, calendar, "VEVENT", range);
    for (const object of objects) {
      const component = object.component;
      if (!component.dtstart) continue;
      const startMs = icsValueToMs(
        component.dtstart.value,
        component.dtstart.dateOnly,
      );
      const endMs = component.dtend
        ? icsValueToMs(component.dtend.value, component.dtend.dateOnly)
        : startMs + (component.dtstart.dateOnly ? 86_400_000 : 0);
      events.push({
        uid: object.uid ?? "",
        href: object.href,
        calendar: calendar.displayName,
        title: component.summary ?? "(untitled)",
        startMs,
        endMs,
        allDay: component.dtstart.dateOnly,
        location: component.location,
        notes: component.description,
      });
    }
  }
  events.sort((a, b) => a.startMs - b.startMs);
  return events;
}

export interface TaskRecord {
  uid: string;
  href: string;
  list: string;
  title: string;
  notes?: string;
  dueMs?: number;
  dueDateOnly?: boolean;
  completed: boolean;
  etag: string;
}

/** Tasks across my Reminders lists, optionally including completed ones. */
export async function listTasks(
  deps: CalDAVDeps,
  opts: { includeCompleted?: boolean; listName?: string } = {},
): Promise<TaskRecord[]> {
  const discovery = await getDiscovery(deps);
  const lists = opts.listName
    ? [pickCollection(discovery, "VTODO", opts.listName)]
    : discovery.collections.filter((c) => c.kinds.includes("VTODO"));

  const tasks: TaskRecord[] = [];
  for (const list of lists) {
    const objects = await queryCollection(deps, list, "VTODO");
    for (const object of objects) {
      const component = object.component;
      const completed = component.status?.toUpperCase() === "COMPLETED";
      if (completed && !opts.includeCompleted) continue;
      tasks.push({
        uid: object.uid ?? "",
        href: object.href,
        list: list.displayName,
        title: component.summary ?? "(untitled)",
        notes: component.description,
        dueMs: component.due
          ? icsValueToMs(component.due.value, component.due.dateOnly)
          : undefined,
        dueDateOnly: component.due?.dateOnly,
        completed,
        etag: object.etag,
      });
    }
  }
  tasks.sort((a, b) => {
    if (a.dueMs === undefined && b.dueMs === undefined) return 0;
    if (a.dueMs === undefined) return 1;
    if (b.dueMs === undefined) return -1;
    return a.dueMs - b.dueMs;
  });
  return tasks;
}

export async function createEvent(
  deps: CalDAVDeps,
  opts: {
    uid: string;
    ics: string;
    calendarName?: string;
  },
): Promise<CalDAVCollection> {
  const discovery = await getDiscovery(deps);
  const calendar = pickCollection(discovery, "VEVENT", opts.calendarName);
  const url = joinObjectUrl(calendar.href, opts.uid);
  const response = await davRequest(
    deps,
    "PUT",
    url,
    opts.ics,
    { ...icsContentType(), "If-None-Match": "*" },
  );
  assertStatus(response, [201, 204], "event creation");
  return calendar;
}

export async function createTask(
  deps: CalDAVDeps,
  opts: { uid: string; ics: string; listName?: string },
): Promise<CalDAVCollection> {
  const discovery = await getDiscovery(deps);
  const list = pickCollection(discovery, "VTODO", opts.listName);
  const url = joinObjectUrl(list.href, opts.uid);
  const response = await davRequest(
    deps,
    "PUT",
    url,
    opts.ics,
    { ...icsContentType(), "If-None-Match": "*" },
  );
  assertStatus(response, [201, 204], "task creation");
  return list;
}

/**
 * Flip a VTODO's completed state. GET → transform → PUT with If-Match so a
 * concurrent edit from the Reminders app can never be clobbered silently
 * (a stale ETag comes back as 412 and I surface that as a retryable error).
 */
export async function setTaskCompleted(
  deps: CalDAVDeps,
  uid: string,
  completed: boolean,
  listName?: string,
): Promise<TaskRecord> {
  const discovery = await getDiscovery(deps);
  const lists = listName
    ? [pickCollection(discovery, "VTODO", listName)]
    : discovery.collections.filter((c) => c.kinds.includes("VTODO"));

  for (const list of lists) {
    const object = await queryByUid(deps, list, uid);
    if (!object) continue;
    const updated = setCompletedInIcs(object.ics, completed);
    const response = await davRequest(
      deps,
      "PUT",
      object.href,
      updated,
      {
        ...icsContentType(),
        "If-Match": `"${object.etag}"`,
      },
    );
    assertStatus(response, [204, 200], "task update");
    return {
      uid,
      href: object.href,
      list: list.displayName,
      title: object.component.summary ?? "(untitled)",
      notes: object.component.description,
      dueMs: object.component.due
        ? icsValueToMs(
          object.component.due.value,
          object.component.due.dateOnly,
        )
        : undefined,
      dueDateOnly: object.component.due?.dateOnly,
      completed,
      etag: object.etag,
    };
  }
  throw new CalDAVError(`no task with UID ${uid} found in any Reminders list`);
}

export async function deleteObject(
  deps: CalDAVDeps,
  href: string,
): Promise<void> {
  const response = await davRequest(deps, "DELETE", href);
  assertStatus(response, [204, 200, 404], "delete");
}

function setCompletedInIcs(ics: string, completed: boolean): string {
  const lines = unfoldIcs(ics);
  const now = toCompactUtc(new Date());
  const out: string[] = [];
  let inVtodo = false;
  let statusWritten = false;
  let completedWritten = false;
  for (const line of lines) {
    const upper = line.toUpperCase();
    if (upper === "BEGIN:VTODO") inVtodo = true;
    if (upper === "END:VTODO") {
      if (inVtodo) {
        if (!statusWritten) {
          out.push(completed ? "STATUS:COMPLETED" : "STATUS:NEEDS-ACTION");
        }
        if (completed && !completedWritten) out.push(`COMPLETED:${now}`);
      }
      inVtodo = false;
      statusWritten = false;
      completedWritten = false;
      out.push(line);
      continue;
    }
    if (inVtodo && upper.startsWith("STATUS:")) {
      out.push(completed ? "STATUS:COMPLETED" : "STATUS:NEEDS-ACTION");
      statusWritten = true;
      continue;
    }
    if (inVtodo && upper.startsWith("COMPLETED:")) {
      if (completed) {
        out.push(`COMPLETED:${now}`);
        completedWritten = true;
      }
      continue;
    }
    out.push(line);
  }
  return out.join("\r\n") + "\r\n";
}

function joinObjectUrl(collectionHref: string, uid: string): string {
  const base = collectionHref.endsWith("/")
    ? collectionHref
    : collectionHref + "/";
  const safeUid = uid.replace(/[^\w.@-]/g, "_");
  return base + safeUid + ".ics";
}
