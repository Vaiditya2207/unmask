import assert from "node:assert/strict";
import { test } from "node:test";
import { createGemmaClient } from "../../src/model/client.mjs";
import { SIGNALS, evidenceSignal } from "../../src/model/diff-evidence.mjs";

const artifactManifest =
  '{"name":"demo","description":"new words","scripts":{"postinstall":"node x.js"},"dependencies":{"helper":"1.0.0"},"bin":{"demo":"cli.js"}}';
const sourceManifest = '{"name":"demo","description":"old words"}';
const piece = (id, side, path, excerpt, start = 0) => ({
  id,
  side,
  path,
  range: [start, start + Buffer.byteLength(excerpt)],
  excerpt,
});
function crowdedReport() {
  const evidence = [
    piece("manifest-a", "artifact", "package.json", artifactManifest),
    piece("manifest-s", "source", "package.json", sourceManifest),
  ];
  const files = [{ path: "package.json", state: "changed" }];
  for (let i = 0; i < 12; i++) {
    const path = `lib/file-${String(i).padStart(2, "0")}.js`;
    const a = piece(`a-${i}`, "artifact", path, `value ${i} new`, 10);
    const s = piece(`s-${i}`, "source", path, `value ${i} old`, 10);
    evidence.push(a, s);
    files.push({
      path,
      state: "changed",
      spans: { artifact: a.range, source: s.range },
      evidenceIds: [a.id, s.id],
    });
  }
  const cue = (ruleId, field) => ({
    module: "manifest",
    ruleId,
    field,
    evidenceIds: ["manifest-a", "manifest-s"],
  });
  return {
    inputs: { artifact: { kind: "local" } },
    evidence,
    files,
    cues: [
      cue("manifest-runtime-field-difference", "/description"),
      cue("manifest-entrypoint-source-absent", "/bin/demo"),
      cue("manifest-runtime-dependency-added", "/dependencies/helper"),
      cue("manifest-lifecycle-source-absent", "/scripts/postinstall"),
    ],
    policy: { exitCode: 0, findings: [] },
    model: { status: "disabled" },
    run: {},
  };
}
// Answers with exactly the output keys the prompt requests, so fixtures follow the current contract.
function modelOutput(prompt, hypothesis) {
  const optional = {
    summary: "Fixture summary of the supplied scope and evidence.",
    assessment: {
      uncertainty: "Runtime behavior was not observed.",
      nextAction: "Review the cited install hook text.",
    },
  };
  return Object.fromEntries(
    Object.keys(prompt.output).map((key) => [
      key,
      key === "hypotheses" ? [hypothesis] : optional[key],
    ]),
  );
}
async function explainWithPrompt(
  report,
  citations = [{ evidenceId: "manifest-a", quote: '"node x.js"' }],
  limits = {},
) {
  let prompt;
  const section = await createGemmaClient({
    apiKey: "test-only-key",
    modelId: "gemma-4-26b-a4b-it",
    quotaVerified: true,
    dailyRequests: 20,
    requestsPerMinute: 20,
    inputTokensPerMinute: 20000,
    totalMs: 90000,
    ...limits,
    fetchImpl: async (url, options) => {
      prompt = JSON.parse(JSON.parse(options.body).contents[0].parts[0].text);
      if (url.endsWith(":countTokens"))
        return new Response('{"totalTokens":300}');
      const hypothesis = {
        category: "review-concern",
        explanation: "The artifact declares an install hook requiring review.",
        uncertainty: "Execution was not observed.",
        alternative: "This may be intentional packaging.",
        citations,
      };
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { text: JSON.stringify(modelOutput(prompt, hypothesis)) },
                ],
              },
            },
          ],
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    },
  }).explain(report, { allowLocal: true });
  return { section, prompt };
}

test("risk signals classify lifecycle, dependency, executable, network and secret access", () => {
  const cases = [
    [{ ruleId: "lifecycle-source-absent" }, "lifecycle"],
    [{ ruleId: "lifecycle-implicit-gyp" }, "lifecycle"],
    [
      {
        ruleId: "manifest-runtime-field-difference",
        module: "manifest",
        field: "/scripts/preinstall",
      },
      "lifecycle",
    ],
    [
      {
        ruleId: "manifest-registry-runtime-divergence",
        module: "manifest",
        field: "/optionalDependencies/x",
      },
      "dependency",
    ],
    [
      {
        ruleId: "manifest-runtime-field-difference",
        module: "manifest",
        field: "/exports/./index",
      },
      "executable",
    ],
    [{ ruleId: "syntax-process-execution" }, "executable"],
    [{ ruleId: "syntax-dynamic-code" }, "executable"],
    [{ ruleId: "syntax-network-call" }, "network"],
    [{ ruleId: "syntax-environment-access" }, "environment-access"],
    [
      {
        ruleId: "manifest-runtime-field-difference",
        module: "manifest",
        field: "/description",
      },
      null,
    ],
    [
      {
        ruleId: "manifest-runtime-field-difference",
        module: "manifest",
        field: "/scripts/test",
      },
      null,
    ],
    [{ ruleId: "comparison-spans" }, null],
    [{ ruleId: "behavior-install-remote-shell" }, "lifecycle"],
    [{ ruleId: "behavior-encoded-dynamic-code" }, "executable"],
    [{ ruleId: "behavior-process-remote-shell" }, "executable"],
    [{ ruleId: "behavior-sensitive-environment-read" }, "secret-access"],
    [{ ruleId: "behavior-unknown-future-rule" }, null],
  ];
  for (const [input, expected] of cases)
    assert.equal(evidenceSignal(input)?.signal ?? null, expected, input.field);
});

test("lifecycle, dependency and executable manifest changes outrank generic metadata and bulk hunks", async () => {
  const { section, prompt } = await explainWithPrompt(crowdedReport());
  assert.equal(section.status, "complete");
  assert.deepEqual(
    prompt.evidenceGroups
      .slice(0, 3)
      .map((group) => [group.ruleId, group.signal]),
    [
      ["manifest-lifecycle-source-absent", "lifecycle"],
      ["manifest-runtime-dependency-added", "dependency"],
      ["manifest-entrypoint-source-absent", "executable"],
    ],
  );
  assert.deepEqual(
    section.evidenceGroups.slice(0, 3).map((group) => group.signal),
    ["lifecycle", "dependency", "executable"],
  );
  assert.deepEqual(
    prompt.evidence.slice(0, 2).map((e) => e.id),
    ["manifest-a", "manifest-s"],
  );
  assert.ok(
    section.omittedEvidenceGroups.every((group) => !group.signal),
    "no signalled group is dropped while generic groups remain",
  );
  const generic = prompt.evidenceGroups.findIndex(
    (group) => group.ruleId === "manifest-runtime-field-difference",
  );
  assert.ok(generic === -1 || generic > 2);
  assert.ok(
    section.omittedEvidenceGroups.some((group) => group.kind === "comparison"),
  );
  assert.match(prompt.task, /signal groups/u);
  assert.equal(prompt.promptVersion, "diff-3");
});

test("signal ranking keeps policy first and orders capability cues by signal", async () => {
  const report = crowdedReport();
  report.evidence.push(
    piece("env", "artifact", "aaa.js", "process.env.NPM_TOKEN"),
    piece("net", "artifact", "zzz.js", 'fetch("https://x.test")'),
  );
  report.files.push(
    { path: "aaa.js", state: "byte-identical" },
    { path: "zzz.js", state: "byte-identical" },
  );
  report.cues.push(
    { ruleId: "syntax-environment-access", evidenceIds: ["env"] },
    {
      ruleId: "syntax-network-call",
      literalStatus: "found-in-inspected-source",
      evidenceIds: ["net"],
    },
  );
  report.policy.findings = [
    {
      ruleId: "lifecycle-source-absent",
      evidenceIds: ["manifest-a", "manifest-s"],
    },
  ];
  const { section, prompt } = await explainWithPrompt(report);
  assert.equal(section.status, "complete");
  const groups = prompt.evidenceGroups;
  assert.deepEqual([groups[0].kind, groups[0].signal], ["policy", undefined]);
  const ranks = groups
    .slice(1)
    .filter((group) => group.signal)
    .map((group) => SIGNALS.indexOf(group.signal));
  assert.ok(ranks.length >= 2);
  assert.deepEqual(
    ranks,
    [...ranks].sort((a, b) => a - b),
  );
  const cues = groups.slice(1);
  const firstGeneric = cues.findIndex((group) => !group.signal);
  assert.ok(
    firstGeneric === -1 ||
      cues.slice(firstGeneric).every((group) => !group.signal),
  );
});

test("HIGH static behavior cues rank with novel literals, review cues with other signals", async () => {
  const report = crowdedReport();
  const hook = '"postinstall":"node x.js"';
  const at = artifactManifest.indexOf(hook);
  report.evidence.push(piece("hook", "artifact", "package.json", hook, at));
  const behavior = (ruleId, priority) => ({
    module: "behavior",
    ruleId,
    priority,
    evidenceIds: ["hook"],
  });
  report.cues.push(
    behavior("behavior-install-network-fetch", "review"),
    behavior("behavior-install-remote-shell", "HIGH"),
  );
  assert.deepEqual(
    [
      evidenceSignal(report.cues.at(-1)).high,
      evidenceSignal(report.cues.at(-2)).high,
      evidenceSignal({ ...report.cues.at(-1), module: "syntax" }).high,
    ],
    [true, false, false],
  );
  const { section, prompt } = await explainWithPrompt(report);
  assert.equal(section.status, "complete");
  assert.deepEqual(
    prompt.evidenceGroups
      .slice(0, 3)
      .map((group) => [group.ruleId, group.signal]),
    [
      ["behavior-install-remote-shell", "lifecycle"],
      ["manifest-lifecycle-source-absent", "lifecycle"],
      ["behavior-install-network-fetch", "lifecycle"],
    ],
  );
});

test("cue sets above the old 1000 limit are bounded and keep HIGH behavior cues", async () => {
  const report = crowdedReport();
  const hook = '"postinstall":"node x.js"';
  report.evidence.push(
    piece(
      "hook",
      "artifact",
      "package.json",
      hook,
      artifactManifest.indexOf(hook),
    ),
  );
  for (let i = 0; i < 1500; i++)
    report.cues.push({
      module: "manifest",
      ruleId: "manifest-runtime-field-difference",
      field: `/keywords/${i}`,
      evidenceIds: ["manifest-a", "manifest-s"],
    });
  report.cues.push({
    module: "behavior",
    ruleId: "behavior-install-remote-shell",
    priority: "HIGH",
    evidenceIds: ["hook"],
  });
  const started = performance.now();
  const { section, prompt } = await explainWithPrompt(report);
  assert.ok(performance.now() - started < 5000);
  assert.equal(section.status, "complete");
  assert.deepEqual(
    [prompt.evidenceGroups[0].ruleId, prompt.evidenceGroups[0].signal],
    ["behavior-install-remote-shell", "lifecycle"],
  );
  assert.ok(
    section.omittedEvidenceGroups.filter(
      (group) => group.ruleId === "manifest-runtime-field-difference",
    ).length > 1000,
  );
});

test("cue sets above the hard cap fail closed as input-budget", async () => {
  const report = crowdedReport();
  for (let i = 0; i < 10001; i++)
    report.cues.push({
      module: "manifest",
      ruleId: "manifest-runtime-field-difference",
      field: `/keywords/${i}`,
      evidenceIds: ["manifest-a"],
    });
  const { section } = await explainWithPrompt(report);
  assert.deepEqual(
    [section.status, section.reason],
    ["unavailable", "input-budget"],
  );
});

function hunkReport(pairs) {
  const evidence = [],
    files = [];
  for (const [path, before, after, at = [40, 90]] of pairs) {
    const s = piece(`${path}#s`, "source", path, before, at[0]);
    const a = piece(`${path}#a`, "artifact", path, after, at[1]);
    for (const item of [s, a])
      if (item.excerpt === "") item.excerpt = undefined;
    evidence.push(a, s);
    files.push({
      path,
      state: "changed",
      spans: { artifact: a.range, source: s.range },
      evidenceIds: [a.id, s.id],
    });
  }
  return {
    inputs: { artifact: { kind: "local" } },
    evidence: evidence.map((item) =>
      item.excerpt === undefined ? { ...item, excerpt: "" } : item,
    ),
    files,
    cues: [],
    policy: { exitCode: 0, findings: [] },
    model: { status: "disabled" },
    run: {},
  };
}

test("modified spans become exact before/after line hunks with absolute UTF-8 byte citations", async () => {
  const before = 'old();\nkeep("é");\nend()';
  const after = 'evil();\nkeep("é");\nend2()';
  const { section, prompt } = await explainWithPrompt(
    hunkReport([["lib/a.js", before, after]]),
    [
      { evidenceId: "lib/a.js#a", quote: "evil();" },
      { evidenceId: "lib/a.js#s", quote: "old();" },
    ],
  );
  assert.equal(section.status, "complete");
  assert.match(prompt.diffHunkFormat, /source=before artifact=after/u);
  assert.equal(prompt.promptVersion, "diff-3");
  assert.deepEqual(prompt.diffHunks, [
    {
      path: "lib/a.js",
      change: "modified",
      source: [40, 64],
      artifact: [90, 116],
      lines: [
        ["-", 40, 46, "old();"],
        ["+", 90, 97, "evil();"],
        [" ", 98, 109, 'keep("é");'],
        ["-", 59, 64, "end()"],
        ["+", 110, 116, "end2()"],
      ],
    },
  ]);
  for (const [op, start, end, text] of prompt.diffHunks[0].lines) {
    const item = prompt.evidence.find(
      (e) => e.side === (op === "-" ? "source" : "artifact"),
    );
    const offset = start - item.range[0];
    assert.equal(
      Buffer.from(item.excerpt)
        .subarray(offset, end - item.range[0])
        .toString(),
      text,
    );
  }
});

test("pure additions and removals are labelled with the empty counterpart span", async () => {
  const { section, prompt } = await explainWithPrompt(
    hunkReport([
      ["lib/added.js", "", "require('x').run();\nnext();", [20, 20]],
      ["lib/removed.js", "check();\n", "", [5, 7]],
    ]),
    [{ evidenceId: "lib/added.js#a", quote: "require('x').run();" }],
  );
  assert.equal(section.status, "complete");
  assert.deepEqual(prompt.diffHunks, [
    {
      path: "lib/added.js",
      change: "added",
      source: [20, 20],
      artifact: [20, 47],
      lines: [
        ["+", 20, 39, "require('x').run();"],
        ["+", 40, 47, "next();"],
      ],
    },
    {
      path: "lib/removed.js",
      change: "removed",
      source: [5, 14],
      artifact: [7, 7],
      lines: [["-", 5, 13, "check();"]],
    },
  ]);
});

function changedFiles(count) {
  const report = hunkReport(
    Array.from({ length: count }, (_, i) => [
      `lib/f-${String(i).padStart(2, "0")}.js`,
      `before ${i}();`,
      `after ${i}();`,
    ]),
  );
  report.evidence[0].range = [90, 400];
  report.files[0].spans.artifact = [90, 400];
  return report;
}
const cite = [{ evidenceId: "lib/f-01.js#a", quote: "after 1();" }];

test("hunks use only budget left after evidence groups", async () => {
  const { section, prompt } = await explainWithPrompt(changedFiles(12), cite);
  assert.equal(section.status, "complete");
  assert.ok(Buffer.byteLength(JSON.stringify(prompt)) <= 4000 - 256);
  assert.equal(prompt.diffHunks, undefined);
  assert.equal(prompt.diffHunkFormat, undefined);
  const paths = [...new Set(prompt.evidence.map((e) => e.path))];
  assert.ok(paths.length >= 2);
  assert.deepEqual(
    paths,
    paths.map((_, i) => `lib/f-${String(i).padStart(2, "0")}.js`),
  );
});

test("truncated excerpts get no hunk while exact neighbours do", async () => {
  const { section, prompt } = await explainWithPrompt(changedFiles(2), cite);
  assert.equal(section.status, "complete");
  assert.ok(prompt.evidence.some((e) => e.id === "lib/f-00.js#a"));
  assert.deepEqual(
    prompt.diffHunks.map((hunk) => [hunk.path, hunk.change, hunk.lines]),
    [
      [
        "lib/f-01.js",
        "modified",
        [
          ["-", 40, 51, "before 1();"],
          ["+", 90, 100, "after 1();"],
        ],
      ],
    ],
  );
});

test("changed-file hunks take budget before unchanged context", async () => {
  const report = hunkReport([["lib/a.js", "before();", "after();"]]);
  for (let i = 0; i < 10; i++) {
    const path = `ctx/${String(i).padStart(2, "0")}.js`;
    report.evidence.push(
      piece(`ctx-${i}`, "artifact", path, `unchanged ${i} `.repeat(16)),
    );
    report.files.push({ path, state: "byte-identical" });
  }
  const { section, prompt } = await explainWithPrompt(report, [
    { evidenceId: "lib/a.js#a", quote: "after();" },
  ]);
  assert.equal(section.status, "complete");
  assert.deepEqual(
    prompt.diffHunks.map((hunk) => hunk.lines),
    [
      [
        ["-", 40, 49, "before();"],
        ["+", 90, 98, "after();"],
      ],
    ],
  );
  assert.ok(
    section.omittedEvidenceGroups.some(
      (group) =>
        group.ruleId === "unranked-context" && group.reason === "group-budget",
    ),
  );
});

function topHeavyReport() {
  const long = (side) =>
    `{"scripts":{"postinstall":"node ${side}.js"},"pad":"${"x".repeat(470)}"}`.slice(
      0,
      512,
    );
  const id = (side) => `manifest-${side}-${"0123456789abcdef".repeat(4)}`;
  const report = crowdedReport();
  report.evidence = [
    piece(id("artifact"), "artifact", "package.json", long("artifact")),
    piece(id("source"), "source", "package.json", long("source")),
    piece("small", "artifact", "zzz.js", "tiny();"),
  ];
  report.files = [
    { path: "package.json", state: "changed" },
    { path: "zzz.js", state: "byte-identical" },
  ];
  report.cues = [{ ruleId: "generic-observation", evidenceIds: ["small"] }];
  report.policy.findings = [
    {
      ruleId: "lifecycle-source-absent",
      evidenceIds: [id("artifact"), id("source")],
    },
  ];
  return { report, artifactId: id("artifact"), sourceId: id("source") };
}

test("prompt group descriptors omit metadata-only IDs while results keep them", async () => {
  const { section, prompt } = await explainWithPrompt(crowdedReport());
  assert.equal(section.status, "complete");
  assert.ok(prompt.evidenceGroups.every((group) => !("id" in group)));
  assert.deepEqual(
    section.evidenceGroups.map(({ id, ...rest }) => [/^group-/.test(id), rest]),
    prompt.evidenceGroups.map((group) => [true, group]),
  );
});

test("a top-priority group too large for the budget keeps its leading evidence instead of being replaced", async () => {
  const { report, artifactId, sourceId } = topHeavyReport();
  const { section, prompt } = await explainWithPrompt(
    report,
    [{ evidenceId: artifactId, quote: "node artifact.js" }],
    { maxInputTokens: 3200 },
  );
  assert.equal(section.status, "complete");
  assert.deepEqual(prompt.evidenceGroups[0], {
    kind: "policy",
    ruleId: "lifecycle-source-absent",
    evidenceIds: [artifactId],
    paired: false,
    partial: true,
  });
  assert.equal(prompt.evidence[0].id, artifactId);
  assert.ok(
    section.omittedEvidenceGroups.some(
      (group) =>
        group.reason === "group-partial" &&
        group.evidenceIds.length === 1 &&
        group.evidenceIds[0] === sourceId,
    ),
  );
  assert.ok(section.omittedEvidenceIds.includes(sourceId));
});

test("two code-heavy policy findings both fit the default budget alongside the summary scope", async () => {
  const report = crowdedReport();
  report.evidence = Array.from({ length: 16 }, (_, i) =>
    piece(
      `evidence-${String(i).padStart(3, "0")}-${"abcdef0123456789".repeat(4)}`,
      "artifact",
      `aaa-${String(i).padStart(2, "0")}.js`,
      'const opaque = ["a", 1, {}, null];'.repeat(20).slice(0, 512),
    ),
  );
  report.files = report.evidence.map((e) => ({
    path: e.path,
    state: "changed",
    evidenceIds: [e.id],
  }));
  report.cues = [];
  const policyIds = [report.evidence[14].id, report.evidence[15].id];
  report.policy.findings = policyIds.map((id) => ({
    ruleId: "lifecycle-source-absent",
    evidenceIds: [id],
  }));
  const { section, prompt } = await explainWithPrompt(report, [
    { evidenceId: policyIds[0], quote: "const opaque" },
  ]);
  assert.equal(section.status, "complete");
  assert.deepEqual(
    prompt.evidence.map((e) => e.id),
    policyIds,
  );
});
