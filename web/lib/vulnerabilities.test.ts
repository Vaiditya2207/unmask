import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVulnerabilityCheck, safeHttps } from "./vulnerabilities.ts";

const identity = { name: "lodash", version: "4.17.20" };
const lookup = (extra: Record<string, unknown> = {}) => ({
  schemaVersion: "1",
  source: "OSV",
  package: { ...identity, ecosystem: "npm" },
  queriedAt: "2026-10-31T20:41:39.100Z",
  status: "none-reported",
  complete: true,
  reasons: [],
  advisories: [],
  pagesFetched: 1,
  limits: { pages: 3 },
  ...extra,
});
test("missing, partial and unavailable lookups never become a completed empty result", () => {
  assert.equal(
    parseVulnerabilityCheck(undefined, identity).status,
    "not-assessed",
  );
  assert.equal(
    parseVulnerabilityCheck(lookup(), identity).status,
    "none-reported",
  );
  for (const value of [
    lookup({ complete: false }),
    lookup({ pagesFetched: 0 }),
    lookup({ status: "incomplete", complete: false, reasons: ["page-limit"] }),
    lookup({ reasons: ["record-limit"] }),
  ])
    assert.equal(parseVulnerabilityCheck(value, identity).status, "incomplete");
  assert.equal(
    parseVulnerabilityCheck(
      lookup({ status: "unavailable", complete: false, reasons: ["timeout"] }),
      identity,
    ).status,
    "unavailable",
  );
  assert.equal(
    parseVulnerabilityCheck(
      lookup({ package: { ...identity, version: "wrong", ecosystem: "npm" } }),
      identity,
    ).status,
    "unavailable",
  );
  assert.equal(
    parseVulnerabilityCheck(
      lookup({ status: { toString: "not callable" } }),
      identity,
    ).status,
    "unavailable",
  );
  assert.equal(
    parseVulnerabilityCheck(lookup({ source: "unrecognized" }), identity)
      .status,
    "unavailable",
  );
});
test("advisory records retain their declared severity and partial reasons with bounded rows", () => {
  const advisory = {
    id: "GHSA-test",
    summary: "<script>data</script>",
    severity: [{ type: "CVSS_V3", score: "CVSS:3.1/vector" }],
  };
  const found = parseVulnerabilityCheck(
    lookup({ status: "found", advisories: [advisory] }),
    identity,
  );
  assert.equal(found.status, "found");
  assert.deepEqual(found.advisories, [advisory]);
  const partial = parseVulnerabilityCheck(
    lookup({
      status: "incomplete",
      complete: false,
      reasons: ["record-limit"],
      advisories: [advisory],
    }),
    identity,
  );
  assert.equal(partial.status, "incomplete");
  assert.deepEqual(partial.reasons, ["record-limit"]);
  const invalid = parseVulnerabilityCheck(
    lookup({ status: "found", advisories: [null] }),
    identity,
  );
  assert.equal(invalid.status, "incomplete");
  const capped = parseVulnerabilityCheck(
    lookup({ status: "found", advisories: Array(101).fill(advisory) }),
    identity,
  );
  assert.equal(capped.status, "incomplete");
  assert.equal(capped.advisories.length, 100);
});
test("advisory links allow inert HTTPS without credentials or whitespace", () => {
  assert.equal(
    safeHttps("https://osv.dev/vulnerability/GHSA-test"),
    "https://osv.dev/vulnerability/GHSA-test",
  );
  for (const bad of [
    "javascript:alert(1)",
    "data:text/html,x",
    "//evil.invalid",
    "http://evil.invalid",
    "https://user:secret@evil.invalid",
    "https://evil.invalid/\npath",
    null,
  ])
    assert.equal(safeHttps(bad), null);
});
