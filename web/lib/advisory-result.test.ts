import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAdvisoryResult } from "./advisory-result.ts";

const check = (name: string, version: string, extra = {}) => ({
  schemaVersion: "1",
  source: "OSV",
  package: { ecosystem: "npm", name, version },
  queriedAt: "2026-11-01T00:00:00.000Z",
  status: "found",
  complete: true,
  reasons: [],
  advisories: [
    {
      id: "GHSA-97m3-w2cp-4xx6",
      summary: "Embedded Malicious Code in node-ipc",
    },
  ],
  pagesFetched: 1,
  limits: {},
  ...extra,
});
const result = (vulnerabilityCheck: unknown, reason = "analysis-failed") => ({
  schemaVersion: "1",
  kind: "advisory-only",
  assessment: "advisories-reported",
  artifactVerification: { status: "not-performed", reason },
  safetyVerdict: "not-provided",
  vulnerabilityCheck,
});

test("failed job advisory-only result lists exact-version advisories", () => {
  const parsed = parseAdvisoryResult(
    result(check("node-ipc", "10.1.1")),
    "node-ipc@10.1.1",
  );
  assert.ok(parsed);
  assert.equal(parsed.reported, true);
  assert.equal(parsed.vulnerability.status, "found");
  assert.equal(parsed.vulnerability.advisories[0].id, "GHSA-97m3-w2cp-4xx6");
  assert.equal(parsed.artifactReason, "analysis-failed");
  assert.match(parsed.detail, /not inspected/);
  const scoped = parseAdvisoryResult(
    result(check("@scope/pkg", "1.0.0"), "execution-timeout"),
    "@scope/pkg@1.0.0",
  );
  assert.equal(scoped?.reported, true);
  assert.equal(scoped?.artifactReason, "execution-timeout");
});

test("mismatched, empty or unavailable lookups never read as safe", () => {
  const mismatch = parseAdvisoryResult(
    result(check("other", "10.1.1")),
    "node-ipc@10.1.1",
  );
  assert.equal(mismatch?.reported, false);
  assert.deepEqual(mismatch?.vulnerability.reasons, [
    "lookup-identity-mismatch",
  ]);
  assert.equal(mismatch?.headline, "Advisory lookup unavailable");
  const quiet = parseAdvisoryResult(
    result(
      check("left-pad", "1.3.0", { status: "none-reported", advisories: [] }),
    ),
    "left-pad@1.3.0",
  );
  assert.equal(quiet?.headline, "No advisory reported for this exact version");
  assert.match(quiet?.detail ?? "", /not evidence of safety/);
  const hostile = parseAdvisoryResult(
    result(check("node-ipc", "10.1.1"), "\u001b]0;x\u0007"),
    "node-ipc@10.1.1",
  );
  assert.equal(hostile?.artifactReason, "unknown");
  assert.equal(parseAdvisoryResult(undefined, "node-ipc@10.1.1"), null);
  assert.equal(
    parseAdvisoryResult({ kind: "report" }, "node-ipc@10.1.1"),
    null,
  );
});
