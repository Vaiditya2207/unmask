import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { createApp } from "../../src/server/app.mjs";
import { createReport } from "../../src/core/report.mjs";
import { compareInventories } from "../../src/core/compare.mjs";

const spec = "example@1.2.3";
const versionInfo = {
  version: "0.0.0",
  commit: "a".repeat(40),
  tarballSha256: "b".repeat(64),
};
function reportFixture() {
  const value = { name: "example", version: "1.2.3" };
  const content = Buffer.from(JSON.stringify(value));
  const entry = {
    path: "package.json",
    originalPath: "package/package.json",
    type: "file",
    content,
    size: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
    inspection: "retained",
  };
  const inventory = {
    digest: { sha256: "a".repeat(64) },
    entries: [entry],
    complete: true,
    failures: [],
  };
  const comparison = compareInventories(inventory, inventory);
  const manifest = {
    status: "usable",
    value,
    evidenceIds: comparison.files[0].evidenceIds,
  };
  return createReport({
    inputs: {
      sourceArchive: { sha256: "a".repeat(64) },
      artifact: { sha256: "a".repeat(64), sha512: "b".repeat(128) },
      claim: value,
      limits: { maxEntries: 20000 },
    },
    source: {
      status: "selected",
      method: "publisher-gitHead",
      alternatives: [],
    },
    comparison,
    manifests: {
      artifact: manifest,
      source: manifest,
      registry: { status: "unavailable" },
    },
  });
}
function advisories(items = []) {
  return {
    schemaVersion: "1",
    source: "OSV",
    package: { ecosystem: "npm", name: "example", version: "1.2.3" },
    queriedAt: "2026-10-31T22:30:00.000Z",
    status: items.length ? "found" : "none-reported",
    complete: true,
    reasons: [],
    advisories: items,
    pagesFetched: 1,
    limits: { advisories: 100 },
  };
}
const malware = () => ({
  id: "MAL-2026-1234",
  aliases: ["GHSA-synthetic-test"],
  affected: [
    { package: { ecosystem: "npm", name: "example" }, versions: ["1.2.3"] },
  ],
});
async function start(t, options = {}) {
  const app = createApp({
    versionInfo,
    runAnalysis: async () => reportFixture(),
    enrichJob: async () => advisories(),
    ...options,
  });
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        app.closeAllConnections();
        app.close(resolve);
      }),
  );
  const origin = `http://127.0.0.1:${app.address().port}`;
  const submitted = await fetch(origin + "/check", {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ package: spec }),
  });
  const path = submitted.headers.get("location");
  return {
    origin,
    path,
    get: (suffix = ".decision.json") => fetch(origin + path + suffix),
  };
}
async function complete(s) {
  for (let i = 0; i < 50; i++) {
    const response = await s.get(".json");
    if (response.status !== 202) return;
    await new Promise(setImmediate);
  }
  throw new Error("Fixture check did not finish");
}

test("stored report decision permits a complete no-finding assessment without mutating report", async (t) => {
  const input = reportFixture();
  const original = JSON.stringify(input);
  const s = await start(t, { runAnalysis: async () => input });
  await complete(s);
  const response = await s.get();
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.decision, "allow");
  assert.equal(result.permitted, true);
  assert.equal(result.assessment.complete, true);
  assert.equal(result.assessment.modelStatus, "disabled");
  assert.deepEqual(result.package, {
    ecosystem: "npm",
    name: "example",
    version: "1.2.3",
  });
  assert.equal(result.policyExitCode, 0);
  assert.match(result.limitations.join(" "), /not.*guarantee/i);
  assert.equal(await (await s.get(".json")).text(), original);
});

test("malware advisory identity blocks even when analysis is absent or incomplete", async (t) => {
  const s = await start(t, { enrichJob: async () => advisories([malware()]) });
  await complete(s);
  const result = await (await s.get()).json();
  assert.equal(result.decision, "block");
  assert.equal(result.permitted, false);
  assert.deepEqual(result.knownMalware, [
    { id: "MAL-2026-1234", aliases: ["GHSA-synthetic-test"] },
  ]);
  assert.equal(
    result.reasons.some((reason) => reason.code === "known-malware"),
    true,
  );
});

test("advisory outage is unknown and cannot inherit deterministic exit-zero as permission", async (t) => {
  const s = await start(t, {
    enrichJob: async () => {
      throw new Error("offline");
    },
  });
  await complete(s);
  const result = await (await s.get()).json();
  assert.equal(result.decision, "unknown");
  assert.equal(result.permitted, false);
  assert.equal(result.assessment.advisoriesComplete, false);
  assert.equal(result.policyExitCode, 0);
});

test("AI prose and advisory summaries cannot invent a malware classification", async (t) => {
  const input = reportFixture();
  input.model = {
    status: "complete",
    hypotheses: [
      {
        category: "review-concern",
        explanation: "MAL-2026-1234 malware block",
      },
    ],
  };
  const s = await start(t, {
    runAnalysis: async () => input,
    enrichJob: async () =>
      advisories([
        {
          id: "GHSA-synthetic-0001",
          aliases: [],
          summary: "Malware MAL-2026-1234",
          affected: [],
        },
      ]),
  });
  await complete(s);
  const result = await (await s.get()).json();
  assert.equal(result.decision, "warn");
  assert.equal(result.permitted, true);
  assert.deepEqual(result.knownMalware, []);
});

test("pending and failed checks expose unknown rather than permission", async (t) => {
  let resolve;
  const pending = new Promise((r) => {
    resolve = r;
  });
  const s = await start(t, { runAnalysis: () => pending });
  const response = await s.get();
  assert.equal(response.status, 202);
  assert.equal((await response.json()).decision, "unknown");
  resolve(reportFixture());
  await complete(s);
  const failed = await start(t, {
    runAnalysis: async () => {
      throw new Error("private internals");
    },
  });
  await complete(failed);
  const result = await (await failed.get()).json();
  assert.equal(result.decision, "unknown");
  assert.equal(result.permitted, false);
  assert.doesNotMatch(JSON.stringify(result), /private internals/);
});

test("decision endpoint rejects missing reports and never starts analysis on GET", async (t) => {
  const s = await start(t);
  await complete(s);
  const missing = await fetch(
    s.origin + "/r/" + "f".repeat(32) + ".decision.json",
  );
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, "report-unavailable");
  const wrongMethod = await fetch(s.origin + s.path + ".decision.json", {
    method: "POST",
  });
  assert.equal(wrongMethod.status, 405);
});

test("guard refuses mismatched report/advisory identities and malformed completeness", async () => {
  const { evaluateGuardDecision } =
    await import("../../src/core/guard-policy.mjs");
  for (const edit of [
    (input) => {
      input.report.inputs.claim.version = "9.9.9";
    },
    (input) => {
      input.vulnerabilityCheck.package.version = "9.9.9";
    },
    (input) => {
      input.vulnerabilityCheck.advisories = null;
    },
    (input) => {
      input.vulnerabilityCheck.advisories = [
        { id: "GHSA-test", aliases: "MAL-2026-1234" },
      ];
      input.vulnerabilityCheck.status = "found";
    },
    (input) => {
      input.report.coverage.complete = false;
    },
  ]) {
    const input = {
      nameAtExactVersion: spec,
      report: reportFixture(),
      vulnerabilityCheck: advisories(),
    };
    edit(input);
    const result = evaluateGuardDecision(input);
    assert.equal(result.decision, "unknown");
    assert.equal(result.permitted, false);
    assert.equal(result.assessment.complete, false);
  }
  assert.throws(
    () => evaluateGuardDecision({ nameAtExactVersion: "example@latest" }),
    /exact npm/,
  );
});

test("partial advisory lookup retains a known malware blocker without claiming completion", async () => {
  const { evaluateGuardDecision } =
    await import("../../src/core/guard-policy.mjs");
  const check = advisories([malware()]);
  check.complete = false;
  check.status = "incomplete";
  check.reasons = ["page-limit"];
  const result = evaluateGuardDecision({
    nameAtExactVersion: spec,
    vulnerabilityCheck: check,
  });
  assert.equal(result.decision, "block");
  assert.equal(result.assessment.complete, false);
  assert.equal(result.knownMalware[0].id, "MAL-2026-1234");
});

test("withdrawn malware records and textual malware mentions do not block", async () => {
  const { evaluateGuardDecision } =
    await import("../../src/core/guard-policy.mjs");
  const item = { ...malware(), withdrawn: "2026-01-01T00:00:00Z" };
  const result = evaluateGuardDecision({
    nameAtExactVersion: spec,
    report: reportFixture(),
    vulnerabilityCheck: advisories([item]),
  });
  assert.equal(result.decision, "allow");
  assert.deepEqual(result.knownMalware, []);
});

test("deterministic integrity mismatch blocks with evidence while keeping existing policy exit", async () => {
  const { evaluateGuardDecision } =
    await import("../../src/core/guard-policy.mjs");
  const { policyResult } = await import("../../src/core/policy.mjs");
  const report = reportFixture();
  report.inputs.artifact.expectedIntegrity = {
    algorithm: "sha256",
    digest: "e".repeat(64),
  };
  report.policy = policyResult(report);
  const result = evaluateGuardDecision({
    nameAtExactVersion: spec,
    report,
    vulnerabilityCheck: advisories(),
  });
  assert.equal(result.decision, "block");
  assert.equal(result.policyExitCode, 3);
  assert.equal(
    result.reasons.some((reason) => reason.ruleId === "integrity-mismatch"),
    true,
  );
  assert.equal(report.policy.exitCode, 3);
});
