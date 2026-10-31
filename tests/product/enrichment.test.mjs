import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attachVulnerabilityCheck,
  boundedVulnerabilityCheck,
  DETAILS_RESPONSE_LIMITS,
} from "../../src/server/enrichment.mjs";

const clock = { now: () => 0 };
function exactBytes(bytes) {
  const value = {
    schemaVersion: "1",
    source: "OSV",
    package: { ecosystem: "npm", name: "example", version: "1.0.0" },
    queriedAt: "1970-01-01T00:00:00.000Z",
    status: "found",
    complete: true,
    reasons: [],
    advisories: [{ summary: "" }],
    pagesFetched: 1,
    limits: {},
  };
  value.advisories[0].summary = "a".repeat(
    bytes - Buffer.byteLength(JSON.stringify(value)),
  );
  assert.equal(Buffer.byteLength(JSON.stringify(value)), bytes);
  return value;
}

test("OSV envelope byte boundary is inclusive and one extra byte becomes unavailable", () => {
  const cap = DETAILS_RESPONSE_LIMITS.vulnerabilityCheckBytes;
  const allowed = exactBytes(cap);
  const accepted = boundedVulnerabilityCheck(allowed, "example@1.0.0", clock);
  assert.deepEqual(accepted, allowed);
  const rejected = boundedVulnerabilityCheck(
    exactBytes(cap + 1),
    "example@1.0.0",
    clock,
  );
  assert.equal(rejected.status, "unavailable");
  assert.equal(rejected.complete, false);
  assert.deepEqual(rejected.reasons, ["result-byte-cap"]);
  assert.deepEqual(rejected.advisories, []);
  const base = { scope: {}, padding: "" };
  base.padding = "b".repeat(
    DETAILS_RESPONSE_LIMITS.packageDetailsBytes -
      Buffer.byteLength(JSON.stringify(base)),
  );
  const combined = attachVulnerabilityCheck(base, accepted);
  assert.ok(Buffer.byteLength(JSON.stringify(combined)) <= 4194304);
});

test("combined response enforces its exact serialized UTF-8 boundary", () => {
  const details = { scope: {}, padding: "" };
  const result = attachVulnerabilityCheck(details);
  details.padding = "x".repeat(
    4194304 - Buffer.byteLength(JSON.stringify(result)),
  );
  assert.equal(
    Buffer.byteLength(JSON.stringify(attachVulnerabilityCheck(details))),
    4194304,
  );
  details.padding += "x";
  assert.throws(
    () => attachVulnerabilityCheck(details),
    /response exceeds cap/u,
  );
});

test("contradictory complete results never become a complete vulnerability assessment", () => {
  for (const change of [
    { status: "none-reported" },
    { advisories: [] },
    { complete: false },
    { queriedAt: "not-a-time" },
  ]) {
    const value = { ...exactBytes(1000), ...change };
    const result = boundedVulnerabilityCheck(value, "example@1.0.0", clock);
    assert.equal(result.status, "unavailable");
    assert.equal(result.complete, false);
    assert.deepEqual(result.reasons, ["invalid-result"]);
  }
});
