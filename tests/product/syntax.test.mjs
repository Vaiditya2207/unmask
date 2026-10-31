import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import {
  inspectJavaScript,
  addSyntaxInspection,
} from "../../src/core/syntax.mjs";
import { compareInventories } from "../../src/core/compare.mjs";
import { createReport } from "../../src/core/report.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
function inventory(files, side = "artifact") {
  const entries = Object.entries(files).map(([name, body]) => {
    const content = Buffer.from(body);
    return {
      path: name,
      originalPath: `${side}/${name}`,
      type: "file",
      size: content.length,
      sha256: hash(content),
      content,
      inspection: "retained",
    };
  });
  return {
    digest: { sha256: hash(side), sha512: "b".repeat(128) },
    complete: true,
    failures: [],
    entries,
  };
}

test("syntax evidence locates a network call after multibyte text without executing it", () => {
  const artifact = inventory({
    "main.js":
      "const label='🐾'; fetch('https://collector.invalid/log'); globalThis.__unmaskExecuted = true;",
  });
  const inspected = inspectJavaScript(artifact, null);
  const cue = inspected.cues.find((c) => c.ruleId === "syntax-network-call");
  assert.ok(cue);
  const evidence = inspected.evidence.find((e) => e.id === cue.evidenceIds[0]);
  assert.equal(
    artifact.entries[0].content.subarray(...evidence.range).toString(),
    "fetch('https://collector.invalid/log')",
  );
  assert.equal(evidence.excerpt, "fetch('https://collector.invalid/log')");
  assert.equal(globalThis.__unmaskExecuted, undefined);
  assert.deepEqual(inspected.coverage, {
    files: 1,
    bytes: artifact.entries[0].size,
  });
});

test("strings and comments containing dangerous text produce no capability call", () => {
  const inspected = inspectJavaScript(
    inventory({
      "main.js": "// fetch('https://x.invalid')\nconst text = 'eval(code)';",
    }),
    null,
  );
  assert.equal(inspected.cues.length, 0);
});

test("source literal matches carry source evidence and novelty is scoped to inspected bytes", () => {
  const artifact = inventory({
    "bundle.js": "fetch('https://same.invalid');fetch('https://new.invalid');",
  });
  const source = inventory(
    {
      "entry.js": "fetch('https://same.invalid');",
      "unsupported.ts": "const url:string='https://new.invalid';",
    },
    "source",
  );
  const inspected = inspectJavaScript(artifact, source);
  const calls = inspected.cues.filter(
    (c) => c.ruleId === "syntax-network-call",
  );
  assert.equal(calls[0].literalStatus, "found-in-inspected-source");
  assert.ok(
    calls[0].evidenceIds.some(
      (id) => inspected.evidence.find((e) => e.id === id)?.side === "source",
    ),
  );
  assert.equal(calls[1].literalStatus, "not-found-in-inspected-source");
  assert.ok(
    inspected.annotations.some(
      (a) =>
        a.side === "source" &&
        a.path === "unsupported.ts" &&
        a.reason === "unsupported-syntax",
    ),
  );
});

test("invalid syntax and bounded parsing remain visibly uninspected", () => {
  const bad = inspectJavaScript(
    inventory({ "bad.js": "function {", "large.js": "x;".repeat(100) }),
    null,
    { fileBytes: 100 },
  );
  assert.equal(bad.coverage.files, 0);
  assert.ok(bad.annotations.some((a) => a.reason === "parse-failed"));
  assert.ok(bad.annotations.some((a) => a.reason === "syntax-file-cap"));
  const capped = inspectJavaScript(
    inventory({ "a.js": "a();b();c();" }),
    null,
    { tokens: 3 },
  );
  assert.equal(capped.coverage.files, 0);
  assert.ok(capped.annotations.some((a) => a.reason === "syntax-token-cap"));
});

test("syntax augmentation preserves byte states and policy while validating bound evidence", () => {
  const artifact = inventory({ "a.js": "eval('code');" });
  const comparison = compareInventories(artifact, null);
  const original = createReport({
    inputs: { artifact: artifact.digest, limits: { entries: 20000 } },
    source: { status: "unresolved", method: "unresolved", alternatives: [] },
    comparison,
    manifests: {
      artifact: { status: "unavailable" },
      source: { status: "unavailable" },
      registry: { status: "unavailable" },
    },
  });
  const snapshot = JSON.stringify(original);
  const updated = addSyntaxInspection(
    original,
    inspectJavaScript(artifact, null),
  );
  assert.equal(updated.files[0].state, "not-compared");
  assert.deepEqual(updated.policy, original.policy);
  assert.equal(updated.coverage.syntaxInspected.files, 1);
  assert.ok(updated.cues.some((cue) => cue.ruleId === "syntax-dynamic-code"));
  assert.equal(JSON.stringify(original), snapshot);
});

test("unknown or truncated source syntax cannot establish literal novelty", () => {
  const artifact = inventory({ "main.js": "fetch('https://new.invalid');" });
  for (const [source, limits] of [
    [
      inventory(
        { "main.ts": "const url:string='https://new.invalid';" },
        "source",
      ),
      {},
    ],
    [
      inventory({ "main.js": "const a='first';const b='second';" }, "source"),
      { sourceLiterals: 1 },
    ],
    [
      inventory(
        { "main.js": "function {", "other.js": "const a='known';" },
        "source",
      ),
      {},
    ],
  ]) {
    const result = inspectJavaScript(artifact, source, limits);
    assert.equal(result.cues[0].literalStatus, "not-assessed");
  }
});

test("only byte-identical files downgrade capabilities to observations", () => {
  const source = inventory(
    { "a.js": "fetch('https://known.invalid'); const version=1;" },
    "source",
  );
  for (const [body, expectedCues, expectedUnchanged] of [
    ["fetch('https://known.invalid'); const version=1;", 0, true],
    ["fetch('https://known.invalid'); const version=2;", 1, false],
  ]) {
    const artifact = inventory({ "a.js": body });
    const original = createReport({
      inputs: {
        artifact: artifact.digest,
        sourceArchive: source.digest,
        limits: { entries: 20000 },
      },
      source: { status: "selected", method: "user-full-SHA", alternatives: [] },
      comparison: compareInventories(artifact, source),
      manifests: {
        artifact: { status: "unavailable" },
        source: { status: "unavailable" },
        registry: { status: "unavailable" },
      },
    });
    const result = addSyntaxInspection(
      original,
      inspectJavaScript(artifact, source),
    );
    assert.equal(result.cues.length, expectedCues);
    assert.equal(
      result.annotations.some((item) => item.type === "unchanged-capability"),
      expectedUnchanged,
    );
  }
});

test("legal long member chains do not recurse beyond the parser's bounded input", () => {
  const artifact = inventory({
    "long.js": "root" + ".member".repeat(20000) + ";",
  });
  const result = inspectJavaScript(artifact, null);
  assert.equal(result.coverage.files, 1);
  assert.equal(result.cues.length, 0);
});

test("direct require-member process calls remain inert and carry exact argument evidence", () => {
  const artifact = inventory({
    "bundle.js":
      "if(false)require('node:child_process').exec('echo UNMASK_FIXTURE');",
  });
  const result = inspectJavaScript(artifact, null);
  const cue = result.cues.find(
    (item) => item.ruleId === "syntax-process-execution",
  );
  assert.ok(cue);
  assert.equal(
    result.evidence.find((item) => item.id === cue.evidenceIds[0]).excerpt,
    "require('node:child_process').exec('echo UNMASK_FIXTURE')",
  );
});

for (const [name, call, ruleId] of [
  ["fetch", "fetch('https://new.invalid')", "syntax-network-call"],
  [
    "direct require process",
    "require('node:child_process').exec('echo INERT')",
    "syntax-process-execution",
  ],
]) {
  test(`uncommented ${name} retains its changed-file capability cue`, () => {
    const source = inventory({ "main.js": `//${call};\n` }, "source");
    const artifact = inventory({ "main.js": `  ${call};\n` });
    const comparison = compareInventories(artifact, source);
    assert.equal(comparison.files[0].state, "changed");
    assert.deepEqual(comparison.files[0].spans.artifact, [0, 2]);
    assert.equal(inspectJavaScript(source, null).cues.length, 0);
    const report = createReport({
      inputs: {
        artifact: {
          ...artifact.digest,
          expectedIntegrity: { algorithm: "sha256", digest: "c".repeat(64) },
        },
        sourceArchive: source.digest,
        limits: { entries: 20000 },
      },
      source: { status: "selected", method: "user-full-SHA", alternatives: [] },
      comparison,
      manifests: {
        artifact: { status: "unavailable" },
        source: { status: "unavailable" },
        registry: { status: "unavailable" },
      },
    });
    const updated = addSyntaxInspection(
      report,
      inspectJavaScript(artifact, source),
    );
    assert.equal(updated.cues.filter((cue) => cue.ruleId === ruleId).length, 1);
    assert.equal(
      updated.annotations.some((item) => item.type === "unchanged-capability"),
      false,
    );
    assert.equal(updated.policy.exitCode, 3);
    assert.deepEqual(updated.policy, report.policy);
    const evidence = updated.evidence.find(
      (e) => e.id === updated.cues[0].evidenceIds[0],
    );
    assert.equal(
      artifact.entries[0].content.subarray(...evidence.range).toString(),
      call,
    );
  });
}
