import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { renderReport } from "../../src/viewer/render.mjs";

function report() {
  return {
    inputs: {
      artifact: { sha256: "a".repeat(64) },
      claim: { name: "example", version: "1.0.0" },
    },
    source: { status: "unresolved", method: "unresolved" },
    files: [
      {
        path: "index.js",
        originalPath: "package/index.js",
        size: 12,
        state: "not-compared",
        reason: "source-unavailable",
        artifactSha256: "b".repeat(64),
      },
    ],
    coverage: {
      inventory: { files: 1, bytes: 12, complete: true },
      states: { "not-compared": { files: 1, bytes: 12 } },
      compared: { files: 0, bytes: 0 },
      complete: false,
    },
    evidence: [],
    cues: [],
    failures: [],
    annotations: [],
    policy: { exitCode: 0, findings: [] },
    model: { status: "disabled" },
  };
}

test("viewer preserves unknown correspondence and complete-report semantics", () => {
  const html = renderReport(report());
  assert.match(html, /Review evidence for example@1\.0\.0/);
  assert.match(html, /source-unavailable/);
  assert.match(html, /not-compared/);
  assert.match(html, /Model is disabled/);
  assert.match(html, /Completed report/);
  assert.match(html, /not a safety verdict/);
  assert.match(html, new RegExp("a".repeat(64)));
});

test("viewer renders every target-controlled field as escaped text", () => {
  const input = report();
  const attack =
    '<img src=x onerror="alert(1)"></script><script>alert(2)</script>';
  input.inputs.claim.name = attack;
  input.files[0].path = attack;
  input.files[0].reason = attack;
  input.evidence = [
    {
      id: "e1",
      path: attack,
      side: "artifact",
      range: [0, attack.length],
      excerpt: attack,
    },
  ];
  input.model = {
    status: "complete",
    hypotheses: [{ explanation: attack, evidenceIds: ["e1"] }],
  };
  const html = renderReport(input);
  assert.doesNotMatch(html, /<img src=x|<script>alert\(2\)/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.equal([...html.matchAll(/<script>/g)].length, 1);
});

test("CSP permits only exact trusted static script and styles, no network", () => {
  const html = renderReport(report());
  for (const tag of ["script", "style"]) {
    const match = html.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
    assert.ok(match, `trusted ${tag} asset is present`);
    const content = match[1];
    const hash = createHash("sha256").update(content).digest("base64");
    assert.ok(html.includes(`sha256-${hash}`));
  }
  assert.match(html, /default-src &#39;none&#39;/);
  assert.match(html, /connect-src &#39;none&#39;/);
  assert.doesNotMatch(html, /(?:src|href)="https?:/);
});

test("incomplete reports retain policy findings and avoid percentage claims", () => {
  const input = report();
  input.coverage.inventory.complete = false;
  input.coverage.inventory.lowerBound = true;
  input.policy = {
    exitCode: 2,
    findings: [{ ruleId: "identity-claim-conflict", evidenceIds: [] }],
  };
  input.failures = [
    { code: "expanded-limit", message: "Archive limit reached" },
  ];
  const html = renderReport(input);
  assert.match(html, /Incomplete analysis/);
  assert.match(html, /identity-claim-conflict/);
  assert.match(html, /known lower bound/);
  assert.match(html, /expanded-limit/);
  const content = html.replace(/<(style|script)>[\s\S]*?<\/\1>/g, "");
  assert.doesNotMatch(content, /\d+(?:\.\d+)?%/);
});

test("rendering does not mutate deterministic or model evidence", () => {
  const input = report();
  const before = JSON.stringify(input);
  renderReport(input);
  assert.equal(JSON.stringify(input), before);
});

test("bound evidence is emitted once and prefixless files cite only their IDs", () => {
  const input = report();
  input.files = [];
  input.evidence = [];
  let pathReads = 0;
  for (let i = 0; i < 200; i++) {
    input.files.push({
      path: null,
      originalPath: `prefixless${i}.js`,
      size: 1,
      state: "not-compared",
      evidenceIds: [`ev-${i}`],
    });
    input.evidence.push({
      id: `ev-${i}`,
      get path() {
        pathReads++;
        return null;
      },
      originalPath: `prefixless${i}.js`,
      side: "artifact",
      range: [0, 1],
      excerptRange: [0, 1],
      excerpt: `ONLY_${i}_END`,
    });
  }
  const html = renderReport(input);
  assert.equal([...html.matchAll(/class="evidence"/g)].length, 200);
  assert.equal(html.split("ONLY_0_END").length - 1, 1);
  assert.ok(
    pathReads < 200 * 20,
    `evidence lookup must be linear; read ${pathReads} paths`,
  );
  const first = html.match(/<details class="file">[\s\S]*?<\/details>/)[0];
  assert.match(first, /href="#evidence-0"/);
  assert.doesNotMatch(first, /href="#evidence-1"/);
  assert.match(html, /id="evidence-0"/);
});

test("excerpt provenance shows actual bytes and caps displayed UTF-8 at 512 bytes", () => {
  const input = report();
  input.files[0].evidenceIds = ["long"];
  input.evidence = [
    {
      id: "long",
      side: "artifact",
      path: "index.js",
      originalPath: "package/index.js",
      range: [0, 4096],
      excerptRange: [0, 1200],
      excerpt: "é".repeat(600),
    },
  ];
  const html = renderReport(input);
  assert.match(html, /Evidence byte range[^<]*\[0, 4096\)/);
  assert.match(html, /Shown excerpt byte range[^<]*\[0, 512\)/);
  assert.match(html, /512 bytes per evidence item/);
  assert.match(html, /not displayed/);
  const excerpt = html.match(/<pre>([\s\S]*?)<\/pre>/)[1];
  assert.equal(Buffer.byteLength(excerpt), 512);
});

test("syntax cues have a separate suggested-review panel and paired bound citations", () => {
  const input = report();
  input.files[0].evidenceIds = ["artifact", "source"];
  input.evidence = [
    {
      id: "artifact",
      side: "artifact",
      path: "index.js",
      range: [0, 4],
      excerptRange: [0, 4],
      excerpt: "exec",
    },
    {
      id: "source",
      side: "source",
      path: "index.js",
      range: [0, 4],
      excerptRange: [0, 4],
      excerpt: "exec",
    },
  ];
  input.cues = [
    {
      ruleId: "syntax-process-execution",
      priority: "review",
      summary: "Process call observed",
      literalStatus: "not-found-in-inspected-source",
      evidenceIds: ["artifact", "source"],
    },
  ];
  const html = renderReport(input);
  const panel = html.match(
    /<section[^>]*><h2>Review suggested<\/h2>[\s\S]*?<\/section>/,
  )[0];
  assert.match(panel, /syntax-process-execution/);
  assert.match(panel, /Process call observed/);
  assert.match(panel, /not-found-in-inspected-source/);
  assert.match(panel, /Artifact/);
  assert.match(panel, /Source/);
  assert.match(panel, /href="#evidence-0"/);
  assert.match(panel, /href="#evidence-1"/);
  assert.doesNotMatch(html, /risk score|safety grade|safe package/i);
  for (const status of [
    "found-in-inspected-source",
    "source-unavailable",
    "no-static-literal",
  ]) {
    input.cues[0].literalStatus = status;
    assert.ok(renderReport(input).includes(status));
  }
});

test("incomplete status dominates findings and syntax suggestions", () => {
  const input = report();
  input.policy = {
    exitCode: 2,
    findings: [{ ruleId: "integrity-mismatch", evidenceIds: [] }],
  };
  input.cues = [
    {
      ruleId: "syntax-network-call",
      priority: "review",
      summary: "Observed call",
      literalStatus: "source-unavailable",
      evidenceIds: [],
    },
  ];
  const html = renderReport(input);
  assert.match(
    html,
    /<span class="status attention">Incomplete analysis<\/span>/,
  );
  assert.match(html, /<h2>Review required<\/h2>/);
  assert.match(html, /<h2>Review suggested<\/h2>/);
  assert.ok(
    html.indexOf("Incomplete analysis") < html.indexOf("<h2>Review required"),
  );
});

test("inspection scope, inert links and source-only files remain visible and escaped", () => {
  const input = report();
  const attack = "<img src=x onerror=alert(1)>";
  input.coverage.syntaxInspected = { files: 0, bytes: 0 };
  input.coverage.modelReviewed = { files: 0, bytes: 0 };
  input.coverage.links = { artifact: 1, source: 0 };
  input.coverage.linkEntries = [
    {
      side: "artifact",
      path: "link.js",
      originalPath: "package/link.js",
      type: "symlink",
      linkTarget: attack,
    },
  ];
  input.coverage.sourceOnly = ["source-only.ts"];
  input.annotations = [
    {
      code: "syntax-not-inspected",
      path: "unsupported.tsx",
      reason: "unsupported-ts-jsx",
    },
    {
      code: "syntax-scope",
      message: "Sourcemaps are not executed or used to establish equivalence.",
    },
  ];
  input.cues = [
    {
      ruleId: "syntax-dynamic-code",
      summary: attack,
      literalStatus: "no-static-literal",
      evidenceIds: [],
    },
  ];
  const html = renderReport(input);
  for (const text of [
    "Syntax inspected",
    "Model reviewed",
    "link.js",
    "source-only.ts",
    "syntax-not-inspected",
    "unsupported.tsx",
    "unsupported-ts-jsx",
    "syntax-scope",
    "Sourcemaps",
  ])
    assert.ok(html.includes(text), text);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img/);
});

test("large ledgers have a disclosed HTML display bound and preserve valid closing markup", () => {
  const input = report();
  input.files = Array.from({ length: 5000 }, (_, i) => ({
    path: `${"&".repeat(4000)}${i}.js`,
    originalPath: "&".repeat(4000),
    size: 0,
    state: "not-compared",
    evidenceIds: [],
  }));
  const html = renderReport(input);
  assert.ok(Buffer.byteLength(html) < 16 * 1024 * 1024);
  assert.match(html, /HTML display limit/);
  assert.match(html, /full JSON report/);
  assert.ok(html.endsWith("</body></html>"));
});

test("hostile cue and annotation fields stay text and cannot create fragment targets", () => {
  const input = report();
  const attack = '\"><img src=x onerror=alert(1)><script>bad</script>';
  input.evidence = [
    {
      id: attack,
      side: "artifact",
      path: attack,
      originalPath: attack,
      range: [0, 4],
      excerptRange: [0, 4],
      excerpt: "safe",
    },
  ];
  input.files[0].evidenceIds = [attack];
  input.cues = [
    {
      ruleId: attack,
      priority: attack,
      summary: attack,
      literalStatus: attack,
      evidenceIds: [attack],
    },
  ];
  input.annotations = [
    {
      code: attack,
      path: attack,
      reason: attack,
      message: attack,
      evidenceIds: [attack],
    },
  ];
  const html = renderReport(input);
  assert.doesNotMatch(html, /<img|<script>bad|href="javascript:|id="&quot;/);
  assert.match(html, /&lt;img/);
  assert.match(html, /href="#evidence-0"/);
  assert.equal([...html.matchAll(/<script>/g)].length, 1);
  const before = JSON.stringify(input);
  renderReport(input);
  assert.equal(JSON.stringify(input), before);
});

test("all populated sections together stay below the HTML response bound", () => {
  const input = report(),
    large = "&".repeat(4000);
  input.inputs.claim.name = large;
  input.source.commit = large;
  input.source.status = large;
  input.source.method = large;
  input.files = Array.from({ length: 1000 }, (_, i) => ({
    path: `${large}${i}`,
    originalPath: large,
    size: 1,
    state: "not-compared",
    evidenceIds: ["sample"],
  }));
  input.evidence = Array.from({ length: 1000 }, (_, i) => ({
    id: `e${i}`,
    path: large,
    originalPath: large,
    side: "artifact",
    range: [0, 512],
    excerptRange: [0, 512],
    excerpt: "&".repeat(512),
    blobDigest: large,
    fileSha256: large,
  }));
  input.policy.findings = Array(1000).fill({
    ruleId: large,
    message: large,
    evidenceIds: [],
  });
  input.failures = Array(1000).fill({ code: large, message: large });
  input.cues = Array(1000).fill({
    ruleId: large,
    summary: large,
    literalStatus: large,
    evidenceIds: [],
  });
  input.annotations = Array(1000).fill({
    code: large,
    path: large,
    message: large,
  });
  input.coverage.linkEntries = Array(1000).fill({
    side: "artifact",
    path: large,
    originalPath: large,
    type: "symlink",
    linkTarget: large,
  });
  input.coverage.sourceOnly = Array(1000).fill(large);
  input.model = {
    status: "complete",
    hypotheses: Array(1000).fill({ explanation: large, evidenceIds: [] }),
  };
  const html = renderReport(input);
  assert.ok(Buffer.byteLength(html) < 16 * 1024 * 1024);
  assert.match(html, /HTML display limit/);
  assert.ok(html.endsWith("</body></html>"));
});

test("source-only display notices remain outside the native path list", () => {
  const input = report();
  input.coverage.sourceOnly = Array(1000).fill("&".repeat(4000));
  const html = renderReport(input);
  const section = html.match(
    /<section><h2>Source-only paths<\/h2>([\s\S]*?)<\/section>/,
  )[1];
  assert.match(section, /HTML display limit/);
  const list = section.match(/<ul>([\s\S]*?)<\/ul>/)[1];
  assert.doesNotMatch(list, /<p/);
});

test("current syntax producer annotation types and scope limitations are visible", () => {
  const input = report();
  input.annotations = [
    {
      type: "syntax-not-inspected",
      side: "artifact",
      path: "unsupported.tsx",
      originalPath: "package/unsupported.tsx",
      reason: "unsupported-syntax",
    },
    {
      type: "syntax-scope",
      parser: "acorn@8.19.0",
      sourceCoverage: { files: 2, bytes: 256 },
      sourceLiteralCount: 3,
      sourceLiteralTruncated: true,
      limitation:
        "TypeScript, JSX, source maps and dynamic targets are not resolved.",
    },
  ];
  const html = renderReport(input);
  for (const value of [
    "syntax-not-inspected",
    "syntax-scope",
    "unsupported.tsx",
    "unsupported-syntax",
    "acorn@8.19.0",
    "TypeScript, JSX, source maps",
    "Source syntax inspected",
    "256 bytes",
    "Source literal inventory was truncated",
  ])
    assert.ok(html.includes(value), value);
});

test("empty panels use neutral headings while populated policy and cue panels retain review labels", () => {
  const input = report();
  let html = renderReport(input);
  assert.match(html, /<h2>Policy findings<\/h2>/);
  assert.match(html, /<h2>Review observations<\/h2>/);
  assert.doesNotMatch(
    html,
    /<h2>Review required<\/h2>|<h2>Review suggested<\/h2>/,
  );
  input.policy.findings = [{ ruleId: "integrity-mismatch", evidenceIds: [] }];
  input.cues = [
    {
      ruleId: "manifest-dependency-change",
      priority: "review",
      summary: "Manifest observation",
      evidenceIds: [],
    },
  ];
  html = renderReport(input);
  assert.match(html, /<h2>Review required<\/h2>/);
  assert.match(html, /<h2>Review suggested<\/h2>/);
  assert.doesNotMatch(html, /Source literal status unavailable/);
});
