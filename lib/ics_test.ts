/**
 * Round-trip tests for my iCalendar helpers — the part of the plugin where
 * a silent formatting bug would write corrupt data into my calendar.
 * Run: deno test -A lib/ics_test.ts
 */

import assert from "node:assert/strict";
import {
  buildVevent,
  buildVtodo,
  escapeIcsText,
  foldLine,
  icsValueToMs,
  normalizeDateInput,
  parseComponent,
  setVtodoCompleted,
  unescapeIcsText,
  unfoldIcs,
} from "./ics.ts";

function getProp(ics: string, name: string): string | undefined {
  const prefix = name.toUpperCase();
  const line = unfoldIcs(ics).find((l) => l.toUpperCase().startsWith(prefix));
  return line?.slice(line.indexOf(":") + 1);
}

Deno.test("escape/unescape round-trips text with ICS specials", () => {
  const text = 'path; to "thing", with\\ backslash\nand newline';
  assert.equal(unescapeIcsText(escapeIcsText(text)), text);
});

Deno.test("fold/unfold round-trips long lines and never splits surrogates", () => {
  const long = "SUMMARY:" + "x".repeat(100) + "🎉" + "y".repeat(50);
  const folded = foldLine(long);
  assert.ok(folded.split("\r\n").every((part) => part.length <= 75));
  const unfolded = folded.replace(/\r\n /g, "");
  assert.equal(unfolded, long);
});

Deno.test("buildVtodo produces a parseable VTODO with date-only due", () => {
  const ics = buildVtodo({
    uid: "abc@psycheros",
    title: "Draft; chapter, 3",
    due: "2026-11-04",
    notes: "line1\nline2",
  });
  const parsed = parseComponent(ics);
  assert.ok(parsed);
  assert.equal(parsed.uid, "abc@psycheros");
  assert.equal(parsed.summary, "Draft; chapter, 3");
  assert.equal(parsed.description, "line1\nline2");
  assert.deepEqual(parsed.due, { value: "20261104", dateOnly: true });
  assert.equal(parsed.status, "NEEDS-ACTION");
});

Deno.test("buildVevent defaults end to +1h and handles all-day", () => {
  const timed = buildVevent({
    uid: "e1@psycheros",
    title: "Call",
    start: "2026-11-04T09:00:00-05:00",
  });
  const parsedTimed = parseComponent(timed);
  assert.ok(parsedTimed);
  const start = parsedTimed.dtstart;
  assert.ok(start);
  assert.equal(start.value, "20261104T140000Z");
  assert.equal(getProp(timed, "DTEND"), "20261104T150000Z");

  const allDay = buildVevent({
    uid: "e2@psycheros",
    title: "Trip",
    start: "2026-11-04",
  });
  assert.equal(getProp(allDay, "DTSTART;VALUE=DATE"), "20261104");
  assert.equal(getProp(allDay, "DTEND;VALUE=DATE"), "20261105");
});

Deno.test("setVtodoCompleted flips status without dropping unknown properties", () => {
  const ics = buildVtodo({
    uid: "t1@psycheros",
    title: "Pay rent",
    due: "2026-11-01",
  })
    .replace("END:VTODO", "RELATED-TO;RELTYPE=CHILD:parent-uid\r\nEND:VTODO");
  const done = setVtodoCompleted(ics, true);
  assert.equal(getProp(done, "STATUS"), "COMPLETED");
  assert.match(done, /^COMPLETED:/m);
  assert.match(done, /RELATED-TO;RELTYPE=CHILD:parent-uid/);

  const reopened = setVtodoCompleted(done, false);
  assert.equal(getProp(reopened, "STATUS"), "NEEDS-ACTION");
  assert.doesNotMatch(reopened, /^COMPLETED:/m);
  assert.match(reopened, /RELATED-TO;RELTYPE=CHILD:parent-uid/);
});

Deno.test("date helpers round-trip across input formats", () => {
  const dateOnly = normalizeDateInput("2026-11-04");
  assert.equal(dateOnly.value, "20261104");
  assert.equal(icsValueToMs(dateOnly.value, true), Date.UTC(2026, 10, 4));

  const timed = normalizeDateInput("2026-11-04T09:30:00+02:00");
  assert.equal(timed.value, "20261104T073000Z");
  assert.equal(icsValueToMs(timed.value, false), timed.ms);

  assert.throws(() => normalizeDateInput("not a date"));
});
