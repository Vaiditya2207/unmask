import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evidenceAnchors,
  parsePackageDetails,
  preview,
} from "./package-details.ts";

const list = (items: unknown[] = [], omitted = 0) => ({
  items,
  total: items.length + omitted,
  returned: items.length,
  omitted,
  omissionReasons: omitted ? { "section-byte-cap": omitted } : {},
});
const fixture = () => ({
  detailsVersion: "1",
  reportSchemaVersion: "1",
  scope: { allCodeRead: false, safetyVerdict: "not-provided" },
  identity: list(),
  declarations: { status: "invalid", fields: list([], 1) },
  entrypoints: { targets: list() },
  dependencies: {
    categories: [
      {
        field: "dependencies",
        status: "invalid-type",
        declaredCount: null,
        entries: list(),
      },
    ],
    comparisons: [],
  },
  scripts: { entries: list(), bindingGyp: { files: list() } },
  inventory: {
    counts: { files: 3, bytes: 30, lowerBound: true },
    complete: false,
    files: list([], 3),
    typeGroups: list(),
    topDirectories: list(),
    largestFiles: list(),
    sourceOnlyPaths: list(),
  },
  capabilities: { groups: list(), observations: list() },
  provenance: { facts: list() },
  ai: {
    selection: { selectedGroups: null },
    metadata: list([{ status: "unavailable" }]),
    hypotheses: list(),
  },
  coverage: {
    counters: { complete: false, states: {} },
    observations: list([
      { type: "syntax-not-inspected", reason: "unsupported-syntax" },
    ]),
    failures: list([{ code: "entry-cap" }]),
    policyFindings: list(),
  },
});

test("details retain invalid, incomplete, unavailable and omitted states instead of claiming absence", () => {
  const d = parsePackageDetails(fixture());
  assert.ok(d);
  assert.equal(d.declarations.status, "invalid");
  assert.equal(d.dependencies.categories[0].declaredCount, null);
  assert.equal(d.inventory.complete, false);
  assert.equal(d.inventory.files.omitted, 3);
  assert.deepEqual(d.ai.metadata.items, [{ status: "unavailable" }]);
  assert.equal(d.coverage.observations.total, 1);
});

test("missing, malformed or future details fall back rather than presenting a partial invented contract", () => {
  assert.equal(parsePackageDetails({ status: "queued" }), null);
  assert.equal(
    parsePackageDetails({ ...fixture(), detailsVersion: "2" }),
    null,
  );
  assert.equal(
    parsePackageDetails({ ...fixture(), reportSchemaVersion: "2" }),
    null,
  );
  assert.equal(
    parsePackageDetails({ ...fixture(), identity: { ...list(), total: 1 } }),
    null,
  );
  assert.equal(parsePackageDetails({ ...fixture(), ai: null }), null);
  assert.equal(
    parsePackageDetails({ ...fixture(), scope: { allCodeRead: true } }),
    null,
  );
});

test("declarations have bounded previews and evidence links use trusted positional anchors", () => {
  const circular: Record<string, unknown> = {};
  circular.loop = circular;
  assert.ok(preview(circular).length < 601);
  assert.ok(preview("x".repeat(100000)).length <= 601);
  assert.equal(preview(undefined), "Not recorded");
  const anchors = evidenceAnchors({
    evidence: [
      { id: 'x" onclick=evil' },
      { id: 'x" onclick=evil' },
      { id: "second" },
      null,
    ],
  });
  assert.equal(anchors.get('x" onclick=evil'), "evidence-0");
  assert.equal(anchors.get("second"), "evidence-2");
  assert.equal(anchors.size, 2);
});

async function renderOverview(details: unknown, rawModel?: unknown) {
  const { readFile } = await import("node:fs/promises");
  const ts = await import("typescript");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const source = await readFile(
    new URL("../components/report/PackageDetailsView.tsx", import.meta.url),
    "utf8",
  );
  const compiled = ts
    .transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    })
    .outputText.replaceAll(
      '"react/jsx-runtime"',
      JSON.stringify(import.meta.resolve("react/jsx-runtime")),
    )
    .replaceAll(
      '"@/lib/package-details.ts"',
      JSON.stringify(new URL("./package-details.ts", import.meta.url).href),
    )
    .replaceAll(
      '"@/lib/report.ts"',
      JSON.stringify(new URL("./report.ts", import.meta.url).href),
    )
    .replaceAll(
      '"@/lib/vulnerabilities.ts"',
      JSON.stringify(new URL("./vulnerabilities.ts", import.meta.url).href),
    );
  const { PackageDetailsView } = await import(
    `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
  );
  return renderToStaticMarkup(
    createElement(PackageDetailsView, {
      details,
      id: "a".repeat(32),
      analyzer: "https://analyzer.invalid",
      anchors: new Map([["quote-id", "evidence-7"]]),
      rawModel,
    }),
  );
}

test("live details render semantic escaped sections, incomplete coverage and visible omission limits", async () => {
  const malicious = '<script>alert("not executable")</script>';
  const d = fixture();
  d.declarations.fields = list([
    {
      field: "description",
      status: "declared",
      value: malicious,
      evidenceIds: ["quote-id"],
    },
  ]);
  d.inventory.files = list(
    Array.from({ length: 80 }, (_, i) => ({
      path: `bounded-file-${i}`,
      size: i,
      state: "not-compared",
    })),
    5,
  );
  const details = parsePackageDetails(d);
  assert.ok(details);
  const html = await renderOverview(details);
  for (const heading of [
    "Purpose and publisher declarations",
    "Install hooks",
    "Entrypoints",
    "Direct dependency",
    "File composition",
    "Observed behavior",
    "Source comparison",
    "AI advisory",
    "Coverage, skipped",
    "Limits and checks",
  ])
    assert.ok(html.includes(heading), heading);
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes(malicious));
  assert.ok(html.includes("#evidence-7"));
  assert.ok(html.includes("Analysis coverage is incomplete"));
  assert.ok(html.includes("not a zero-vulnerability result"));
  assert.ok(html.includes("This page limits the view to 50"));
  assert.ok(html.includes("API omitted 5"));
  assert.ok(html.includes("bounded-file-49"));
  assert.ok(!html.includes("bounded-file-50"));
  assert.ok(html.includes('scope="col"'));
  assert.ok(html.includes('aria-labelledby="coverage-title"'));
  assert.ok(html.includes(`/api/reports/${"a".repeat(32)}/details`));
});

test("omitted details metadata can show explicitly attributed raw-report model identity", async () => {
  const d = fixture();
  d.ai.metadata = list([], 1);
  const html = await renderOverview(parsePackageDetails(d), {
    status: "complete",
    modelId: "fixture-model",
  });
  assert.ok(html.includes("fixture-model"));
  assert.ok(html.includes("shown from the raw report"));
  assert.ok(html.includes("API omitted 1"));
});

test("OSV rendering keeps partial failures distinct and escapes advisory data and links", async () => {
  const requested = { name: "example", version: "1.2.3" };
  const base = {
    schemaVersion: "1",
    source: "OSV",
    package: { ...requested, ecosystem: "npm" },
    queriedAt: "2026-10-31T20:41:39.100Z",
    status: "none-reported",
    complete: true,
    reasons: [],
    advisories: [],
    pagesFetched: 1,
    limits: {},
  };
  for (const [extra, phrase] of [
    [{}, "OSV reported no advisories"],
    [
      { status: "incomplete", complete: false, reasons: ["page-limit"] },
      "lookup is incomplete",
    ],
    [
      { status: "unavailable", complete: false, reasons: ["timeout"] },
      "lookup is unavailable",
    ],
  ] as const) {
    const d = {
      ...fixture(),
      identity: list([{ requested }]),
      vulnerabilityCheck: { ...base, ...extra },
    };
    const html = await renderOverview(parsePackageDetails(d));
    assert.ok(html.includes(phrase));
    assert.ok(html.includes("directly submitted exact npm package/version"));
    if (extra.status) assert.ok(!html.includes("OSV reported no advisories"));
  }
  const advisory = {
    id: "GHSA-test",
    summary: '<img src=x onerror="bad">',
    references: [
      { url: "javascript:alert(1)", type: "ADVISORY" },
      { url: "https://advisory.invalid/id", type: "ADVISORY" },
    ],
  };
  const d = {
    ...fixture(),
    identity: list([{ requested }]),
    vulnerabilityCheck: { ...base, status: "found", advisories: [advisory] },
  };
  const html = await renderOverview(parsePackageDetails(d));
  assert.ok(html.includes("&lt;img"));
  assert.ok(!html.includes("<img src=x"));
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(html.includes('href="https://advisory.invalid/id"'));
  assert.ok(html.includes('rel="noreferrer noopener"'));
});
