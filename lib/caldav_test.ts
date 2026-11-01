/**
 * Regression tests for my CalDAV multistatus parsing, built from REAL
 * iCloud response shapes (sanitized). Apple writes DAV elements with
 * default namespaces, attributes on tags, and single-quoted attribute
 * values in comp-filter sets — every one of those has silently broken me
 * once, so the fixtures keep all three, verbatim in structure.
 * Run: deno test -A lib/caldav_test.ts
 */

import assert from "node:assert/strict";
import {
  parseMultistatusCollections,
  parseMultistatusObjects,
} from "./caldav.ts";

/** Depth-1 home listing, shaped exactly like iCloud's (sanitized id). */
const HOME_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<multistatus xmlns="DAV:">
    <response xmlns="DAV:">
        <href>/11112222333/calendars/</href>
        <propstat>
            <prop>
                <resourcetype xmlns="DAV:">
<collection/>
</resourcetype>
                <displayname xmlns="DAV:">Test Operator</displayname>
                <supported-calendar-component-set xmlns="urn:ietf:params:xml:ns:caldav">
<comp name='VEVENT' xmlns='urn:ietf:params:xml:ns:caldav'/>
<comp name='VTODO' xmlns='urn:ietf:params:xml:ns:caldav'/>
</supported-calendar-component-set>
            </prop>
            <status>HTTP/1.1 200 OK</status>
            <propstat>
                <prop>
                    <calendar-color xmlns="http://apple.com/ns/ical/"/>
                </prop>
                <status>HTTP/1.1 404 Not Found</status>
            </propstat>
        </propstat>
    </response>
    <response xmlns="DAV:">
        <href>/11112222333/calendars/371f55f0-9fd9-49a8-953c-6b6bdc4446d2/</href>
        <propstat>
            <prop>
                <resourcetype xmlns="DAV:">
<collection/>
<calendar xmlns="urn:ietf:params:xml:ns:caldav"/>
</resourcetype>
                <displayname xmlns="DAV:">Reminders ⚠️</displayname>
                <supported-calendar-component-set xmlns="urn:ietf:params:xml:ns:caldav">
<comp name='VTODO' xmlns='urn:ietf:params:xml:ns:caldav'/>
</supported-calendar-component-set>
                <calendar-color xmlns="http://apple.com/ns/ical/">#B14BC9FF</calendar-color>
            </prop>
            <status>HTTP/1.1 200 OK</status>
        </propstat>
    </response>
    <response xmlns="DAV:">
        <href>/11112222333/calendars/A9CCB11C-8C0F-4E94-A222-4E32B1D57C10/</href>
        <propstat>
            <prop>
                <resourcetype xmlns="DAV:">
<collection/>
<calendar xmlns="urn:ietf:params:xml:ns:caldav"/>
</resourcetype>
                <displayname xmlns="DAV:">Home</displayname>
                <supported-calendar-component-set xmlns="urn:ietf:params:xml:ns:caldav">
<comp name='VEVENT' xmlns='urn:ietf:params:xml:ns:caldav'/>
</supported-calendar-component-set>
                <calendar-color xmlns="http://apple.com/ns/ical/">#34AADCFF</calendar-color>
            </prop>
            <status>HTTP/1.1 200 OK</status>
        </propstat>
    </response>
</multistatus>`;

Deno.test("collection listing parses Apple's default-namespace, attribute-tag XML", () => {
  const collections = parseMultistatusCollections(HOME_XML);
  // The home root has no <calendar/> resourcetype and must be skipped.
  assert.equal(collections.length, 2);
  const reminders = collections.find((c) => c.displayName === "Reminders ⚠️");
  assert.ok(reminders);
  assert.deepEqual(reminders.kinds, ["VTODO"]);
  assert.equal(reminders.color, "#B14BC9");
  const home = collections.find((c) => c.displayName === "Home");
  assert.ok(home);
  assert.deepEqual(home.kinds, ["VEVENT"]);
  assert.ok(
    home.href.endsWith("/calendars/A9CCB11C-8C0F-4E94-A222-4E32B1D57C10/"),
  );
});

Deno.test("double-quoted comp names parse too (other Apple endpoints)", () => {
  const xml = HOME_XML.replace(/name='(VEVENT|VTODO)'/g, 'name="$1"');
  const collections = parseMultistatusCollections(xml);
  assert.equal(collections.length, 2);
  assert.deepEqual(
    collections.map((c) => c.kinds.join("+")).sort(),
    ["VEVENT", "VTODO"],
  );
});

/** calendar-query REPORT body, shaped like iCloud's (sanitized). */
const QUERY_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<multistatus xmlns="DAV:">
    <response xmlns="DAV:">
        <href>/11112222333/calendars/A9CCB11C-8C0F-4E94-A222-4E32B1D57C10/abc123.ics</href>
        <propstat>
            <prop>
                <getetag xmlns="DAV:">"abc-etag-1"</getetag>
                <calendar-data xmlns="urn:ietf:params:xml:ns:caldav">
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Apple Inc.//macOS 15.0//EN
CALSCALE:GREGORIAN
BEGIN:VEVENT
UID:starter-event@icloud.com
DTSTAMP:20261031T030000Z
DTSTART;TZID=America/Los_Angeles:20261031T100000
DTEND;TZID=America/Los_Angeles:20261031T110000
SUMMARY:Starter event
END:VEVENT
END:VCALENDAR
</calendar-data>
            </prop>
            <status>HTTP/1.1 200 OK</status>
        </propstat>
    </response>
</multistatus>`;

Deno.test("object listing parses etag + calendar-data with attribute-carrying tags", () => {
  const objects = parseMultistatusObjects(QUERY_XML);
  assert.equal(objects.length, 1);
  assert.equal(objects[0].uid, "starter-event@icloud.com");
  assert.equal(objects[0].component.summary, "Starter event");
  assert.equal(objects[0].etag, "abc-etag-1");
  assert.match(objects[0].ics, /BEGIN:VEVENT/);
});
