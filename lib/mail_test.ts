/**
 * Tests for reply-threading helpers — a wrong "Re:" prefix or a mangled
 * quote is the kind of small discourtesy that compounds over an entire
 * correspondence.
 * Run: deno test -A lib/mail_test.ts
 */

import assert from "node:assert/strict";
import { buildReplySubject, quoteOriginal } from "./mail.ts";

Deno.test("reply subjects avoid stacking Re:", () => {
  assert.equal(buildReplySubject("Hello"), "Re: Hello");
  assert.equal(buildReplySubject("Re: Hello"), "Re: Hello");
  assert.equal(buildReplySubject("RE: Hello"), "RE: Hello");
  assert.equal(buildReplySubject("Fwd: Hello"), "Fwd: Hello");
  assert.equal(buildReplySubject(""), "Re: (no subject)");
});

Deno.test("quotes carry the > prefix and cap long originals", () => {
  const short = "line one\nline two";
  assert.equal(quoteOriginal(short), "> line one\n> line two");

  const long = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
  const quoted = quoteOriginal(long);
  assert.ok(quoted.startsWith("> line 1\n> line 2"));
  assert.ok(quoted.endsWith("> …"));
  assert.equal(quoted.split("\n").length, 31); // 30 quoted + ellipsis marker

  const withBlank = "top\n\nbottom";
  assert.equal(quoteOriginal(withBlank), "> top\n>\n> bottom");
});
