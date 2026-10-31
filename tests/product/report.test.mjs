import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { compareInventories } from "../../src/core/compare.mjs";
import {
  createReport,
  validateReport,
  canonicalReport,
} from "../../src/core/report.mjs";
import { policyResult } from "../../src/core/policy.mjs";

function args() {
  const content = Buffer.from("hello");
  const sha256 = createHash("sha256").update(content).digest("hex");
  const artifact = {
    digest: { sha256: "a".repeat(64) },
    entries: [
      {
        path: "a",
        originalPath: "package/a",
        type: "file",
        size: 5,
        sha256,
        content,
        inspection: "retained",
      },
    ],
    complete: true,
    failures: [],
  };
  return {
    inputs: {
      artifact: { sha256: "a".repeat(64), sha512: "b".repeat(128) },
      limits: { maxEntries: 20000 },
    },
    source: { status: "unresolved", method: "unresolved", alternatives: [] },
    comparison: compareInventories(artifact, null),
    manifests: {
      artifact: { status: "unavailable" },
      source: { status: "unavailable" },
      registry: { status: "unavailable" },
    },
  };
}

test("report factory validates deterministic evidence and snapshots caller-owned data", () => {
  const input = args();
  const report = createReport(input);
  assert.equal(validateReport(report), report);
  assert.equal(report.schemaVersion, "1");
  assert.equal(report.model.status, "disabled");
  assert.equal(report.policyVersion, "default-1");
  assert.deepEqual(report.policy, { exitCode: 0, findings: [] });
  input.inputs.artifact.sha256 = "c".repeat(64);
  assert.equal(report.inputs.artifact.sha256, "a".repeat(64));
  assert.equal(JSON.stringify(report).includes('"type":"Buffer"'), false);
});

test("canonical JSON recursively sorts keys and excludes only top-level run and model", () => {
  const report = createReport(args());
  const first = canonicalReport(report);
  report.run = {
    surface: "web",
    timestamps: { finished: "later" },
    timings: { total: 999 },
    observations: [],
  };
  report.model = { status: "timeout", details: "advisory only" };
  const reordered = Object.fromEntries(Object.entries(report).reverse());
  reordered.inputs = Object.fromEntries(
    Object.entries(reordered.inputs).reverse(),
  );
  assert.equal(canonicalReport(reordered), first);
  assert.equal(first.endsWith("\n"), true);
  assert.equal(first.includes('"run":'), false);
  report.inputs.limits.maxEntries = 100;
  assert.notEqual(canonicalReport(report), first);
  report.inputs.limits.maxEntries = 20000;
  report.analyzerVersion = "0.0.1";
  assert.notEqual(canonicalReport(report), first);
});

test("every policy finding survives incomplete reports and model attachment leaves policy fixed", () => {
  const input = args();
  input.inputs.claim = { name: "expected", version: "1.0.0" };
  input.manifests.artifact = {
    status: "usable",
    value: { name: "actual", version: "1.0.0" },
    evidenceIds: [input.comparison.evidence[0].id],
  };
  input.failures = [
    { code: "source-fetch-failed", message: "Selected source unavailable" },
  ];
  const report = createReport(input);
  assert.equal(report.policy.exitCode, 2);
  assert.equal(report.policy.findings[0].ruleId, "identity-claim-conflict");
  const canonical = canonicalReport(report);
  report.model = {
    status: "complete",
    hypotheses: [{ text: "not a verdict" }],
  };
  assert.equal(canonicalReport(report), canonical);
  assert.deepEqual(report.policy, policyResult(report));
});

for (const [name, mutate] of [
  [
    "raw buffer",
    (r) => {
      r.manifests.artifact = {
        status: "usable",
        value: { raw: Buffer.from("secret") },
        evidenceIds: [],
      };
    },
  ],
  [
    "nonfinite number",
    (r) => {
      r.run.timings.total = Infinity;
    },
  ],
  [
    "undefined value",
    (r) => {
      r.inputs.extra = undefined;
    },
  ],
  [
    "cyclic object",
    (r) => {
      r.inputs.cycle = r.inputs;
    },
  ],
  [
    "dangling evidence reference",
    (r) => {
      r.files[0].evidenceIds = ["missing"];
    },
  ],
  [
    "out of bounds evidence",
    (r) => {
      r.evidence[0].range = [0, 6];
    },
  ],
  [
    "forged evidence id",
    (r) => {
      r.evidence[0].id = "ev-forged";
    },
  ],
  [
    "wrong evidence blob",
    (r) => {
      r.evidence[0].blobDigest = "f".repeat(64);
    },
  ],
  [
    "coverage denominator",
    (r) => {
      r.coverage.inventory.bytes = 6;
    },
  ],
  [
    "wrong correspondence totals",
    (r) => {
      r.coverage.states["not-compared"].bytes = 4;
    },
  ],
  [
    "forged policy result",
    (r) => {
      r.policy.exitCode = 3;
    },
  ],
  [
    "unknown top-level nondeterminism",
    (r) => {
      r.finishedAt = "today";
    },
  ],
]) {
  test(`report validation rejects ${name}`, () => {
    const r = createReport(args());
    mutate(r);
    assert.throws(() => validateReport(r), { name: "TypeError" });
  });
}

test("byte-span localization cannot carry fabricated or unbounded ranges", () => {
  const input = args();
  const report = createReport(input);
  report.files[0].localization = "byte-spans";
  report.files[0].spans = { artifact: [-1, 999], source: [0, 1] };
  assert.throws(() => validateReport(report), TypeError);
});

test("an artifact-only state cannot claim source absence without a complete source", () => {
  const r = createReport(args());
  r.files[0].state = "artifact-only";
  r.coverage.states["not-compared"] = { files: 0, bytes: 0 };
  r.coverage.states["artifact-only"] = { files: 1, bytes: 5 };
  assert.throws(() => validateReport(r), TypeError);
});

test("canonical parity explicitly versions the effective resource limits", () => {
  const input = args();
  const a = createReport(input);
  assert.equal(a.limitsVersion, "1");
  const b = createReport({ ...input, limitsVersion: "2" });
  assert.notEqual(canonicalReport(a), canonicalReport(b));
  assert.equal(a.source.complete, false);
});

test("report preserves unavailable expected integrity without inventing a digest", () => {
  const input = args();
  input.inputs.artifact.expectedIntegrity = { status: "unavailable" };
  assert.equal(createReport(input).policy.exitCode, 0);
});

test("full report from synthetic inventories preserves exact lifecycle evidence and exit precedence", () => {
  function archive(value, blobDigest) {
    const content = Buffer.from(JSON.stringify(value));
    return {
      digest: { sha256: blobDigest },
      complete: true,
      failures: [],
      entries: [
        {
          type: "file",
          path: "package.json",
          originalPath: "root/package.json",
          size: content.length,
          sha256: createHash("sha256").update(content).digest("hex"),
          content,
          inspection: "retained",
        },
      ],
    };
  }
  const artifactManifest = {
    name: "pkg",
    version: "1.0.0",
    scripts: { install: "node inert.js" },
  };
  const sourceManifest = { name: "pkg", version: "1.0.0" };
  const artifact = archive(artifactManifest, "a".repeat(64));
  const source = archive(sourceManifest, "c".repeat(64));
  const comparison = compareInventories(artifact, source);
  const input = {
    inputs: {
      artifact: { sha256: artifact.digest.sha256, sha512: "b".repeat(128) },
      sourceArchive: { sha256: source.digest.sha256 },
      limits: { retainedBytes: 134217728 },
    },
    source: {
      status: "selected",
      method: "user-full-SHA",
      alternatives: [],
      commit: "d".repeat(40),
    },
    comparison,
    manifests: {
      artifact: {
        status: "usable",
        value: artifactManifest,
        evidenceIds: [comparison.evidence[0].id],
      },
      source: {
        status: "usable",
        value: sourceManifest,
        evidenceIds: [comparison.evidence[1].id],
      },
      registry: { status: "unavailable" },
    },
  };
  const result = createReport(input);
  assert.equal(result.policy.exitCode, 3);
  assert.deepEqual(
    result.policy.findings.map((f) => f.ruleId),
    ["lifecycle-source-absent"],
  );
  assert.equal(result.source.complete, true);
  assert.equal(result.files[0].state, "changed");
  assert.deepEqual(
    result.policy.findings[0].evidenceIds,
    comparison.evidence.map((e) => e.id).sort(),
  );
  input.failures = [
    { code: "artifact-cap-exceeded", message: "Inventory is a lower bound" },
  ];
  const partial = createReport(input);
  assert.equal(partial.policy.exitCode, 2);
  assert.deepEqual(partial.policy.findings, result.policy.findings);
});

test("canonical parity requires effective limits rather than only a version label", () => {
  const input = args();
  delete input.inputs.limits;
  assert.throws(() => createReport(input), TypeError);
  input.inputs.limitsDigest = "f".repeat(64);
  assert.equal(createReport(input).inputs.limitsDigest, "f".repeat(64));
});

for (const [name, artifactText, sourceText, expectedExcerpt, expectedRange] of [
  ["whole-file", "\uFEFFabc", null, "\uFEFFabc", [0, 6]],
  ["changed-span", "a\uFEFFz", "aXz", "\uFEFF", [1, 4]],
]) {
  test(`createReport preserves byte-faithful BOM in ${name} evidence`, () => {
    function inventory(text, blobDigest) {
      const content = Buffer.from(text);
      return {
        digest: { sha256: blobDigest },
        complete: true,
        failures: [],
        entries: [
          {
            type: "file",
            path: "a",
            originalPath: "root/a",
            size: content.length,
            sha256: createHash("sha256").update(content).digest("hex"),
            content,
            inspection: "retained",
          },
        ],
      };
    }
    const input = args();
    const artifact = inventory(artifactText, "a".repeat(64));
    const source =
      sourceText === null ? null : inventory(sourceText, "c".repeat(64));
    input.comparison = compareInventories(artifact, source);
    if (source) {
      input.inputs.sourceArchive = { sha256: source.digest.sha256 };
      input.source = {
        status: "selected",
        method: "user-full-SHA",
        alternatives: [],
      };
    }
    const report = createReport(input);
    const evidence = report.evidence.find((item) => item.side === "artifact");
    assert.equal(evidence.excerpt, expectedExcerpt);
    assert.deepEqual(evidence.excerptRange, expectedRange);
    assert.equal(
      Buffer.byteLength(evidence.excerpt),
      expectedRange[1] - expectedRange[0],
    );
    assert.equal(validateReport(report), report);
  });
}
