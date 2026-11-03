/**
 * iCalendar building and minimal parsing for my iCloud objects.
 *
 * I only emit the subset of RFC 5545 that my life actually needs: plain
 * VEVENTs (timed or all-day) and VTODOs with an optional due date. No
 * recurrence rules, no alarms — Apple's servers and apps are happy with
 * simple components, and simple components never surprise me.
 *
 * Line endings in ICS bodies are CRLF per spec; long lines are folded at 75
 * octets so servers don't reject them.
 */

/** Properties I parse back out of fetched components. */
export interface ParsedComponent {
  uid?: string;
  summary?: string;
  description?: string;
  location?: string;
  /** Raw DTSTART/DUE value plus whether it was date-only. */
  dtstart?: IcsDateValue;
  dtend?: IcsDateValue;
  due?: IcsDateValue;
  /** For recurrence overrides: which original instance this replaces. */
  recurrenceId?: IcsDateValue;
  /** Present when the component carries an RRULE (it recurs). */
  hasRrule?: boolean;
  status?: string;
  completed?: string;
  /** Everything else I don't interpret but must preserve on rewrite. */
  rest: string[];
}

/** An ICS date or date-time value with the parameters that shape it. */
export interface IcsDateValue {
  value: string;
  dateOnly: boolean;
  /** IANA timezone the wall-clock time is expressed in (TZID param). */
  tzid?: string;
}

const PRODID = "-//Psycheros//icloud plugin//EN";

/** Escape text per RFC 5545 §3.3.11 (backslash, semicolon, comma, newline). */
export function escapeIcsText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** Undo RFC 5545 text escaping. */
export function unescapeIcsText(text: string): string {
  return text.replace(/\\n/gi, "\n").replace(/\\([\\;,])/g, "$1");
}

/**
 * Fold a content line to the 75-octet limit with CRLF + space continuations.
 * I count UTF-16 characters as a practical octet approximation for the
 * mostly-ASCII property lines I write, and I never split a surrogate pair —
 * unfolding restores the exact original bytes either way.
 */
export function foldLine(line: string): string {
  const LIMIT = 75;
  if (line.length <= LIMIT) return line;
  const parts: string[] = [];
  let remaining = line;
  let first = true;
  while (remaining.length > 0) {
    const budget = first ? LIMIT : LIMIT - 1;
    let cut = Math.min(budget, remaining.length);
    // Don't strand a low surrogate at the end of a chunk.
    if (
      cut < remaining.length &&
      cut > 0 &&
      remaining.charCodeAt(cut - 1) >= 0xd800 &&
      remaining.charCodeAt(cut - 1) <= 0xdbff
    ) {
      cut -= 1;
    }
    if (cut <= 0) cut = 1;
    parts.push(first ? remaining.slice(0, cut) : " " + remaining.slice(0, cut));
    remaining = remaining.slice(cut);
    first = false;
  }
  return parts.join("\r\n");
}

function propLine(name: string, params: string, value: string): string {
  return foldLine(`${name}${params}:${value}`);
}

function stampNow(): string {
  return toIcsDateTimeUtc(new Date());
}

/** Format a Date as an ICS UTC datetime, e.g. `20261104T133000Z`. */
export function toIcsDateTimeUtc(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${
      pad(date.getUTCDate())
    }` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${
      pad(date.getUTCSeconds())
    }Z`
  );
}

/** Format a Date as an ICS date-only value, e.g. `20261104`. */
export function toIcsDateOnly(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${
      pad(date.getUTCDate())
    }`
  );
}

/**
 * Build a full VCALENDAR wrapping one VEVENT. `start`/`end` accept ISO
 * datetime strings (converted to UTC) or plain `YYYY-MM-DD` for all-day.
 * When `end` is omitted: one hour after a timed start, next day for all-day.
 */
export function buildVevent(opts: {
  uid: string;
  title: string;
  start: string;
  end?: string;
  location?: string;
  notes?: string;
}): string {
  const startInfo = normalizeDateInput(opts.start);
  let endInfo = opts.end ? normalizeDateInput(opts.end) : startInfo.dateOnly
    ? {
      value: toIcsDateOnly(new Date(startInfo.ms + 86_400_000)),
      dateOnly: true,
    }
    : {
      value: toIcsDateTimeUtc(new Date(startInfo.ms + 3_600_000)),
      dateOnly: false,
    };
  if (!opts.end && !startInfo.dateOnly && endInfo.dateOnly) {
    endInfo = {
      value: toIcsDateTimeUtc(new Date(startInfo.ms + 3_600_000)),
      dateOnly: false,
    };
  }

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${PRODID}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${opts.uid}`,
    `DTSTAMP:${stampNow()}`,
    startInfo.dateOnly
      ? `DTSTART;VALUE=DATE:${startInfo.value}`
      : `DTSTART:${startInfo.value}`,
    endInfo.dateOnly
      ? `DTEND;VALUE=DATE:${endInfo.value}`
      : `DTEND:${endInfo.value}`,
    propLine("SUMMARY", "", escapeIcsText(opts.title)),
  ];
  if (opts.location) {
    lines.push(propLine("LOCATION", "", escapeIcsText(opts.location)));
  }
  if (opts.notes) {
    lines.push(propLine("DESCRIPTION", "", escapeIcsText(opts.notes)));
  }
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

/**
 * Build a full VCALENDAR wrapping one VTODO. `due` accepts `YYYY-MM-DD`
 * (date-only — shows as "scheduled" in Reminders with no time-of-day nag)
 * or a full ISO datetime.
 */
export function buildVtodo(opts: {
  uid: string;
  title: string;
  due?: string;
  notes?: string;
}): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${PRODID}`,
    "CALSCALE:GREGORIAN",
    "BEGIN:VTODO",
    `UID:${opts.uid}`,
    `DTSTAMP:${stampNow()}`,
    "STATUS:NEEDS-ACTION",
    propLine("SUMMARY", "", escapeIcsText(opts.title)),
  ];
  if (opts.notes) {
    lines.push(propLine("DESCRIPTION", "", escapeIcsText(opts.notes)));
  }
  if (opts.due) {
    const due = normalizeDateInput(opts.due);
    lines.push(
      due.dateOnly ? `DUE;VALUE=DATE:${due.value}` : `DUE:${due.value}`,
    );
  }
  lines.push("END:VTODO", "END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

/**
 * Rewrite an existing VTODO in place between completed and not-completed.
 * I transform the original body at the string level (not rebuild it) so
 * properties I don't interpret — alarms, related-to links, anything Apple
 * adds — survive untouched.
 */
export function setVtodoCompleted(ics: string, completed: boolean): string {
  const now = stampNow();
  let out = ics.replace(
    /^STATUS:.*$/m,
    completed ? "STATUS:COMPLETED" : "STATUS:NEEDS-ACTION",
  );
  if (!/^STATUS:/m.test(out)) {
    out = out.replace(
      /^END:VTODO/m,
      `STATUS:${completed ? "COMPLETED" : "NEEDS-ACTION"}\r\nEND:VTODO`,
    );
  }
  if (completed) {
    if (!/^COMPLETED:/m.test(out)) {
      out = out.replace(/^END:VTODO/m, `COMPLETED:${now}\r\nEND:VTODO`);
    }
  } else {
    out = out.replace(/^COMPLETED:.*\r?\n/m, "");
  }
  return out;
}

/**
 * Unfold an ICS body (CRLF + space/tab continuations) into logical lines.
 */
export function unfoldIcs(ics: string): string[] {
  const unfolded = ics.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "");
  return unfolded.split(/\r?\n/).filter((line) => line.length > 0);
}

function findComponent(lines: string[], name: string): string[] | undefined {
  const open = `BEGIN:${name}`;
  const close = `END:${name}`;
  const start = lines.findIndex((line) => line.toUpperCase() === open);
  if (start === -1) return undefined;
  const end = lines.findIndex(
    (line, index) => index > start && line.toUpperCase() === close,
  );
  if (end === -1) return undefined;
  return lines.slice(start + 1, end);
}

/** Parse the first VEVENT or (fallback) VTODO in an ICS body. */
export function parseComponent(ics: string): ParsedComponent | undefined {
  const lines = unfoldIcs(ics);
  const body = findComponent(lines, "VEVENT") ?? findComponent(lines, "VTODO");
  if (!body) return undefined;

  const parsed: ParsedComponent = { rest: [] };
  for (const line of body) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const head = line.slice(0, colon);
    const value = line.slice(colon + 1);
    const semi = head.indexOf(";");
    const name = (semi === -1 ? head : head.slice(0, semi)).toUpperCase();
    const params = semi === -1 ? "" : head.slice(semi);
    const dateOnly = /VALUE=DATE(?!TIME)/i.test(params);
    const tzid = /TZID=([^;:]+)/i.exec(params)?.[1]?.replace(/^"|"$/g, "");
    switch (name) {
      case "UID":
        parsed.uid = value;
        break;
      case "SUMMARY":
        parsed.summary = unescapeIcsText(value);
        break;
      case "DESCRIPTION":
        parsed.description = unescapeIcsText(value);
        break;
      case "LOCATION":
        parsed.location = unescapeIcsText(value);
        break;
      case "DTSTART":
        parsed.dtstart = tzid ? { value, dateOnly, tzid } : { value, dateOnly };
        break;
      case "DTEND":
        parsed.dtend = tzid ? { value, dateOnly, tzid } : { value, dateOnly };
        break;
      case "DUE":
        parsed.due = tzid ? { value, dateOnly, tzid } : { value, dateOnly };
        break;
      case "RECURRENCE-ID":
        parsed.recurrenceId = tzid
          ? { value, dateOnly, tzid }
          : { value, dateOnly };
        break;
      case "STATUS":
        parsed.status = value;
        break;
      case "COMPLETED":
        parsed.completed = value;
        break;
      default:
        if (name === "RRULE") parsed.hasRrule = true;
        parsed.rest.push(line);
    }
  }
  return parsed;
}

/**
 * Parse a date input that is either `YYYY-MM-DD` (all-day, date-only) or an
 * ISO datetime string (converted to UTC). Returns the ICS value plus flags
 * and the epoch millis for arithmetic.
 */
export function normalizeDateInput(
  input: string,
): { value: string; dateOnly: boolean; ms: number } {
  const trimmed = input.trim();
  const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dateOnlyMatch) {
    const [, y, m, d] = dateOnlyMatch;
    return {
      value: `${y}${m}${d}`,
      dateOnly: true,
      ms: Date.UTC(+y!, +m! - 1, +d!),
    };
  }
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) {
    throw new Error(
      `could not parse date "${input}" — use YYYY-MM-DD or an ISO datetime`,
    );
  }
  const date = new Date(ms);
  return { value: toIcsDateTimeUtc(date), dateOnly: false, ms };
}

/**
 * Convert an ICS date or datetime value to epoch millis.
 *
 * - Date-only values are UTC midnights (they represent a calendar day).
 * - Values with a trailing Z are already UTC.
 * - TZID-qualified values are wall-clock times in that IANA zone — treating
 *   them as UTC was my 8-hour lie, because Apple serves Pacific events as
 *   `DTSTART;TZID=America/Los_Angeles:20261103T181500`.
 * - Floating times (no Z, no TZID) mean "the observer's local time" per
 *   RFC 5545, so I interpret them in the local zone.
 */
export function icsValueToMs(
  value: string,
  dateOnly: boolean,
  tzid?: string,
): number {
  const compact = value.replace(/[-:]/g, "");
  if (dateOnly || /^\d{8}$/.test(compact)) {
    const y = +compact.slice(0, 4);
    const m = +compact.slice(4, 6);
    const d = +compact.slice(6, 8);
    return Date.UTC(y, m - 1, d);
  }
  const y = +compact.slice(0, 4);
  const mo = +compact.slice(4, 6);
  const d = +compact.slice(6, 8);
  const h = +compact.slice(9, 11);
  const mi = +compact.slice(11, 13);
  const s = +compact.slice(13, 15);
  if (compact.endsWith("Z")) {
    return Date.UTC(y, mo - 1, d, h, mi, s);
  }
  if (tzid) {
    const zoned = zonedWallTimeToMs(tzid, y, mo, d, h, mi, s);
    if (!Number.isNaN(zoned)) return zoned;
  }
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

/**
 * Interpret wall-clock time in an IANA timezone via Intl's offset table.
 * Two passes because the offset can differ between the naive guess and the
 * resolved instant across DST boundaries. Returns NaN when the zone is
 * unknown to this ICU build.
 */
function zonedWallTimeToMs(
  tz: string,
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
): number {
  const candidates = [tz];
  const stripped = tz.replace(/^\/[^/]+/, ""); // Apple sometimes prefixes vendor paths
  if (stripped !== tz) candidates.push(stripped);
  const segments = tz.split("/");
  if (segments.length >= 2) candidates.push(segments.slice(-2).join("/"));
  for (const candidate of candidates) {
    try {
      // Solve wallAsUtc − offset(at instant) = instant. Each pass re-derives
      // from the constant wall time; the loop is for DST-edge convergence.
      const wallAsUtc = Date.UTC(y, mo - 1, d, h, mi, s);
      let guess = wallAsUtc;
      for (let pass = 0; pass < 2; pass++) {
        guess = wallAsUtc - tzOffsetMinutes(candidate, guess) * 60_000;
      }
      return guess;
    } catch {
      // unknown zone identifier — try the next candidate form
    }
  }
  return NaN;
}

/** Minutes east of UTC at a given instant for an IANA zone (throws if unknown). */
function tzOffsetMinutes(tz: string, utcMs: number): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(utcMs))) {
    parts[part.type] = part.value;
  }
  const asUtc = Date.UTC(
    +parts.year!,
    +parts.month! - 1,
    +parts.day!,
    +parts.hour! % 24,
    +parts.minute!,
    +parts.second!,
  );
  return (asUtc - utcMs) / 60_000;
}
