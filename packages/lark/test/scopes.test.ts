import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTH_DOMAINS,
  DEFAULT_QR_DOMAINS,
  DOMAIN_SCOPES,
  missingScopes,
  normalizeDomains,
  scopesForDomains,
} from "../extensions/scopes.ts";

test("permission snapshot exposes the fixed-version auth domains", () => {
  assert.equal(AUTH_DOMAINS.length, 19);
  assert.deepEqual(normalizeDomains("docs, calendar docs"), ["calendar", "docs"]);
  assert.throws(() => normalizeDomains("calendar,unknown"), /未知领域：unknown/);
});

test("QR configuration has a stable built-in common domain set", () => {
  assert.deepEqual(DEFAULT_QR_DOMAINS, ["calendar", "docs", "drive"]);
  for (const domain of DEFAULT_QR_DOMAINS) assert.ok(domain in DOMAIN_SCOPES);
});

test("domain scopes are deduplicated and split by identity", () => {
  const scopes = scopesForDomains(["calendar", "docs"]);
  assert.ok(scopes.tenant.includes("calendar:calendar.event:create"));
  assert.ok(scopes.user.includes("docx:document:create"));
  assert.equal(scopes.user.length, new Set(scopes.user).size);
  assert.deepEqual(missingScopes(["a", "b"], ["b"]), ["a"]);
});
