/**
 * Unit tests for the send gate and address normalization — the parts of
 * the send path where a bug means mail to the wrong place or a gate that
 * silently opens. Pure logic, no network.
 * Run: deno test -A lib/handlers_test.ts
 */

import assert from "node:assert/strict";
import { normalizeAddresses } from "./handlers.ts";

Deno.test("addresses accept one address, comma lists, and arrays", () => {
  assert.deepEqual(normalizeAddresses("a@b.com"), { addresses: ["a@b.com"] });
  assert.deepEqual(normalizeAddresses("a@b.com, c@d.org; e@f.net"), {
    addresses: ["a@b.com", "c@d.org", "e@f.net"],
  });
  assert.deepEqual(normalizeAddresses(["a@b.com", "c@d.org"]), {
    addresses: ["a@b.com", "c@d.org"],
  });
});

Deno.test("addresses reject malformed entries by name, before any send", () => {
  const result = normalizeAddresses("good@b.com, not-an-email");
  assert.ok(result.error);
  assert.match(result.error, /not-an-email/);
  assert.equal(result.addresses, undefined);

  assert.ok(normalizeAddresses(["a@b.com", "@missing-local-part"]).error);
  assert.ok(normalizeAddresses("no-at-symbol").error);
});

Deno.test("addresses treat absent cc as empty, not an error", () => {
  assert.deepEqual(normalizeAddresses(undefined), {});
  assert.deepEqual(normalizeAddresses(""), {});
  assert.deepEqual(normalizeAddresses(null), {});
});
