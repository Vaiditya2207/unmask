import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { policyResult } from "../../src/core/policy.mjs";
import { compareInventories } from "../../src/core/compare.mjs";
import { createReport, validateReport } from "../../src/core/report.mjs";
import {
  inspectJavaScript,
  addSyntaxInspection,
} from "../../src/core/syntax.mjs";
import { buildPackageDetails } from "../../src/core/package-details.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
function fixture(value = {}) {
  const manifest = {
    name: "example",
    version: "1.2.3",
    description: "Declared purpose",
    license: "MIT",
    engines: { node: ">=24" },
    os: ["linux"],
    cpu: ["x64"],
    main: "index.js",
    module: "index.mjs",
    types: "index.d.ts",
    exports: { ".": { import: "./index.mjs", require: "./index.js" } },
    bin: { example: "./index.js" },
    browser: { "./index.js": "./web.js" },
    dependencies: { zeta: "^2", alpha: "1" },
    optionalDependencies: { opt: "3" },
    peerDependencies: { peer: "*" },
    devDependencies: { dev: "4" },
    bundledDependencies: ["alpha"],
    scripts: {
      test: "node test.js",
      install: "node setup.js",
      prepublishOnly: "npm test",
    },
    ...value,
  };
  const entries = Object.entries({
    "package.json": JSON.stringify(manifest),
    "index.js": 'fetch("https://example.invalid");',
    "binding.gyp": "{}",
    README: "hello",
    "types/index.d.ts": "declare const x: number;",
  }).map(([path, text]) => ({
    path,
    originalPath: `package/${path}`,
    type: "file",
    content: Buffer.from(text),
    size: Buffer.byteLength(text),
    sha256: sha(text),
    inspection: "retained",
  }));
  const artifact = {
    digest: { sha256: "a".repeat(64) },
    complete: true,
    entries,
    failures: [],
  };
  const comparison = compareInventories(artifact, null);
  const report = createReport({
    inputs: {
      artifact: { sha256: "a".repeat(64), sha512: "b".repeat(128) },
      claim: { name: "example", version: "1.2.3" },
      limits: { maxEntries: 20000 },
    },
    source: { status: "unresolved", method: "unresolved", alternatives: [] },
    comparison,
    manifests: {
      artifact: {
        status: "usable",
        value: manifest,
        evidenceIds: comparison.files.find((f) => f.path === "package.json")
          .evidenceIds,
      },
      source: { status: "unavailable" },
      registry: { status: "unavailable" },
    },
  });
  return addSyntaxInspection(report, inspectJavaScript(artifact, null));
}

test("package details separate publisher declarations from observed inventory and syntax", () => {
  const report = fixture();
  const before = JSON.stringify(report);
  const details = buildPackageDetails(report);
  assert.equal(details.detailsVersion, "1");
  assert.equal(details.reportSchemaVersion, "1");
  assert.equal(
    details.declarations.label,
    "publisher-declared; runtime behavior unverified",
  );
  const fields = new Map(
    details.declarations.fields.items.map((item) => [item.field, item]),
  );
  assert.equal(fields.get("description").value, "Declared purpose");
  assert.equal(fields.get("license").value, "MIT");
  assert.deepEqual(
    fields.get("exports").value,
    report.manifests.artifact.value.exports,
  );
  assert.equal(fields.get("exports").pointer, "/exports");
  const runtime = details.dependencies.categories.find(
    (item) => item.field === "dependencies",
  );
  assert.equal(runtime.declaredCount, 2);
  assert.deepEqual(
    runtime.entries.items.map((item) => item.name),
    ["alpha", "zeta"],
  );
  assert.equal(details.dependencies.transitive, "not-assessed");
  assert.equal(details.scripts.entries.total, 3);
  assert.equal(
    details.scripts.entries.items.find((item) => item.name === "install")
      .installHook,
    true,
  );
  assert.equal(details.scripts.bindingGyp.files.total, 1);
  assert.equal(details.inventory.files.total, 5);
  assert.equal(details.inventory.files.returned, 5);
  assert.equal(
    details.inventory.typeGroups.items.find((item) => item.extension === ".js")
      .files,
    1,
  );
  assert.equal(
    details.inventory.files.items.find((item) => item.path === "index.js")
      .state,
    "not-compared",
  );
  assert.ok(
    details.capabilities.observations.items.some(
      (item) => item.ruleId === "syntax-network-call",
    ),
  );
  const ids = new Set(report.evidence.map((item) => item.id));
  for (const item of [
    ...details.declarations.fields.items,
    ...details.inventory.files.items,
    ...details.capabilities.observations.items,
  ])
    for (const id of item.evidenceIds) assert.ok(ids.has(id));
  assert.equal(details.scope.safetyVerdict, "not-provided");
  assert.equal(details.scope.allCodeRead, false);
  assert.equal(JSON.stringify(report), before);
  assert.deepEqual(buildPackageDetails(report), details);
});

test("malformed declaration fields remain invalid rather than becoming empty declarations", () => {
  const details = buildPackageDetails(
    fixture({
      dependencies: ["x"],
      scripts: null,
      devDependencies: { x: 42 },
      bundledDependencies: true,
    }),
  );
  assert.equal(
    details.dependencies.categories.find(
      (item) => item.field === "dependencies",
    ).status,
    "invalid-type",
  );
  assert.equal(
    details.dependencies.categories.find(
      (item) => item.field === "devDependencies",
    ).entries.items[0].status,
    "invalid-type",
  );
  assert.equal(
    details.dependencies.categories.find(
      (item) => item.field === "bundledDependencies",
    ).status,
    "declared-all-runtime-dependencies",
  );
  assert.equal(details.scripts.status, "invalid-type");
  const report = fixture();
  report.manifests.artifact = { status: "invalid", reason: "invalid-json" };
  const invalid = buildPackageDetails(validateReport(report));
  assert.equal(invalid.declarations.status, "invalid");
  assert.equal(invalid.dependencies.categories[0].declaredCount, null);
});

test("details caps preserve exact counts, complete references and explicit omissions", () => {
  const report = fixture({ description: "😀".repeat(2000) });
  const details = buildPackageDetails(report, {
    maxItems: 2,
    maxValueBytes: 1024,
    maxSectionBytes: 2048,
    maxTotalBytes: 65536,
  });
  assert.equal(details.inventory.files.total, 5);
  assert.equal(details.inventory.files.returned, 2);
  assert.equal(details.inventory.files.omitted, 3);
  assert.ok(details.declarations.fields.omitted > 0);
  assert.ok(details.declarations.fields.omissionReasons["value-byte-cap"] > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(details)) <= 65536);
  assert.throws(
    () => buildPackageDetails(report, { maxItems: Infinity }),
    /limits/u,
  );
  assert.throws(() => buildPackageDetails({}), /report|Report/u);
});

test("incomplete coverage, skipped reasons and advisory model output survive projection", () => {
  const report = fixture();
  report.coverage.inventory.complete = false;
  report.coverage.inventory.lowerBound = true;
  report.coverage.complete = false;
  report.failures.push({ code: "entry-cap", message: "Entry limit reached" });
  report.model = {
    status: "complete",
    hypotheses: [
      {
        category: "unknown",
        explanation: "Synthetic advisory",
        uncertainty: "Not executed",
        alternative: "Intentional",
        citations: [
          {
            evidenceId: report.evidence[0].id,
            quote: report.evidence[0].excerpt.slice(0, 5),
          },
        ],
      },
    ],
    configHash: "c".repeat(64),
  };
  report.policy = policyResult(report);
  const details = buildPackageDetails(report);
  assert.equal(details.inventory.complete, false);
  assert.equal(details.coverage.counters.inventory.lowerBound, true);
  assert.ok(
    details.coverage.observations.items.some(
      (item) => item.reason === "unsupported-syntax",
    ),
  );
  assert.equal(details.coverage.failures.items[0].code, "entry-cap");
  assert.deepEqual(details.ai.hypotheses.items, report.model.hypotheses);
  assert.equal(details.ai.advisory, true);
});

test("exact entrypoint matching stays lexical and dependency deltas require complete evidence", () => {
  const report = fixture({
    exports: {
      ".": "./index.js",
      "./wild": "./*.js",
      "./escape": "../outside.js",
      "./missing": "./not-retained.js",
    },
  });
  let details = buildPackageDetails(report);
  const targets = new Map(
    details.entrypoints.targets.items.map((item) => [item.target, item]),
  );
  assert.equal(targets.get("./index.js").matchStatus, "exact-file-match");
  assert.equal(targets.get("./index.js").syntaxStatus, "observed-syntax-cues");
  assert.equal(
    targets.get("./*.js").matchStatus,
    "not-assessed-unsafe-or-pattern-target",
  );
  assert.equal(
    targets.get("../outside.js").matchStatus,
    "not-assessed-unsafe-or-pattern-target",
  );
  assert.equal(
    targets.get("./not-retained.js").matchStatus,
    "no-exact-match-in-accepted-inventory",
  );
  assert.equal(details.dependencies.comparisons[0].status, "not-assessed");
  report.inputs.registryDocument = { sha256: "d".repeat(64) };
  report.manifests.registry = {
    status: "usable",
    value: { dependencies: { alpha: "2", removed: "1" } },
    evidenceIds: [],
  };
  details = buildPackageDetails(report);
  const delta = details.dependencies.comparisons.find(
    (item) => item.side === "registry",
  );
  assert.equal(delta.status, "declared-values-compared");
  assert.deepEqual(
    delta.differences.items.map((item) => [item.name, item.change]),
    [
      ["alpha", "declared-value-differs"],
      ["removed", "registry-declared-only"],
      ["zeta", "artifact-declared-only"],
      ["opt", "artifact-declared-only"],
      ["peer", "artifact-declared-only"],
      ["dev", "artifact-declared-only"],
    ],
  );
  assert.equal(delta.differences.items[0].documentSha256, "d".repeat(64));
  assert.equal(
    details.inventory.topDirectories.items.find(
      (item) => item.directory === "types",
    ).files,
    1,
  );
  assert.equal(details.inventory.largestFiles.items[0].path, "package.json");
});

test("selection counts describe recorded groups separately from unchanged model coverage", () => {
  const report = fixture();
  report.model = {
    status: "complete",
    hypotheses: [],
    evidenceGroups: [
      { id: "synthetic-group", evidenceIds: [report.evidence[0].id] },
    ],
    omittedEvidenceGroups: [{ id: "omitted" }],
    omittedEvidenceIds: [report.evidence[1].id],
  };
  const details = buildPackageDetails(report);
  assert.equal(details.ai.selection.selectedGroups, 1);
  assert.equal(details.ai.selection.omittedGroups, 1);
  assert.equal(details.ai.selection.omittedEvidenceItems, 1);
  assert.deepEqual(
    details.coverage.counters.modelReviewed,
    report.coverage.modelReviewed,
  );
});

test("section and response byte caps bound large UTF-8 declarations without modifying source", () => {
  const dependencies = Object.fromEntries(
    Array.from({ length: 250 }, (_, index) => [
      `dep-${String(index).padStart(4, "0")}`,
      "😀".repeat(150),
    ]),
  );
  const report = fixture({
    dependencies,
    optionalDependencies: dependencies,
    peerDependencies: dependencies,
    devDependencies: dependencies,
    scripts: dependencies,
  });
  const before = JSON.stringify(report);
  const details = buildPackageDetails(report, {
    maxTotalBytes: 65536,
    maxSectionBytes: 16384,
  });
  assert.ok(Buffer.byteLength(JSON.stringify(details)) <= 65536);
  const categories = details.dependencies.categories;
  assert.equal(categories[0].declaredCount, 250);
  assert.ok(categories[0].entries.omissionReasons["section-byte-cap"] > 0);
  assert.ok(
    categories.some(
      (category) => category.entries.omissionReasons["response-byte-cap"] > 0,
    ),
  );
  for (const category of categories)
    assert.equal(
      category.entries.total,
      category.entries.returned + category.entries.omitted,
    );
  for (const category of categories)
    for (const item of category.entries.items)
      assert.equal(item.value, dependencies[item.name]);
  assert.equal(JSON.stringify(report), before);
});

test("details preserve recorded behavior suspicion cues with exact evidence and limits", () => {
  const report = fixture();
  const beforeEntrypoints = buildPackageDetails(report).entrypoints;
  const evidenceId = report.files.find(
    (file) => file.path === "types/index.d.ts",
  ).evidenceIds[0];
  const index = report.cues.length;
  report.cues.push({
    module: "behavior",
    ruleId: "behavior-install-remote-shell",
    priority: "HIGH",
    confidence: "suspicion-not-proof",
    summary: "Static suspicion; no execution observed.",
    evidenceIds: [evidenceId],
    signal: { tools: ["curl"], interpreter: "sh" },
  });
  const annotationIndex = report.annotations.length;
  report.annotations.push(
    {
      ruleId: "behavior-credential-path-reference",
      priority: "review",
      confidence: "suspicion-not-proof",
      evidenceIds: [evidenceId],
      summary: "Inert recorded path reference.",
    },
    {
      type: "behavior-scope",
      limits: { reviewCues: 128 },
      limitation: "Static observations only; not executed.",
    },
  );
  const snapshot = JSON.stringify(report);
  const details = buildPackageDetails(report);
  const high = details.capabilities.observations.items.find(
    (item) => item.ruleId === "behavior-install-remote-shell",
  );
  assert.ok(high, "recorded behavior cue is reachable in hosted details");
  assert.equal(high.priority, "HIGH");
  assert.equal(high.confidence, "suspicion-not-proof");
  assert.equal(high.cueRef, `/cues/${index}`);
  assert.deepEqual(high.evidenceIds, [evidenceId]);
  assert.equal(high.locations[0].evidenceId, evidenceId);
  assert.equal(high.locations[0].path, "types/index.d.ts");
  assert.equal(
    details.capabilities.observations.items.find(
      (item) => item.ruleId === "behavior-credential-path-reference",
    ).cueRef,
    `/annotations/${annotationIndex}`,
  );
  assert.ok(
    details.coverage.observations.items.some(
      (item) =>
        item.type === "behavior-scope" && item.limits.reviewCues === 128,
    ),
  );
  assert.deepEqual(
    details.entrypoints,
    beforeEntrypoints,
    "behavior references do not masquerade as syntax inspection",
  );
  assert.equal(details.scope.targetExecution, "not-performed");
  assert.equal(details.scope.safetyVerdict, "not-provided");
  assert.equal(JSON.stringify(report), snapshot);
});

test("behavior details use existing item caps and expose exact omitted observations", () => {
  const report = fixture();
  for (let index = 0; index < 12; index++)
    report.cues.push({
      module: "behavior",
      ruleId: "behavior-sensitive-environment-read",
      priority: "review",
      confidence: "suspicion-not-proof",
      evidenceIds: [report.evidence[0].id],
      summary: `Inert recorded cue ${index}`,
    });
  const details = buildPackageDetails(report, { maxItems: 2 });
  const group = details.capabilities.groups.items.find(
    (group) => group.ruleId === "behavior-sensitive-environment-read",
  );
  assert.ok(group);
  assert.equal(group.observations, 12);
  assert.equal(details.capabilities.observations.total, 13);
  assert.equal(details.capabilities.observations.returned, 2);
  assert.equal(details.capabilities.observations.omitted, 11);
  assert.equal(
    details.capabilities.observations.omissionReasons["item-cap"],
    11,
  );
  assert.ok(Buffer.byteLength(JSON.stringify(details)) <= 2097152);
});

test("details expose a structured model assessment only for completed model results", () => {
  const report = fixture();
  const unavailable = buildPackageDetails({
    ...report,
    model: { status: "unavailable", reason: "quota" },
  });
  assert.deepEqual(
    {
      status: unavailable.ai.assessment.status,
      source: unavailable.ai.assessment.source,
      reason: unavailable.ai.assessment.reason,
    },
    { status: "unavailable", source: "none", reason: "quota" },
  );
  assert.match(unavailable.ai.assessment.note, /not model output/);
  assert.equal(unavailable.ai.assessment.summary, undefined);
  const complete = buildPackageDetails({
    ...report,
    model: {
      status: "complete",
      summary: "One file was inventoried without a selected source.",
      hypotheses: [],
      assessment: {
        source: "model",
        uncertainty: "Source correspondence was not checked.",
        nextAction: "Locate the release commit.",
        checkedScope: {
          basis: "deterministic-prompt-selection",
          evidenceSupplied: 1,
          paths: ["package.json"],
          notChecked: ["runtime-behavior", "unselected-source"],
        },
      },
    },
  });
  assert.equal(complete.ai.assessment.source, "model");
  assert.match(complete.ai.assessment.note, /not a safety signal/);
  assert.equal(complete.ai.assessment.nextAction, "Locate the release commit.");
  assert.deepEqual(complete.ai.assessment.checkedScope.paths.items, [
    "package.json",
  ]);
  assert.deepEqual(complete.ai.assessment.checkedScope.notChecked, [
    "runtime-behavior",
    "unselected-source",
  ]);
  assert.throws(
    () =>
      validateReport({
        ...report,
        model: {
          status: "unavailable",
          assessment: { source: "model", nextAction: "x" },
        },
      }),
    /Model assessment requires a completed model result/,
  );
});
