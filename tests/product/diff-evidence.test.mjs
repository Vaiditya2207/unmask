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
async function explainWithPrompt(report) {
  let prompt;
  const section = await createGemmaClient({
    apiKey: "test-only-key",
    modelId: "gemma-4-26b-a4b-it",
    quotaVerified: true,
    dailyRequests: 20,
    requestsPerMinute: 20,
    inputTokensPerMinute: 20000,
    totalMs: 90000,
    fetchImpl: async (url, options) => {
      prompt = JSON.parse(JSON.parse(options.body).contents[0].parts[0].text);
      if (url.endsWith(":countTokens"))
        return new Response('{"totalTokens":300}');
      const hypothesis = {
        category: "review-concern",
        explanation: "The artifact declares an install hook requiring review.",
        uncertainty: "Execution was not observed.",
        alternative: "This may be intentional packaging.",
        citations: [{ evidenceId: "manifest-a", quote: '"node x.js"' }],
      };
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: JSON.stringify({ hypotheses: [hypothesis] }) }],
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
    [{ ruleId: "syntax-environment-access" }, "secret-access"],
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
  assert.equal(prompt.promptVersion, "diff-1");
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
  assert.deepEqual([groups[0].kind, groups[0].signal], ["policy", "lifecycle"]);
  const ranks = groups
    .slice(1)
    .filter((group) => group.signal)
    .map((group) => SIGNALS.indexOf(group.signal));
  assert.ok(ranks.length >= 4);
  assert.deepEqual(
    ranks,
    [...ranks].sort((a, b) => a - b),
  );
  const firstGeneric = groups.findIndex((group) => !group.signal);
  assert.ok(
    firstGeneric === -1 ||
      groups.slice(firstGeneric).every((group) => !group.signal),
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
