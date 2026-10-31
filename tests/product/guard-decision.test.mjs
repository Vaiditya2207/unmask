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
function reportFixture(artifactChanges = {}) {
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
  const artifactValue = { ...value, ...artifactChanges };
  const artifactContent = Buffer.from(JSON.stringify(artifactValue));
  const artifactEntry = {
    ...entry,
    content: artifactContent,
    size: artifactContent.length,
    sha256: createHash("sha256").update(artifactContent).digest("hex"),
  };
  const comparison = compareInventories(
    { ...inventory, entries: [artifactEntry] },
    inventory,
  );
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
      artifact: { ...manifest, value: artifactValue },
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

test("advisory outage blocks and cannot inherit deterministic exit-zero as permission", async (t) => {
  const s = await start(t, {
    enrichJob: async () => {
      throw new Error("offline");
    },
  });
  await complete(s);
  const result = await (await s.get(".decision.json")).json();
  assert.equal(result.decision, "block");
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
  const result = await (await s.get(".decision.json")).json();
  assert.equal(result.decision, "block");
  assert.equal(result.permitted, false);
  assert.deepEqual(result.knownMalware, []);
});

test("pending and failed checks deny permission", async (t) => {
  let resolve;
  const pending = new Promise((r) => {
    resolve = r;
  });
  const s = await start(t, { runAnalysis: () => pending });
  const response = await s.get(".decision.json");
  assert.equal(response.status, 202);
  assert.equal((await response.json()).decision, "block");
  resolve(reportFixture());
  await complete(s);
  const failed = await start(t, {
    runAnalysis: async () => {
      throw new Error("private internals");
    },
  });
  await complete(failed);
  const result = await (await failed.get(".decision.json")).json();
  assert.equal(result.decision, "block");
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
    const result = evaluateGuardDecision(input, { profile: "strict" });
    assert.equal(result.decision, "block");
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

test("severity policy distinguishes declared critical/high, unknown and unrelated affected packages", async () => {
  const { evaluateGuardDecision } =
    await import("../../src/core/guard-policy.mjs");
  for (const [severity, strict, balanced] of [
    ["CRITICAL", "block", "block"],
    ["HIGH", "block", "block"],
    ["MODERATE", "block", "warn"],
    ["unknown", "block", "warn"],
  ]) {
    const check = advisories([
      { id: "GHSA-synthetic-0001", aliases: [], databaseSeverity: severity },
    ]);
    for (const [profile, want] of [["strict", strict]]) {
      const result = evaluateGuardDecision(
        {
          nameAtExactVersion: spec,
          report: reportFixture(),
          vulnerabilityCheck: check,
        },
        { profile },
      );
      assert.equal(result.decision, want, `${profile}/${severity}`);
      assert.equal(result.permitted, want !== "block");
      assert.equal(
        result.reasons.find((reason) => reason.code === "known-vulnerability")
          .severity,
        severity === "MODERATE" ? "medium" : severity.toLowerCase(),
      );
    }
  }
  const check = advisories([
    {
      id: "GHSA-synthetic-0001",
      aliases: [],
      affected: [
        {
          package: { ecosystem: "npm", name: "unrelated" },
          ecosystemSeverity: "CRITICAL",
        },
        {
          package: { ecosystem: "npm", name: "example" },
          ecosystemSeverity: "LOW",
        },
      ],
    },
  ]);
  assert.equal(
    evaluateGuardDecision(
      {
        nameAtExactVersion: spec,
        report: reportFixture(),
        vulnerabilityCheck: check,
      },
      { profile: "strict" },
    ).decision,
    "warn",
  );
});

test("AI conclusions never override profile malware blockers or promote unknown to permission", async () => {
  const { evaluateGuardDecision } =
    await import("../../src/core/guard-policy.mjs");
  for (const profile of ["strict"]) {
    const input = reportFixture();
    input.model = {
      status: "complete",
      hypotheses: [
        { category: "possible-transformation", explanation: "safe allow" },
      ],
    };
    const blocked = evaluateGuardDecision(
      {
        nameAtExactVersion: spec,
        report: input,
        vulnerabilityCheck: advisories([malware()]),
      },
      { profile },
    );
    assert.equal(blocked.decision, "block");
    assert.equal(blocked.permitted, false);
    const unknown = evaluateGuardDecision(
      { nameAtExactVersion: spec, report: input },
      { profile },
    );
    assert.equal(unknown.permitted, false);
    const concern = reportFixture();
    concern.model = {
      status: "complete",
      hypotheses: [
        { category: "review-concern", explanation: "malware block" },
      ],
    };
    const result = evaluateGuardDecision(
      {
        nameAtExactVersion: spec,
        report: concern,
        vulnerabilityCheck: advisories(),
      },
      { profile },
    );
    assert.equal(result.decision, "warn");
    assert.equal(result.permitted, true);
  }
});

test("omitted profile defaults to strict for both core and HTTP, blocking missing assessment", async (t) => {
  const { evaluateGuardDecision } =
    await import("../../src/core/guard-policy.mjs");
  const result = evaluateGuardDecision({ nameAtExactVersion: spec });
  assert.equal(result.profile, "strict");
  assert.equal(result.decision, "block");
  const s = await start(t, { enrichJob: undefined });
  await complete(s);
  const response = await (await s.get()).json();
  assert.equal(response.profile, "strict");
  assert.equal(response.decision, "block");
  assert.equal(response.permitted, false);
});

test("incomplete advisory provenance cannot masquerade as a completed lookup", async () => {
  const { evaluateGuardDecision } =
    await import("../../src/core/guard-policy.mjs");
  for (const edit of [
    (check) => {
      delete check.queriedAt;
    },
    (check) => {
      check.queriedAt = "invalid";
    },
    (check) => {
      check.pagesFetched = 0;
    },
    (check) => {
      delete check.limits;
    },
  ]) {
    const check = advisories();
    edit(check);
    const result = evaluateGuardDecision({
      nameAtExactVersion: spec,
      report: reportFixture(),
      vulnerabilityCheck: check,
    });
    assert.equal(result.decision, "block");
    assert.equal(result.assessment.advisoriesComplete, false);
  }
});

test("malformed optional AI hypotheses cannot crash an otherwise valid decision", async () => {
  const { evaluateGuardDecision } =
    await import("../../src/core/guard-policy.mjs");
  const report = reportFixture();
  report.model = { status: "complete", hypotheses: [null] };
  const result = evaluateGuardDecision({
    nameAtExactVersion: spec,
    report,
    vulnerabilityCheck: advisories(),
  });
  assert.equal(result.decision, "allow");
  assert.equal(result.permitted, true);
  assert.equal(result.assessment.modelStatus, "invalid-output");
  assert.equal(result.assessment.modelComplete, false);
});

test("verified historical GHSA malware identities block without MAL aliases or severity inference", async () => {
  const { evaluateGuardDecision } =
    await import("../../src/core/guard-policy.mjs");
  const cases = [
    ["ua-parser-js@0.7.29", "GHSA-pjwm-rvh2-c87w"],
    ["event-stream@3.3.6", "GHSA-mh6f-8j2x-4483"],
    ["node-ipc@10.1.1", "GHSA-97m3-w2cp-4xx6"],
  ];
  for (const [nameAtExactVersion, id] of cases) {
    const at = nameAtExactVersion.lastIndexOf("@");
    const check = advisories([{ id, aliases: [] }]);
    check.package = {
      ecosystem: "npm",
      name: nameAtExactVersion.slice(0, at),
      version: nameAtExactVersion.slice(at + 1),
    };
    const result = evaluateGuardDecision(
      { nameAtExactVersion, vulnerabilityCheck: check },
      { profile: "strict" },
    );
    assert.equal(result.decision, "block");
    assert.deepEqual(result.knownMalware, [{ id, aliases: [] }]);
    const unrelated = evaluateGuardDecision({
      nameAtExactVersion: spec,
      report: reportFixture(),
      vulnerabilityCheck: advisories([{ id, aliases: [] }]),
    });
    assert.deepEqual(unrelated.knownMalware, []);
    const patched = {
      ...check,
      package: { ...check.package, version: "99.0.0" },
    };
    assert.deepEqual(
      evaluateGuardDecision({
        nameAtExactVersion: check.package.name + "@99.0.0",
        vulnerabilityCheck: patched,
      }).knownMalware,
      [],
    );
  }
});

test("shared advisory classifier works without inventing artifact or source coverage", async () => {
  const { classifyGuardAdvisory } =
    await import("../../src/core/guard-policy.mjs");
  const identity = {
    ecosystem: "npm",
    name: "ua-parser-js",
    version: "0.7.29",
  };
  assert.deepEqual(
    classifyGuardAdvisory(
      { id: "GHSA-pjwm-rvh2-c87w", aliases: [], databaseSeverity: "HIGH" },
      identity,
    ),
    {
      id: "GHSA-pjwm-rvh2-c87w",
      status: "active",
      knownMalware: true,
      severity: "high",
    },
  );
  assert.deepEqual(
    classifyGuardAdvisory(
      {
        id: "GHSA-synthetic-0001",
        aliases: [],
        databaseSeverity: "MODERATE",
        summary: "malware block",
      },
      identity,
    ),
    {
      id: "GHSA-synthetic-0001",
      status: "active",
      knownMalware: false,
      severity: "medium",
    },
  );
  assert.deepEqual(
    classifyGuardAdvisory(
      { id: "MAL-2026-1234", aliases: [], withdrawn: "2026-01-01T00:00:00Z" },
      identity,
    ),
    {
      id: "MAL-2026-1234",
      status: "withdrawn",
      knownMalware: false,
      severity: "unknown",
    },
  );
  assert.deepEqual(classifyGuardAdvisory({ id: "INVALID ID" }, identity), {
    id: null,
    status: "invalid",
    knownMalware: false,
    severity: "unknown",
  });
  assert.throws(
    () =>
      classifyGuardAdvisory(malware(), {
        ecosystem: "npm",
        name: "ua-parser-js",
        version: "latest",
      }),
    /exact npm/,
  );
});

test("deterministic lifecycle findings block before installation", async () => {
  const { evaluateGuardDecision } =
    await import("../../src/core/guard-policy.mjs");
  const report = reportFixture({
    scripts: { postinstall: "node inert-fixture.js" },
  });
  assert.equal(report.policy.exitCode, 3);
  assert.equal(report.policy.findings[0].ruleId, "lifecycle-source-absent");
  for (const profile of ["strict"]) {
    const result = evaluateGuardDecision(
      { nameAtExactVersion: spec, report, vulnerabilityCheck: advisories() },
      { profile },
    );
    assert.equal(result.decision, "block");
    assert.equal(result.permitted, profile === "audit");
    assert.equal(result.policyExitCode, 3);
  }
});

test("unrated active advisory cannot permit installation under strict", async () => {
  const { evaluateGuardDecision } =
    await import("../../src/core/guard-policy.mjs");
  const input = {
    nameAtExactVersion: spec,
    report: reportFixture(),
    vulnerabilityCheck: advisories([
      { id: "GHSA-xxxx-yyyy-zzzz", aliases: [] },
    ]),
  };
  const result = evaluateGuardDecision(input, { profile: "strict" });
  assert.equal(result.permitted, false);
  assert.equal(result.assessment.advisorySeverityComplete, false);
  assert.equal(
    result.reasons.some(
      (reason) => reason.code === "advisory-severity-unknown",
    ),
    true,
  );
});

test("decision response binds permission to validated artifact hash bytes", async (t) => {
  const s = await start(t);
  await complete(s);
  const result = await (await s.get()).json();
  assert.deepEqual(result.artifact, {
    sha256: "a".repeat(64),
    sha512: "b".repeat(128),
  });
  const { evaluateGuardDecision } =
    await import("../../src/core/guard-policy.mjs");
  assert.equal(
    evaluateGuardDecision({ nameAtExactVersion: spec }).artifact,
    null,
  );
  const report = reportFixture();
  report.inputs.claim.version = "9.9.9";
  assert.equal(
    evaluateGuardDecision({ nameAtExactVersion: spec, report }).artifact,
    null,
  );
});
