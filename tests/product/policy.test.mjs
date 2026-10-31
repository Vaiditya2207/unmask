import assert from "node:assert/strict";
import { test } from "node:test";
import { policyResult } from "../../src/core/policy.mjs";

function report() {
  return {
    inputs: { artifact: { sha256: "a".repeat(64), sha512: "b".repeat(128) } },
    source: {
      status: "selected",
      complete: true,
      method: "user-full-SHA",
      alternatives: [],
    },
    coverage: { complete: true, sourceComplete: true },
    manifests: {
      artifact: {
        status: "usable",
        value: { name: "pkg", version: "1.0.0" },
        evidenceIds: ["artifact-manifest"],
      },
      source: {
        status: "usable",
        value: { name: "pkg", version: "1.0.0" },
        evidenceIds: ["source-manifest"],
      },
      registry: { status: "unavailable" },
    },
    files: [],
    failures: [],
    model: { status: "disabled" },
  };
}
const ids = (value) => policyResult(value).findings.map((f) => f.ruleId);

test("only explicit identity claim conflicts trigger policy, not registry normalization", () => {
  const r = report();
  r.manifests.registry = {
    status: "usable",
    value: {
      name: "different",
      scripts: { install: "registry-only" },
      dependencies: {},
    },
  };
  assert.deepEqual(policyResult(r), { exitCode: 0, findings: [] });
  r.inputs.claim = { name: "other", version: "1.0.0" };
  assert.deepEqual(ids(r), ["identity-claim-conflict"]);
  assert.equal(policyResult(r).exitCode, 3);
});

test("computed artifact digest mismatch is a finding for either supported algorithm", () => {
  for (const [algorithm, length] of [
    ["sha256", 64],
    ["sha512", 128],
  ]) {
    const r = report();
    r.inputs.artifact.expectedIntegrity = {
      algorithm,
      digest: "c".repeat(length),
    };
    assert.deepEqual(ids(r), ["integrity-mismatch"]);
    r.inputs.artifact.expectedIntegrity.digest = r.inputs.artifact[algorithm];
    assert.equal(policyResult(r).exitCode, 0);
  }
});

test("parsed or unavailable provenance never masquerades as a failed cryptographic verifier", () => {
  const r = report();
  r.inputs.artifact.provenance = {
    status: "failed",
    verificationImplemented: false,
  };
  assert.deepEqual(ids(r), []);
  r.inputs.artifact.provenance.verificationImplemented = true;
  assert.deepEqual(ids(r), ["provenance-verification-failed"]);
});

for (const name of ["preinstall", "install", "postinstall"]) {
  test(`exact differing nonempty ${name} produces lifecycle-source-absent`, () => {
    const r = report();
    r.manifests.artifact.value.scripts = { [name]: "node changed.js" };
    r.manifests.source.value.scripts = { [name]: "node original.js" };
    assert.deepEqual(ids(r), ["lifecycle-source-absent"]);
    assert.deepEqual(policyResult(r).findings[0].evidenceIds, [
      "artifact-manifest",
      "source-manifest",
    ]);
    r.manifests.source.value.scripts[name] = "node changed.js";
    assert.deepEqual(ids(r), []);
    r.manifests.artifact.value.scripts[name] = "";
    assert.deepEqual(ids(r), []);
  });
}

test("missing, ambiguous or incomplete source cannot prove lifecycle absence", () => {
  for (const change of [
    (r) => {
      r.source.status = "unresolved";
    },
    (r) => {
      r.source.status = "conflicting";
    },
    (r) => {
      r.coverage.sourceComplete = false;
    },
    (r) => {
      r.manifests.source.status = "unavailable";
    },
    (r) => {
      r.manifests.artifact.status = "invalid";
    },
  ]) {
    const r = report();
    r.manifests.artifact.value.scripts = { install: "node install.js" };
    change(r);
    assert.deepEqual(ids(r), []);
  }
});

test("root artifact-only regular binding.gyp triggers implicit lifecycle unless suppressed", () => {
  const r = report();
  r.files = [
    { path: "binding.gyp", state: "artifact-only", evidenceIds: ["gyp"] },
  ];
  assert.deepEqual(ids(r), ["lifecycle-implicit-gyp"]);
  r.manifests.artifact.value.scripts = { postinstall: "" };
  assert.deepEqual(ids(r), ["lifecycle-implicit-gyp"]);
  for (const change of [
    (r) => {
      r.manifests.artifact.value.gypfile = false;
    },
    (r) => {
      r.manifests.artifact.value.scripts = { install: "node explicit.js" };
    },
    (r) => {
      r.manifests.artifact.value.scripts = { preinstall: "node explicit.js" };
    },
    (r) => {
      r.files[0].path = "nested/binding.gyp";
    },
    (r) => {
      r.files[0].state = "not-compared";
    },
    (r) => {
      r.coverage.sourceComplete = false;
    },
  ]) {
    const copy = structuredClone(r);
    change(copy);
    assert.equal(ids(copy).includes("lifecycle-implicit-gyp"), false);
  }
});

test("incomplete acquisition masks exit3 while findings remain, and all model states are isolated", () => {
  const r = report();
  r.inputs.claim = { name: "conflict", version: "1.0.0" };
  r.failures = [
    { code: "source-cap-exceeded", message: "Source inventory limited" },
  ];
  const expected = policyResult(r);
  assert.equal(expected.exitCode, 2);
  assert.deepEqual(
    expected.findings.map((f) => f.ruleId),
    ["identity-claim-conflict"],
  );
  for (const status of [
    "disabled",
    "timeout",
    "unavailable",
    "complete",
    "failed",
  ]) {
    r.model = {
      status,
      hypotheses: [{ ruleId: "lifecycle-source-absent", exitCode: 0 }],
    };
    assert.deepEqual(policyResult(r), expected);
  }
  r.failures = [];
  r.coverage.complete = false;
  assert.equal(policyResult(r).exitCode, 2);
});

test("absent source claim is completed artifact inspection and model-only failure is not incomplete", () => {
  const r = report();
  r.source.status = "unresolved";
  r.coverage.sourceComplete = false;
  r.manifests.source = { status: "unavailable" };
  r.model = { status: "timeout" };
  assert.equal(policyResult(r).exitCode, 0);
});

test("explicitly incomplete source selection cannot trigger an absence finding", () => {
  const r = report();
  r.source.complete = false;
  r.manifests.artifact.value.scripts = { install: "node changed.js" };
  assert.deepEqual(ids(r), []);
});

test("unavailable expected integrity is not a fabricated mismatch and supplied status cannot override digest", () => {
  const r = report();
  r.inputs.artifact.expectedIntegrity = { status: "unavailable" };
  assert.equal(policyResult(r).exitCode, 0);
  r.inputs.artifact.expectedIntegrity = {
    algorithm: "sha256",
    digest: "c".repeat(64),
    status: "match",
  };
  assert.deepEqual(ids(r), ["integrity-mismatch"]);
});
