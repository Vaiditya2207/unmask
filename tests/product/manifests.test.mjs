import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { compareInventories } from "../../src/core/compare.mjs";
import {
  createReport,
  canonicalReport,
  validateReport,
} from "../../src/core/report.mjs";
import { addManifestObservations } from "../../src/core/manifests.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function fixture(
  artifactValue,
  sourceValue,
  { registryValue, files = {}, sourceComplete = true } = {},
) {
  function inventory(value, side, extras = {}) {
    return {
      digest: { sha256: hash(side) },
      complete: side === "source" ? sourceComplete : true,
      failures: [],
      entries: Object.entries({
        "package.json": JSON.stringify(value),
        ...extras,
      }).map(([path, text]) => {
        const content = Buffer.from(text);
        return {
          path,
          originalPath: `${side}/${path}`,
          type: "file",
          size: content.length,
          sha256: hash(content),
          content,
          inspection: "retained",
        };
      }),
    };
  }
  const artifact = inventory(artifactValue, "artifact", files);
  const source = sourceValue === null ? null : inventory(sourceValue, "source");
  const comparison = compareInventories(artifact, source);
  const report = createReport({
    inputs: {
      artifact: { sha256: artifact.digest.sha256, sha512: "b".repeat(128) },
      ...(source ? { sourceArchive: { sha256: source.digest.sha256 } } : {}),
      ...(registryValue
        ? { registryDocument: { sha256: hash(JSON.stringify(registryValue)) } }
        : {}),
      limits: { retentionBudgetBytes: 134217728 },
    },
    source: {
      status: source ? "selected" : "unresolved",
      method: source ? "user-full-SHA" : "unresolved",
      alternatives: [],
    },
    comparison,
    manifests: {
      artifact: {
        status: "usable",
        value: artifactValue,
        evidenceIds: comparison.evidence
          .filter((e) => e.side === "artifact" && e.path === "package.json")
          .map((e) => e.id),
      },
      source: source
        ? {
            status: "usable",
            value: sourceValue,
            evidenceIds: comparison.evidence
              .filter((e) => e.side === "source" && e.path === "package.json")
              .map((e) => e.id),
          }
        : { status: "unavailable" },
      registry: registryValue
        ? { status: "usable", value: registryValue, evidenceIds: [] }
        : { status: "unavailable" },
    },
  });
  return { report, artifact, source };
}
const base = { name: "fixture", version: "1.0.0" };
const manifestCues = (report) =>
  report.cues.filter((c) => c.module === "manifest");

test("V2 added runtime dependency is MEDIUM with exact field provenance and unchanged policy", () => {
  const f = fixture(
    { ...base, dependencies: { "new/dependency": "^2.0.0" } },
    base,
  );
  const before = canonicalReport(f.report);
  const r = addManifestObservations(f.report, f);
  const cue = manifestCues(r).find(
    (c) => c.ruleId === "manifest-runtime-dependency-added",
  );
  assert.equal(cue.priority, "MEDIUM");
  assert.equal(cue.field, "/dependencies/new~1dependency");
  assert.ok(
    cue.bindings.some((b) => b.side === "source" && b.present === false),
  );
  assert.ok(
    cue.bindings.some(
      (b) =>
        b.side === "artifact" && b.present === true && b.value === "^2.0.0",
    ),
  );
  assert.deepEqual(r.policy, f.report.policy);
  assert.deepEqual(r.files, f.report.files);
  assert.equal(r.policy.exitCode, 0);
  assert.equal(canonicalReport(f.report), before);
  assert.equal(validateReport(r), r);
});

test("V3 added bin and changed main/exports values are HIGH only with usable complete source", () => {
  const f = fixture(
    {
      ...base,
      bin: { fixture: "bin/new.js" },
      main: "dist/new.js",
      exports: { ".": "./dist/new.js" },
    },
    { ...base, main: "dist/old.js" },
  );
  const r = addManifestObservations(f.report, f);
  const cues = manifestCues(r).filter(
    (c) => c.ruleId === "manifest-entrypoint-source-absent",
  );
  assert.ok(
    cues.some((c) => c.field === "/bin/fixture" && c.priority === "HIGH"),
  );
  assert.ok(cues.some((c) => c.field === "/main" && c.priority === "HIGH"));
  assert.ok(
    cues.some((c) => c.field === "/exports" && c.priority === "HIGH") ||
      cues.some((c) => c.field === "/exports/." && c.priority === "HIGH"),
  );
  assert.equal(r.policy.exitCode, 0);
  for (const source of [null, base]) {
    const unavailable = fixture(
      { ...base, bin: { fixture: "bin/new.js" } },
      source,
      { sourceComplete: false },
    );
    const unknown = addManifestObservations(unavailable.report, unavailable);
    assert.ok(
      manifestCues(unknown).every(
        (c) => c.priority !== "HIGH" && !c.ruleId.endsWith("source-absent"),
      ),
    );
  }
});

test("lifecycle HIGH observation retains existing exact policy without changing findings", () => {
  const f = fixture({ ...base, scripts: { install: "node inert.js" } }, base);
  const r = addManifestObservations(f.report, f);
  assert.ok(
    manifestCues(r).some(
      (c) =>
        c.ruleId === "manifest-lifecycle-source-absent" &&
        c.priority === "HIGH",
    ),
  );
  assert.deepEqual(r.policy, f.report.policy);
  assert.equal(r.policy.exitCode, 3);
});

test("manifest field cues use whole-manifest ranges rather than unrelated changed spans", () => {
  const f = fixture(
    { ...base, padding: "x".repeat(1000), dependencies: { added: "1.0.0" } },
    { ...base, padding: "x".repeat(1000) },
  );
  const r = addManifestObservations(f.report, f);
  const cue = manifestCues(r).find(
    (c) => c.ruleId === "manifest-runtime-dependency-added",
  );
  for (const side of ["artifact", "source"]) {
    const entry = f[side].entries.find((e) => e.path === "package.json");
    const binding = cue.bindings.find((b) => b.side === side);
    assert.ok(
      binding.evidenceIds.some((id) => {
        const evidence = r.evidence.find((e) => e.id === id);
        return (
          evidence.side === side &&
          evidence.range[0] === 0 &&
          evidence.range[1] === entry.size
        );
      }),
    );
  }
});

test("registry runtime divergence is MEDIUM and metadata-bound, never fabricated archive evidence", () => {
  const registry = {
    ...base,
    bin: { fixture: "bin/registry.js" },
    dependencies: {},
    dist: { integrity: "metadata" },
    _id: "ignored",
    gitHead: "a".repeat(40),
  };
  const f = fixture({ ...base, bin: { fixture: "bin/artifact.js" } }, base, {
    registryValue: registry,
  });
  const r = addManifestObservations(f.report, f);
  const cue = manifestCues(r).find(
    (c) =>
      c.ruleId === "manifest-registry-runtime-divergence" &&
      c.field === "/bin/fixture",
  );
  assert.equal(cue.priority, "MEDIUM");
  assert.equal(cue.normalization, "unassessed");
  const binding = cue.bindings.find((b) => b.side === "registry");
  assert.equal(binding.documentSha256, r.inputs.registryDocument.sha256);
  assert.equal(binding.evidenceIds, undefined);
  assert.ok(
    manifestCues(r).every(
      (c) =>
        !["/dist", "/_id", "/gitHead"].some((field) =>
          c.field.startsWith(field),
        ),
    ),
  );
  assert.equal(r.policy.exitCode, 0);
});

test("absent and empty runtime maps stay distinct and raw unknown fields remain intact", () => {
  const f = fixture(
    { ...base, optionalDependencies: {}, custom: { raw: true } },
    base,
    { registryValue: base },
  );
  const r = addManifestObservations(f.report, f);
  const cue = manifestCues(r).find(
    (c) =>
      c.field === "/optionalDependencies" &&
      c.bindings.some((b) => b.side === "source"),
  );
  assert.ok(
    cue.bindings.some(
      (b) => b.side === "artifact" && b.present && b.valueType === "object",
    ),
  );
  assert.ok(cue.bindings.some((b) => b.side === "source" && !b.present));
  assert.deepEqual(r.manifests, f.report.manifests);
});

test("source literal output declarations annotate location without changing unresolved bytes", () => {
  const f = fixture(
    base,
    {
      ...base,
      files: ["dist"],
      main: "./dist/main.js",
      bin: { fixture: "bin/fixture.js" },
      exports: { ".": { import: "./dist/entry.mjs" } },
    },
    {
      files: {
        "dist/main.js": "one",
        "dist/entry.mjs": "two",
        "dist2/other.js": "three",
        "bin/fixture.js": "four",
      },
    },
  );
  const r = addManifestObservations(f.report, f);
  const annotations = r.annotations.filter(
    (a) => a.type === "declared-output-location",
  );
  assert.ok(
    annotations.some(
      (a) => a.path === "dist/main.js" && a.field === "/files/0",
    ),
  );
  assert.ok(
    annotations.some((a) => a.path === "dist/main.js" && a.field === "/main"),
  );
  assert.ok(
    annotations.some(
      (a) => a.path === "bin/fixture.js" && a.field === "/bin/fixture",
    ),
  );
  assert.ok(
    annotations.some(
      (a) => a.path === "dist/entry.mjs" && a.field === "/exports/./import",
    ),
  );
  assert.ok(
    annotations.every(
      (a) => a.label === "declared-output-location; content unverified",
    ),
  );
  assert.ok(annotations.every((a) => a.path !== "dist2/other.js"));
  assert.deepEqual(r.coverage, f.report.coverage);
});

test("globs and unsupported export syntax remain unassessed instead of claiming output equivalence", () => {
  const f = fixture(
    base,
    { ...base, files: ["dist/**"], exports: { "./*": "./dist/*.js" } },
    { files: { "dist/index.js": "body" } },
  );
  const r = addManifestObservations(f.report, f);
  assert.equal(
    r.annotations.some((a) => a.type === "declared-output-location"),
    false,
  );
  assert.ok(
    r.annotations.some(
      (a) =>
        a.module === "manifest" &&
        a.reasons?.includes("unsupported-declaration"),
    ),
  );
});

for (const limits of [
  { fieldNodes: 1 },
  { cues: 0 },
  { declarations: 0 },
  { pathComparisons: 0 },
]) {
  test(`manifest bounds ${JSON.stringify(limits)} expose unassessed work without policy changes`, () => {
    const f = fixture(
      { ...base, dependencies: { a: "1", b: "2" } },
      { ...base, files: ["dist"] },
      { files: { "dist/a.js": "body" } },
    );
    const r = addManifestObservations(f.report, { ...f, limits });
    assert.ok(
      r.annotations.some(
        (a) =>
          a.module === "manifest" &&
          a.status === "partial" &&
          a.reasons.length > 0,
      ),
    );
    const scope = r.annotations.find((a) => a.type === "manifest-scope");
    for (const [key, limit] of Object.entries(limits))
      assert.ok(scope.counts[key] <= limit);
    assert.deepEqual(r.policy, f.report.policy);
    assert.deepEqual(r.coverage, f.report.coverage);
  });
}

test("reaugmentation after registry binding is idempotent and preserves unrelated cues", () => {
  const f = fixture({ ...base, dependencies: { a: "1" } }, base, {
    registryValue: base,
  });
  f.report.cues.push({ module: "syntax", ruleId: "existing", evidenceIds: [] });
  const first = addManifestObservations(f.report, f);
  const second = addManifestObservations(first);
  assert.equal(canonicalReport(first), canonicalReport(second));
  assert.equal(second.cues.filter((c) => c.ruleId === "existing").length, 1);
  assert.equal(
    new Set(second.evidence.map((e) => e.id)).size,
    second.evidence.length,
  );
});

test("declaration-only types and typings changes remain LOW observations", () => {
  const f = fixture(
    { ...base, types: "dist/new.d.ts", typings: "dist/new.d.ts" },
    { ...base, types: "dist/old.d.ts" },
  );
  const r = addManifestObservations(f.report, f);
  assert.ok(
    manifestCues(r).some((c) => c.field === "/types" && c.priority === "LOW"),
  );
  assert.ok(
    manifestCues(r).some((c) => c.field === "/typings" && c.priority === "LOW"),
  );
  assert.ok(
    manifestCues(r).every(
      (c) => !["/types", "/typings"].includes(c.field) || c.priority === "LOW",
    ),
  );
  assert.equal(r.policy.exitCode, 0);
});

test("unretained manifest declarations and missing covering evidence stay explicitly unassessed", () => {
  const f = fixture({ ...base, bin: { fixture: "new.js" } }, base);
  const missing = addManifestObservations(f.report);
  assert.ok(manifestCues(missing).every((c) => c.priority !== "HIGH"));
  assert.ok(
    missing.annotations.some((a) =>
      a.reasons?.includes("source-manifest-evidence-unavailable"),
    ),
  );
  f.report.manifests.source = {
    status: "unavailable",
    reason: "retention-cap",
  };
  const unavailable = addManifestObservations(f.report, f);
  const scope = unavailable.annotations.find(
    (a) => a.type === "manifest-scope",
  );
  assert.equal(scope.sourceDeclarationStatus, "unassessed");
  assert.equal(scope.sourceDeclarationReason, "retention-cap");
});
