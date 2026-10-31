import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createGemmaClient, attachModel } from "../../src/model/client.mjs";
import { validAssessment, validSummary } from "../../src/model/summary.mjs";
import { PROMPT_VERSION } from "../../src/model/diff-evidence.mjs";

const evidence = [
  {
    id: "e1",
    path: "package.json",
    side: "artifact",
    range: [0, 26],
    excerpt: '"install":"node setup.js"',
  },
];
const report = () => ({
  inputs: { artifact: { kind: "local" } },
  evidence: structuredClone(evidence),
  files: [],
  cues: [],
  policy: {
    exitCode: 3,
    findings: [{ ruleId: "lifecycle-source-absent", evidenceIds: ["e1"] }],
  },
  model: { status: "disabled" },
  run: {},
});
const hypothesis = () => ({
  category: "review-concern",
  explanation: "The artifact declares an install command requiring review.",
  uncertainty: "Execution was not observed.",
  alternative: "This may be intentional packaging.",
  citations: [{ evidenceId: "e1", quote: "node setup.js" }],
});
const SUMMARY = "Two compared files differ; one install command needs review.";
const ASSESSMENT = {
  uncertainty: "Runtime behavior was not observed.",
  nextAction: "Review the install command before installing.",
};
const withSummary = (value) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? {
        ...("summary" in value ? {} : { summary: SUMMARY }),
        ...("assessment" in value ? {} : { assessment: ASSESSMENT }),
        ...value,
      }
    : value;
const output = (value) =>
  new Response(
    JSON.stringify({
      candidates: [
        { content: { parts: [{ text: JSON.stringify(withSummary(value)) }] } },
      ],
    }),
    { headers: { "Content-Type": "application/json" } },
  );

test("identical and empty reports still receive a bounded scope-only model summary", async () => {
  const prompts = [];
  const model = client(
    async (url, options) => {
      const text = JSON.parse(options.body).contents[0].parts[0].text;
      prompts.push(JSON.parse(text));
      return url.endsWith(":countTokens")
        ? new Response('{"totalTokens":100}')
        : output({
            summary:
              "All supplied files are byte-identical to the selected source; this is not proof the package is safe.",
            hypotheses: [],
          });
    },
    { dailyRequests: 4 },
  );
  const configHash = model.configHash;
  for (const files of [
    [],
    [{ path: "package.json", state: "byte-identical" }],
  ]) {
    const input = report();
    input.evidence = [];
    input.files = files;
    input.policy = { exitCode: 0, findings: [] };
    const before = JSON.stringify(input);
    const section = await model.explain(input, { allowLocal: true });
    assert.equal(section.status, "complete");
    assert.match(section.summary, /byte-identical/);
    assert.deepEqual(section.hypotheses, []);
    assert.equal(section.summaryPolicy, "every-check-2");
    assert.equal(section.scope.files, files.length);
    assert.equal(section.scope.supplied, 0);
    assert.equal(JSON.stringify(input), before);
    assert.equal(model.configHash, configHash);
  }
  assert.equal(prompts.length, 4);
  for (const prompt of prompts) {
    assert.deepEqual(prompt.evidence, []);
    assert.ok(prompt.output.summary);
    assert.doesNotMatch(
      JSON.stringify(prompt),
      /node setup\.js|"run"|"policy"/,
    );
  }
  assert.deepEqual(prompts[2].scope.states, { "byte-identical": 1 });
  assert.equal(model.configuration.summaryPolicy, "every-check-2");
  assert.equal(model.configuration.promptVersion, PROMPT_VERSION);
});

test("affirmative safety or missing summaries are rejected while negated caveats pass", async () => {
  for (const [summary, status] of [
    ["The package is safe to install.", "unavailable"],
    ["No findings, so it is benign.", "unavailable"],
    ["One install command differs; this does not mean it is safe.", "complete"],
    [undefined, "unavailable"],
    ["x".repeat(601), "unavailable"],
  ]) {
    let generations = 0;
    const section = await client(async (url) => {
      if (url.endsWith(":countTokens"))
        return new Response('{"totalTokens":100}');
      generations++;
      const body = { hypotheses: [hypothesis()] };
      return output({ summary, ...body });
    }).explain(report(), { allowLocal: true });
    assert.equal(section.status, status, String(summary));
    assert.equal(generations, status === "complete" ? 1 : 2);
    if (status !== "complete") {
      assert.equal(section.reason, "invalid-output");
      assert.equal(section.summary, undefined);
    }
  }
});

test("summary validation rejects verdicts and double negatives but keeps scoped facts and npm vocabulary", () => {
  for (const [text, valid] of [
    ["It is safe.", false],
    ["Nothing suggests it is not safe.", false],
    ["There is no reason to consider it not safe to install.", false],
    ["Nothing here is unsafe.", false],
    ["No findings, so it is benign.", false],
    ["The package is missing a license.", false],
    ["Malware is absent.", false],
    ["Matching bytes are not proof the package is safe.", true],
    ["This does not mean it is safe.", true],
    ["Not a safety verdict; 3 files are byte-identical.", true],
    ["The artifact changes the clean script that removes build output.", true],
    ["The release uses npm trusted publishing provenance.", true],
    ["Adds a secure-cookie option in lib/session.js.", true],
    ["The source archive is missing, so the comparison is partial.", true],
    ["2 artifact-only files are not in the selected source.", true],
    ["The prompt omits 15 evidence items.", true],
  ])
    assert.equal(validSummary(text, "test-only-key"), valid, text);
});

test("completed results carry a structured model assessment with deterministic checked scope", async () => {
  const input = report();
  input.evidence.push({
    id: "e2",
    path: "lib/other.js",
    side: "artifact",
    range: [0, 4],
    excerpt: "more",
  });
  input.coverage = {
    inventory: { files: 3, complete: true },
    compared: { files: 3 },
    syntaxInspected: { files: 1 },
  };
  input.source = { status: "selected" };
  const section = await client(async (url) =>
    url.endsWith(":countTokens")
      ? new Response('{"totalTokens":100}')
      : output({ hypotheses: [hypothesis()] }),
  ).explain(input, { allowLocal: true });
  assert.equal(section.status, "complete");
  assert.deepEqual(section.assessment, {
    source: "model",
    ...ASSESSMENT,
    checkedScope: {
      basis: "deterministic-prompt-selection",
      evidenceSupplied: 2,
      evidenceOmitted: 0,
      groupsSupplied: 2,
      groupsOmitted: 0,
      paths: ["lib/other.js", "package.json"],
      notChecked: ["runtime-behavior", "uninspected-syntax"],
    },
  });
});

test("malformed or safety-claiming assessments never enter the report", async () => {
  for (const assessment of [
    undefined,
    { uncertainty: "Runtime behavior was not observed." },
    { ...ASSESSMENT, extra: "x" },
    { ...ASSESSMENT, nextAction: "Install it; the package is safe." },
    { ...ASSESSMENT, uncertainty: "u".repeat(301) },
    { ...ASSESSMENT, nextAction: "test-only-key" },
  ]) {
    const section = await client(async (url) =>
      url.endsWith(":countTokens")
        ? new Response('{"totalTokens":100}')
        : output({ assessment, hypotheses: [hypothesis()] }),
    ).explain(report(), { allowLocal: true });
    assert.equal(section.status, "unavailable", JSON.stringify(assessment));
    assert.equal(section.reason, "invalid-output");
    assert.equal(section.assessment, undefined);
  }
});

test("assessment next action must be a review step and uncertainty keeps absence limits", () => {
  const uncertainty = "Runtime behavior was not observed.";
  for (const [value, valid] of [
    [{ uncertainty, nextAction: "Review the changed postinstall hook." }, true],
    [{ uncertainty, nextAction: "Proceed with installation." }, false],
    [{ uncertainty, nextAction: "Review the hook, then proceed." }, false],
    [{ uncertainty, nextAction: "Install it." }, false],
    [
      {
        uncertainty: "The source lacks the postinstall script entirely.",
        nextAction: "Confirm the release commit.",
      },
      false,
    ],
    [
      {
        uncertainty: "index.js is missing from the selected source.",
        nextAction: "Confirm the release commit.",
      },
      true,
    ],
  ])
    assert.equal(
      validAssessment(value, "test-only-key"),
      valid,
      value.nextAction,
    );
});

test("changed, artifact-only and not-compared files remain eligible without a policy finding", async () => {
  for (const state of ["changed", "artifact-only", "not-compared"]) {
    let requests = 0;
    const model = client(async (url) => {
      requests++;
      return url.endsWith(":countTokens")
        ? new Response('{"totalTokens":100}')
        : output({ hypotheses: [hypothesis()] });
    });
    const input = report();
    input.files = [{ path: "package.json", state }];
    input.policy = { exitCode: 0, findings: [] };
    assert.equal(
      (await model.explain(input, { allowLocal: true })).status,
      "complete",
    );
    assert.equal(requests, 2);
  }
});

function client(fetchImpl, extra = {}) {
  return createGemmaClient({
    apiKey: "test-only-key",
    modelId: "gemma-4-26b-a4b-it",
    quotaVerified: true,
    dailyRequests: 20,
    requestsPerMinute: 20,
    inputTokensPerMinute: 20000,
    totalMs: 90000,
    fetchImpl,
    ...extra,
  });
}

test("unconfigured and unconsented local inputs send no model request", async () => {
  const forbidden = () => {
    throw new Error("network forbidden");
  };
  assert.equal(
    (await createGemmaClient({ fetchImpl: forbidden }).explain(report()))
      .status,
    "disabled",
  );
  assert.deepEqual(await client(forbidden).explain(report()), {
    status: "not-sent",
    reason: "local-input",
  });
});

test("client counts tokens and validates cited hypotheses without touching policy", async () => {
  const calls = [];
  const model = client(async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith(":countTokens"))
      return new Response('{"totalTokens":300}');
    return output({ hypotheses: [hypothesis()] });
  });
  const input = report();
  const before = JSON.stringify(input);
  const section = await model.explain(input, { allowLocal: true });
  assert.equal(section.status, "complete");
  assert.equal(section.hypotheses[0].citations[0].quote, "node setup.js");
  assert.equal(calls.length, 2);
  assert.ok(
    calls.every(
      ({ url, options }) =>
        url.startsWith(
          "https://generativelanguage.googleapis.com/v1beta/models/gemma-4-26b-a4b-it:",
        ) &&
        !url.includes("test-only-key") &&
        options.headers["x-goog-api-key"] === "test-only-key" &&
        options.redirect === "error",
    ),
  );
  const attached = attachModel(input, section);
  assert.deepEqual(attached.policy, input.policy);
  assert.equal(JSON.stringify(input), before);
  assert.doesNotMatch(JSON.stringify(section), /test-only-key/);
});

test("fabricated citations and unexpected output fields cannot enter the report", async () => {
  let attempts = 0;
  const model = client(async (url) => {
    if (url.endsWith(":countTokens"))
      return new Response('{"totalTokens":300}');
    attempts++;
    return output({
      hypotheses: [
        {
          ...hypothesis(),
          citations: [{ evidenceId: "e1", quote: "not present" }],
        },
      ],
      policy: { exitCode: 0 },
    });
  });
  const result = await model.explain(report(), { allowLocal: true });
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "invalid-output");
  assert.equal(attempts, 2);
  assert.equal(result.hypotheses, undefined);
});

test("over-budget token counts prevent generation and preserve all omitted evidence IDs", async () => {
  let generation = 0;
  const model = client(async (url) => {
    if (url.endsWith(":countTokens"))
      return new Response('{"totalTokens":4001}');
    generation++;
    return output({ hypotheses: [hypothesis()] });
  });
  const result = await model.explain(report(), { allowLocal: true });
  assert.equal(result.reason, "input-budget");
  assert.equal(generation, 0);
});

test("unverified quota and unsupported model IDs fail closed before sending excerpts", async () => {
  const forbidden = () => {
    throw new Error("network forbidden");
  };
  assert.equal(
    (
      await client(forbidden, { quotaVerified: false }).explain(report(), {
        allowLocal: true,
      })
    ).status,
    "disabled",
  );
  assert.throws(() => client(forbidden, { modelId: "other-model" }), /model/i);
});

test("rate-limit retry is bounded and secret-bearing provider errors are never exposed", async () => {
  let generation = 0;
  const model = client(async (url) => {
    if (url.endsWith(":countTokens"))
      return new Response('{"totalTokens":300}');
    generation++;
    return new Response(JSON.stringify(scopedQuota("gemma-4-26b-a4b-it")), {
      status: 429,
      headers: { "Retry-After": "0" },
    });
  });
  const result = await model.explain(report(), { allowLocal: true });
  assert.equal(result.reason, "quota");
  assert.equal(generation, 2);
  assert.doesNotMatch(
    JSON.stringify(result),
    /test-only-key|private-provider-error/,
  );
});

test("generation configuration and prompt identity are recorded without carrying deterministic report fields", async () => {
  let generation;
  let counted;
  const model = client(async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith(":countTokens")) {
      counted = body.contents;
      return new Response('{"totalTokens":300}');
    }
    generation = body;
    return output({ hypotheses: [hypothesis()] });
  });
  const section = await model.explain(report(), { allowLocal: true });
  assert.equal(section.status, "complete");
  assert.deepEqual(generation.contents, counted);
  assert.deepEqual(generation.generationConfig, {
    temperature: 0,
    maxOutputTokens: 1000,
    candidateCount: 1,
    thinkingConfig: { thinkingLevel: "minimal" },
  });
  assert.deepEqual(section.generationConfig, generation.generationConfig);
  assert.match(section.promptHash, /^[a-f0-9]{64}$/);
  assert.match(section.configHash, /^[a-f0-9]{64}$/);
  assert.equal(section.modelId, "gemma-4-26b-a4b-it");
  assert.equal(generation.tools, undefined);
  assert.equal(generation.systemInstruction, undefined);
  assert.equal(section.policy, undefined);
});

for (const options of [
  { requestsPerMinute: undefined },
  { dailyRequests: 0 },
  { inputTokensPerMinute: NaN },
  { apiKey: "" },
]) {
  test(`missing verified quota/key fails closed: ${Object.keys(options)[0]}`, async () => {
    let calls = 0;
    const result = await client(() => {
      calls++;
      throw new Error("forbidden");
    }, options).explain(report(), { allowLocal: true });
    assert.equal(result.status, "disabled");
    assert.equal(calls, 0);
  });
}

test("unknown input origin and a local source archive both require consent", async () => {
  const model = client(() => {
    throw new Error("forbidden");
  });
  const unknown = report();
  delete unknown.inputs.artifact.kind;
  assert.equal((await model.explain(unknown)).reason, "local-input");
  const mixed = report();
  mixed.inputs.artifact.kind = "registry";
  mixed.inputs.sourceArchive = { kind: "local" };
  assert.equal((await model.explain(mixed)).reason, "local-input");
});

test("evidence selection is bounded and all unsent IDs remain explicit", async () => {
  const r = report();
  r.evidence = Array.from({ length: 100 }, (_, i) => ({
    ...evidence[0],
    id: `e${i}`,
    path: `p${String(i).padStart(3, "0")}.js`,
  }));
  let sent;
  const section = await client(async (url, options) => {
    const text = JSON.parse(options.body).contents[0].parts[0].text;
    const prompt = JSON.parse(text);
    sent = prompt.evidence;
    if (url.endsWith(":countTokens"))
      return new Response('{"totalTokens":300}');
    const id = prompt.evidence[0].id;
    return output({
      hypotheses: [
        {
          ...hypothesis(),
          citations: [{ evidenceId: id, quote: "node setup.js" }],
        },
      ],
    });
  }).explain(r, { allowLocal: true });
  assert.equal(section.status, "complete");
  assert.ok(sent.length > 0 && sent.length < 100);
  assert.deepEqual(
    new Set([...sent.map((e) => e.id), ...section.omittedEvidenceIds]),
    new Set(r.evidence.map((e) => e.id)),
  );
});

for (const kind of ["rpm", "tpm", "daily"]) {
  test(`preflight itself consumes the ${kind} allowance before generation`, async () => {
    const limits =
      kind === "rpm"
        ? { requestsPerMinute: 1 }
        : kind === "daily"
          ? { dailyRequests: 1 }
          : { inputTokensPerMinute: 1 };
    let count = 0,
      generated = 0;
    const result = await client(async (url) => {
      if (url.endsWith(":countTokens")) {
        count++;
        return new Response('{"totalTokens":300}');
      }
      generated++;
      return output({ hypotheses: [hypothesis()] });
    }, limits).explain(report(), { allowLocal: true });
    assert.equal(result.reason, "quota");
    assert.equal(generated, 0);
    assert.equal(count, kind === "tpm" ? 0 : 1);
  });
}

test("unsupported or failed tokenizer preflight cannot be replaced by an estimate", async () => {
  let generation = 0;
  const result = await client(async (url) => {
    if (url.endsWith(":countTokens"))
      return new Response("provider secret test-only-key", { status: 404 });
    generation++;
    return output({ hypotheses: [hypothesis()] });
  }).explain(report(), { allowLocal: true });
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "preflight");
  assert.equal(generation, 0);
  assert.doesNotMatch(JSON.stringify(result), /test-only-key|provider secret/);
});

test("fetch that ignores abort is still bounded and cannot generate after timeout", async () => {
  let resolveCount;
  let signal;
  let generated = 0;
  const model = client(
    async (url, options) => {
      signal = options.signal;
      if (url.endsWith(":countTokens"))
        return new Promise((resolve) => {
          resolveCount = resolve;
        });
      generated++;
      return output({ hypotheses: [hypothesis()] });
    },
    { attemptMs: 10, totalMs: 20 },
  );
  const result = await model.explain(report(), { allowLocal: true });
  assert.equal(result.reason, "timeout");
  assert.equal(signal.aborted, true);
  resolveCount(new Response('{"totalTokens":300}'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(generated, 0);
});

test("provider response bytes are bounded before JSON decoding", async () => {
  const result = await client(async (url) => {
    if (url.endsWith(":countTokens"))
      return new Response('{"totalTokens":300}');
    return new Response("x".repeat(65537));
  }).explain(report(), { allowLocal: true });
  assert.equal(result.reason, "response-cap");
  assert.equal(result.hypotheses, undefined);
});

test("huge Retry-After is not slept past the total budget", async () => {
  let slept = 0,
    generations = 0;
  const result = await client(
    async (url) => {
      if (url.endsWith(":countTokens"))
        return new Response('{"totalTokens":300}');
      generations++;
      return new Response("private", {
        status: 429,
        headers: { "Retry-After": "1000" },
      });
    },
    {
      sleep: async (ms) => {
        slept += ms;
      },
    },
  ).explain(report(), { allowLocal: true });
  assert.equal(result.reason, "quota");
  assert.equal(generations, 1);
  assert.equal(slept, 0);
});

test("attachModel snapshots both inputs so advisory mutations cannot reach deterministic data", () => {
  const r = report(),
    section = { status: "complete", hypotheses: [hypothesis()] };
  const result = attachModel(r, section);
  result.policy.exitCode = 0;
  result.evidence[0].excerpt = "changed";
  result.model.hypotheses[0].explanation = "changed";
  assert.equal(r.policy.exitCode, 3);
  assert.equal(r.evidence[0].excerpt, evidence[0].excerpt);
  assert.notEqual(section.hypotheses[0].explanation, "changed");
});

for (const value of [
  null,
  { candidates: [null] },
  { candidates: [{ content: { parts: [null] } }] },
]) {
  test(`malformed success envelope is retried safely: ${JSON.stringify(value)}`, async () => {
    let generations = 0;
    const section = await client(async (url) => {
      if (url.endsWith(":countTokens"))
        return new Response('{"totalTokens":300}');
      generations++;
      return new Response(JSON.stringify(value));
    }).explain(report(), { allowLocal: true });
    assert.equal(section.reason, "invalid-output");
    assert.equal(generations, 2);
  });
}

test("attempt deadline includes tokenizer time before generation", async () => {
  let time = 0;
  let generations = 0;
  const section = await client(
    async (url) => {
      if (url.endsWith(":countTokens")) {
        time += 44000;
        return new Response('{"totalTokens":300}');
      }
      time += 2000;
      generations++;
      return output({ hypotheses: [hypothesis()] });
    },
    { now: () => time },
  ).explain(report(), { allowLocal: true });
  assert.equal(section.reason, "timeout");
  assert.equal(generations, 1);
});

test("total deadline includes backoff and stops retry preflight before a second generation", async () => {
  let time = 0,
    counts = 0,
    generations = 0;
  const section = await client(
    async (url) => {
      if (url.endsWith(":countTokens")) {
        counts++;
        if (counts === 2) time += 2000;
        return new Response('{"totalTokens":300}');
      }
      generations++;
      return new Response("retry", {
        status: 503,
        headers: { "Retry-After": "89" },
      });
    },
    {
      now: () => time,
      sleep: async (ms) => {
        time += ms;
      },
    },
  ).explain(report(), { allowLocal: true });
  assert.equal(section.reason, "timeout");
  assert.equal(generations, 1);
});

test("response stream stall is aborted within the attempt budget", async () => {
  let cancelled = false;
  const section = await client(
    async (url) => {
      if (url.endsWith(":countTokens"))
        return new Response('{"totalTokens":300}');
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      );
    },
    { attemptMs: 10, totalMs: 20 },
  ).explain(report(), { allowLocal: true });
  assert.equal(section.reason, "timeout");
  assert.equal(cancelled, true);
});

test("streamed oversized responses are capped even without Content-Length", async () => {
  let cancelled = false;
  const section = await client(async (url) => {
    if (url.endsWith(":countTokens"))
      return new Response('{"totalTokens":300}');
    let n = 0;
    return new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(20000));
          if (++n === 4) controller.close();
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
  }).explain(report(), { allowLocal: true });
  assert.equal(section.reason, "response-cap");
  assert.equal(section.hypotheses, undefined);
});

test("provider exceptions never disclose a key or raw diagnostic", async () => {
  const section = await client(() => {
    throw new Error("test-only-key private-provider-error");
  }).explain(report(), { allowLocal: true });
  assert.equal(section.reason, "preflight");
  assert.doesNotMatch(
    JSON.stringify(section),
    /test-only-key|private-provider-error/,
  );
});

test("one long-lived client serializes calls and retains request/day reservations", async () => {
  let releaseCount;
  const model = client(
    async (url) => {
      if (url.endsWith(":countTokens"))
        return new Promise((resolve) => {
          releaseCount = resolve;
        });
      return output({ hypotheses: [hypothesis()] });
    },
    { dailyRequests: 2 },
  );
  const first = model.explain(report(), { allowLocal: true });
  assert.equal(
    (await model.explain(report(), { allowLocal: true })).reason,
    "busy",
  );
  releaseCount(new Response('{"totalTokens":300}'));
  assert.equal((await first).status, "complete");
  assert.equal(
    (await model.explain(report(), { allowLocal: true })).reason,
    "quota",
  );
});

for (const [mutate, expected] of [
  [
    (h) => {
      h.citations[0].evidenceId = "unknown";
    },
    "invalid-output",
  ],
  [
    (h) => {
      h.category = "safe";
    },
    "invalid-output",
  ],
  [
    (h) => {
      h.explanation = "test-only-key";
    },
    "invalid-output",
  ],
  [
    (h) => {
      h.citations[0].quote = "";
    },
    "invalid-output",
  ],
]) {
  test(`hypothesis schema rejects unsupported claim shape ${mutate.toString()}`, async () => {
    const h = hypothesis();
    mutate(h);
    const section = await client(async (url) =>
      url.endsWith(":countTokens")
        ? new Response('{"totalTokens":300}')
        : output({ hypotheses: [h] }),
    ).explain(report(), { allowLocal: true });
    assert.equal(section.reason, expected);
    assert.equal(section.hypotheses, undefined);
  });
}

test("a registry report can send without local consent and never includes run or policy", async () => {
  const r = report();
  r.inputs.artifact.kind = "registry";
  r.run.private = "never-send-marker";
  const section = await client(async (url, options) => {
    assert.doesNotMatch(
      options.body,
      /never-send-marker|"exitCode"|test-only-key/,
    );
    return url.endsWith(":countTokens")
      ? new Response('{"totalTokens":300}')
      : output({ hypotheses: [hypothesis()] });
  }).explain(r);
  assert.equal(section.status, "complete");
});

test("local rate windows expire but daily allowance resets only on a later UTC day", async () => {
  let time = 0,
    day = 0;
  const model = client(
    async (url) =>
      url.endsWith(":countTokens")
        ? new Response('{"totalTokens":300}')
        : output({ hypotheses: [hypothesis()] }),
    {
      requestsPerMinute: 2,
      dailyRequests: 2,
      now: () => time,
      wallNow: () => day,
    },
  );
  assert.equal(
    (await model.explain(report(), { allowLocal: true })).status,
    "complete",
  );
  time = 60001;
  assert.equal(
    (await model.explain(report(), { allowLocal: true })).reason,
    "quota",
  );
  day = 86400000;
  assert.equal(
    (await model.explain(report(), { allowLocal: true })).status,
    "complete",
  );
});

test("retry generation is independently rate-gated including its tokenizer request", async () => {
  let calls = 0,
    generations = 0;
  const result = await client(
    async (url) => {
      calls++;
      if (url.endsWith(":countTokens"))
        return new Response('{"totalTokens":300}');
      generations++;
      return output({ hypotheses: [{ ...hypothesis(), category: "safe" }] });
    },
    { requestsPerMinute: 3 },
  ).explain(report(), { allowLocal: true });
  assert.equal(result.reason, "quota");
  assert.equal(calls, 3);
  assert.equal(generations, 1);
});

test("nonretryable HTTP responses never consume a second generation", async () => {
  let generations = 0;
  const result = await client(async (url) => {
    if (url.endsWith(":countTokens"))
      return new Response('{"totalTokens":300}');
    generations++;
    return new Response("private", { status: 401 });
  }).explain(report(), { allowLocal: true });
  assert.equal(result.reason, "provider");
  assert.equal(generations, 1);
});

test("allowed fallback ID remains on the same fixed provider host", async () => {
  const result = await client(
    async (url) => {
      assert.ok(
        url.startsWith(
          "https://generativelanguage.googleapis.com/v1beta/models/gemma-4-31b-it:",
        ),
      );
      return url.endsWith(":countTokens")
        ? new Response('{"totalTokens":300}')
        : output({ hypotheses: [hypothesis()] });
    },
    { modelId: "gemma-4-31b-it", endpoint: "https://unexpected.example" },
  ).explain(report(), { allowLocal: true });
  assert.equal(result.modelId, "gemma-4-31b-it");
  assert.equal(result.status, "complete");
});

test("policy-linked entrypoint changes outrank unrelated evidence", async () => {
  const r = report();
  r.manifests = {
    artifact: { status: "usable", value: { main: "zz/entry.js" } },
  };
  r.policy.findings = [
    { ruleId: "lifecycle-source-absent", evidenceIds: ["entry"] },
  ];
  r.evidence = [
    ...Array.from({ length: 30 }, (_, i) => ({
      ...evidence[0],
      id: `other-${i}`,
      path: `aa-${i}.txt`,
    })),
    { ...evidence[0], id: "entry", path: "zz/entry.js" },
  ];
  const result = await client(async (url, options) => {
    const prompt = JSON.parse(
      JSON.parse(options.body).contents[0].parts[0].text,
    );
    if (url.endsWith(":countTokens"))
      return new Response('{"totalTokens":300}');
    assert.ok(prompt.evidence.some((e) => e.id === "entry"));
    return output({
      hypotheses: [
        {
          ...hypothesis(),
          citations: [{ evidenceId: "entry", quote: "node setup.js" }],
        },
      ],
    });
  }).explain(r, { allowLocal: true });
  assert.equal(result.status, "complete");
});

test("omitted evidence IDs cannot leak the configured key into model metadata", async () => {
  const r = report();
  r.evidence.push({ id: "test-only-key", path: null });
  let called = false;
  const result = await client(async (url) => {
    called = true;
    return url.endsWith(":countTokens")
      ? new Response('{"totalTokens":300}')
      : output({ hypotheses: [hypothesis()] });
  }).explain(r, { allowLocal: true });
  assert.equal(result.reason, "sensitive-input");
  assert.equal(called, false);
  assert.doesNotMatch(JSON.stringify(result), /test-only-key/);
});

test("secret-bearing output is rejected even when JSON escapes the secret", async () => {
  const secret = 'fixture"secret';
  const h = hypothesis();
  h.explanation = secret;
  const result = await client(
    async (url) =>
      url.endsWith(":countTokens")
        ? new Response('{"totalTokens":300}')
        : output({ hypotheses: [h] }),
    { apiKey: secret },
  ).explain(report(), { allowLocal: true });
  assert.equal(result.reason, "invalid-output");
  assert.equal(result.hypotheses, undefined);
});

test("external pre-abort and mid-request abort send no late provider work", async () => {
  const already = new AbortController();
  already.abort();
  let called = 0;
  const model = client(
    async () => {
      called++;
      return new Promise(() => {});
    },
    { attemptMs: 10, totalMs: 20 },
  );
  assert.equal(
    (
      await model.explain(report(), {
        allowLocal: true,
        signal: already.signal,
      })
    ).reason,
    "cancelled",
  );
  assert.equal(called, 0);
  const controller = new AbortController();
  const pending = model.explain(report(), {
    allowLocal: true,
    signal: controller.signal,
  });
  controller.abort();
  assert.equal((await pending).reason, "cancelled");
  assert.equal(called, 1);
});

test("client exposes only nonsecret immutable configuration snapshots", () => {
  const model = client(() => {
    throw new Error("forbidden");
  });
  assert.equal(model.modelId, "gemma-4-26b-a4b-it");
  assert.match(model.configHash, /^[a-f0-9]{64}$/);
  const config = model.configuration;
  assert.equal(config.modelId, model.modelId);
  assert.equal(config.configHash, model.configHash);
  assert.doesNotMatch(JSON.stringify(config), /test-only-key/);
  config.generationConfig.temperature = 1;
  assert.equal(model.configuration.generationConfig.temperature, 0);
});

test("more than five otherwise valid hypotheses are rejected", async () => {
  const result = await client(async (url) =>
    url.endsWith(":countTokens")
      ? new Response('{"totalTokens":300}')
      : output({ hypotheses: Array.from({ length: 6 }, hypothesis) }),
  ).explain(report(), { allowLocal: true });
  assert.equal(result.reason, "invalid-output");
});

for (const change of [
  { category: "possible-transformation" },
  { explanation: "The source executes the same install command." },
]) {
  test(`counterpart claims need both-side citations: ${JSON.stringify(change)}`, async () => {
    const result = await client(async (url) =>
      url.endsWith(":countTokens")
        ? new Response('{"totalTokens":300}')
        : output({ hypotheses: [{ ...hypothesis(), ...change }] }),
    ).explain(report(), { allowLocal: true });
    assert.equal(result.reason, "invalid-output");
  });
}

test("full-tree absence wording is rejected even with both-side citations", async () => {
  const r = report();
  r.evidence.push({
    ...evidence[0],
    id: "source",
    side: "source",
    excerpt: "original code",
  });
  const h = {
    ...hypothesis(),
    explanation: "The source tree does not contain the install command.",
    citations: [
      ...hypothesis().citations,
      { evidenceId: "source", quote: "original code" },
    ],
  };
  const result = await client(async (url) =>
    url.endsWith(":countTokens")
      ? new Response('{"totalTokens":300}')
      : output({ hypotheses: [h] }),
  ).explain(r, { allowLocal: true });
  assert.equal(result.reason, "invalid-output");
});

test("bounded capability evidence includes supplied source counterparts", async () => {
  const r = report();
  r.evidence = Array.from({ length: 20 }, (_, i) => ({
    ...evidence[0],
    id: `artifact-${i}`,
    path: `path-${String(i).padStart(2, "0")}.js`,
    excerpt: 'fetch("https://example.test")',
  }));
  r.evidence.push({
    ...evidence[0],
    id: "source",
    side: "source",
    path: r.evidence[0].path,
    excerpt: "original code",
  });
  const result = await client(async (url, options) => {
    const prompt = JSON.parse(
      JSON.parse(options.body).contents[0].parts[0].text,
    );
    if (url.endsWith(":countTokens"))
      return new Response('{"totalTokens":300}');
    assert.ok(prompt.evidence.some((e) => e.id === "source"));
    return output({
      hypotheses: [
        {
          ...hypothesis(),
          citations: [{ evidenceId: "artifact-0", quote: "fetch" }],
        },
      ],
    });
  }).explain(r, { allowLocal: true });
  assert.equal(result.status, "complete");
});

test("retry backoff receives cancellation and aborts before another request", async () => {
  const controller = new AbortController();
  let generations = 0;
  const result = await client(
    async (url) => {
      if (url.endsWith(":countTokens"))
        return new Response('{"totalTokens":300}');
      generations++;
      return new Response("private", {
        status: 503,
        headers: { "Retry-After": "1" },
      });
    },
    {
      sleep: async (ms, signal) => {
        assert.equal(signal, controller.signal);
        controller.abort();
      },
    },
  ).explain(report(), { allowLocal: true, signal: controller.signal });
  assert.equal(result.reason, "cancelled");
  assert.equal(generations, 1);
});

test("configuration hash changes with verified enablement and quota limits", () => {
  const fetchImpl = () => {
    throw new Error("forbidden");
  };
  assert.notEqual(
    client(fetchImpl).configHash,
    client(fetchImpl, { quotaVerified: false }).configHash,
  );
  assert.notEqual(
    client(fetchImpl).configHash,
    client(fetchImpl, { dailyRequests: 19 }).configHash,
  );
});

test("bounded absence wording and explicitly bound manifest transformation remain admissible", async () => {
  const r = manifestInput();
  for (const change of [
    { explanation: "The command was not found within supplied evidence." },
    {
      category: "possible-transformation",
      explanation:
        "The source and artifact may reflect a packaging transformation.",
    },
  ]) {
    const h = {
      ...hypothesis(),
      ...change,
      citations: [
        { evidenceId: "manifest-a", quote: "new" },
        { evidenceId: "manifest-s", quote: "old" },
      ],
    };
    const result = await client(async (url) =>
      url.endsWith(":countTokens")
        ? new Response('{"totalTokens":300}')
        : output({ hypotheses: [h] }),
    ).explain(r, { allowLocal: true });
    assert.equal(result.status, "complete");
  }
});

function rankedFixture(count = 40) {
  const r = report();
  r.policy.findings = [];
  r.evidence = Array.from({ length: count }, (_, i) => ({
    ...evidence[0],
    id: `bulk-${i}`,
    path: `aaa-${String(i).padStart(2, "0")}.js`,
    range: [0, 15],
    excerpt: "benign constant",
  }));
  r.files = r.evidence.map((e) => ({
    path: e.path,
    state: "byte-identical",
    evidenceIds: [e.id],
  }));
  return r;
}
async function rankedPrompt(r, makeHypothesis) {
  let prompt;
  const section = await client(async (url, options) => {
    prompt = JSON.parse(JSON.parse(options.body).contents[0].parts[0].text);
    if (url.endsWith(":countTokens"))
      return new Response('{"totalTokens":300}');
    const item =
      prompt.evidence.find((e) => e.side === "artifact") || prompt.evidence[0];
    return output({
      hypotheses: [
        makeHypothesis
          ? makeHypothesis(prompt)
          : {
              ...hypothesis(),
              citations: [{ evidenceId: item.id, quote: item.excerpt }],
            },
      ],
    });
  }).explain(r, { allowLocal: true });
  return { section, prompt };
}

test("late-path policy and novel changed-file cues outrank benign bulk in that order", async () => {
  const r = rankedFixture();
  r.evidence.push(
    { ...evidence[0], id: "policy", path: "zzz-policy.js" },
    {
      ...evidence[0],
      id: "novel",
      path: "yyy-novel.js",
      excerpt: "new opaque literal",
    },
  );
  r.files.push(
    { path: "zzz-policy.js", state: "changed" },
    { path: "yyy-novel.js", state: "artifact-only" },
  );
  r.policy.findings = [
    { ruleId: "lifecycle-source-absent", evidenceIds: ["policy"] },
  ];
  r.cues = [
    {
      ruleId: "syntax-network-call",
      literalStatus: "not-found-in-inspected-source",
      evidenceIds: ["novel"],
    },
  ];
  const { section, prompt } = await rankedPrompt(r);
  assert.equal(section.status, "complete");
  assert.deepEqual(
    prompt.evidence.slice(0, 2).map((e) => e.id),
    ["policy", "novel"],
  );
});

test("artifact-only AST literal cue IDs preserve explicit context across different paths", async () => {
  const r = rankedFixture();
  r.evidence.push(
    {
      ...evidence[0],
      id: "planted",
      path: "zzz.js",
      range: [0, 23],
      excerpt: 'fetch("static literal")',
    },
    {
      ...evidence[0],
      id: "counterpart",
      side: "source",
      path: "different/original.js",
      range: [0, 16],
      excerpt: '"static literal"',
    },
  );
  r.files.push({ path: "zzz.js", state: "artifact-only" });
  r.cues = [
    {
      ruleId: "syntax-network-call",
      literalStatus: "found-in-inspected-source",
      evidenceIds: ["planted", "counterpart"],
    },
  ];
  const { section, prompt } = await rankedPrompt(r, () => ({
    ...hypothesis(),
    explanation:
      "The source and artifact show a logic edit that merits review.",
    citations: [
      { evidenceId: "planted", quote: "static literal" },
      { evidenceId: "counterpart", quote: "static literal" },
    ],
  }));
  assert.equal(section.status, "complete");
  assert.equal(section.hypotheses[0].category, "review-concern");
  assert.deepEqual(
    prompt.evidence.slice(0, 2).map((e) => e.id),
    ["planted", "counterpart"],
  );
  assert.equal(prompt.evidenceGroups[0].paired, true);
});

test("unrelated source snippets cannot turn an unpaired cue into paired model success", async () => {
  const r = report();
  r.evidence.push({
    ...evidence[0],
    id: "unrelated",
    side: "source",
    path: "different/unrelated.js",
    excerpt: "unrelated literal",
  });
  r.cues = [
    {
      ruleId: "syntax-network-call",
      literalStatus: "not-found-in-inspected-source",
      evidenceIds: ["e1"],
    },
  ];
  const { section } = await rankedPrompt(r, () => ({
    ...hypothesis(),
    category: "possible-transformation",
    explanation: "The source and artifact may reflect a transformation.",
    citations: [
      ...hypothesis().citations,
      { evidenceId: "unrelated", quote: "unrelated literal" },
    ],
  }));
  assert.equal(section.reason, "invalid-output");
  assert.equal(section.hypotheses, undefined);
});

test("an oversized linked group is omitted whole and disclosed", async () => {
  const r = rankedFixture();
  const ids = r.evidence.slice(0, 17).map((e) => e.id);
  r.cues = [
    {
      ruleId: "syntax-network-call",
      literalStatus: "found-in-inspected-source",
      evidenceIds: ids,
    },
  ];
  const { section, prompt } = await rankedPrompt(r);
  assert.equal(section.status, "complete");
  assert.ok(ids.every((id) => section.omittedEvidenceIds.includes(id)));
  assert.ok(ids.every((id) => !prompt.evidence.some((e) => e.id === id)));
  assert.ok(
    section.omittedEvidenceGroups.some(
      (group) =>
        JSON.stringify(group.evidenceIds) === JSON.stringify(ids) &&
        group.reason === "group-budget",
    ),
  );
});

test("group ranking is stable by path and numeric range regardless of input order", async () => {
  const r = report();
  r.policy.findings = [];
  r.evidence = [
    {
      ...evidence[0],
      id: "a-late",
      path: "same.js",
      range: [100, 110],
      excerpt: "later",
    },
    {
      ...evidence[0],
      id: "z-early",
      path: "same.js",
      range: [2, 7],
      excerpt: "early",
    },
  ];
  r.cues = r.evidence.map((e) => ({
    ruleId: "syntax-network-call",
    literalStatus: "no-static-literal",
    evidenceIds: [e.id],
  }));
  const first = await rankedPrompt(r);
  r.evidence.reverse();
  r.cues.reverse();
  const second = await rankedPrompt(r);
  assert.equal(first.section.promptHash, second.section.promptHash);
  assert.deepEqual(
    first.prompt.evidence.map((e) => e.id),
    ["z-early", "a-late"],
  );
});

test("novelty priority requires changed or artifact-only correspondence", async () => {
  const r = rankedFixture();
  for (const [id, path, state] of [
    ["changed", "zzz-changed.js", "changed"],
    ["unchanged", "aaa-unchanged.js", "byte-identical"],
    ["other", "bbb-other.js", "changed"],
  ]) {
    r.evidence.push({ ...evidence[0], id, path, excerpt: "opaque literal" });
    r.files.push({ path, state });
    r.cues.push({
      ruleId: "syntax-network-call",
      literalStatus:
        id === "other"
          ? "found-in-inspected-source"
          : "not-found-in-inspected-source",
      evidenceIds: [id],
    });
  }
  const { section, prompt } = await rankedPrompt(r);
  assert.equal(section.status, "complete");
  assert.deepEqual(
    prompt.evidence.slice(0, 3).map((e) => e.id),
    ["changed", "unchanged", "other"],
  );
});

test("a missing referenced snippet omits the whole group and sends only scope", async () => {
  const r = report();
  r.policy.findings = [];
  r.evidence.push({
    id: "unretained-source",
    path: "source.js",
    side: "source",
    range: [0, 10],
  });
  r.cues = [
    {
      ruleId: "syntax-network-call",
      literalStatus: "found-in-inspected-source",
      evidenceIds: ["e1", "unretained-source"],
    },
  ];
  const prompts = [];
  const section = await client(async (url, options) => {
    prompts.push(JSON.parse(options.body).contents[0].parts[0].text);
    return url.endsWith(":countTokens")
      ? new Response('{"totalTokens":100}')
      : output({ hypotheses: [] });
  }).explain(r, { allowLocal: true });
  assert.equal(section.status, "complete");
  assert.deepEqual(section.hypotheses, []);
  assert.ok(prompts.every((text) => !text.includes("node setup.js")));
  assert.deepEqual(JSON.parse(prompts[0]).evidence, []);
  assert.deepEqual(section.omittedEvidenceIds, ["e1", "unretained-source"]);
  assert.equal(section.omittedEvidenceGroups[0].reason, "unavailable-evidence");
  assert.equal(section.evidenceGroups.length, 0);
});

test("a file source reference alone never enriches or pairs an unrelated cue", async () => {
  const r = report();
  r.policy.findings = [];
  r.evidence.push({
    ...evidence[0],
    id: "file-source",
    side: "source",
    path: "different/file.js",
    excerpt: "previous logic",
  });
  r.files = [
    {
      path: "package.json",
      state: "changed",
      evidenceIds: ["e1", "file-source"],
    },
  ];
  r.cues = [
    {
      ruleId: "syntax-network-call",
      literalStatus: "not-found-in-inspected-source",
      evidenceIds: ["e1"],
    },
  ];
  const { section, prompt } = await rankedPrompt(r);
  assert.equal(section.status, "complete");
  assert.equal(prompt.evidenceGroups[0].paired, false);
  assert.deepEqual(prompt.evidenceGroups[0].evidenceIds, ["e1"]);
});

test("large linked groups disclose all IDs rather than failing an incidental reference-count threshold", async () => {
  const r = rankedFixture(70);
  const ids = r.evidence.slice(0, 65).map((e) => e.id);
  r.cues = [
    {
      ruleId: "syntax-network-call",
      literalStatus: "found-in-inspected-source",
      evidenceIds: ids,
    },
  ];
  const { section } = await rankedPrompt(r);
  assert.equal(section.status, "complete");
  assert.ok(ids.every((id) => section.omittedEvidenceIds.includes(id)));
  assert.equal(section.omittedEvidenceGroups[0].reason, "group-budget");
});

for (const [state, path] of [
  ["changed", "zzz-logic.txt"],
  ["artifact-only", "zzz-package.json"],
]) {
  test(`unreferenced ${state} hunks outrank earlier unchanged context`, async () => {
    const r = rankedFixture();
    r.evidence.push({
      ...evidence[0],
      id: "late-change",
      path,
      range: [10, 20],
      excerpt: "new logic",
    });
    r.files.push({ path, state, evidenceIds: ["late-change"] });
    const { section, prompt } = await rankedPrompt(r);
    assert.equal(section.status, "complete");
    assert.equal(prompt.evidence[0].id, "late-change");
    assert.ok(!section.omittedEvidenceIds.includes("late-change"));
  });
}

function comparisonInput() {
  const r = report();
  r.policy.findings = [];
  r.evidence = [
    {
      id: "change-a",
      side: "artifact",
      path: "logic.js",
      range: [2, 5],
      excerpt: "new",
    },
    {
      id: "change-s",
      side: "source",
      path: "logic.js",
      range: [2, 5],
      excerpt: "old",
    },
  ];
  r.files = [
    {
      path: "logic.js",
      state: "changed",
      localization: "byte-spans",
      spans: { artifact: [2, 5], source: [2, 5] },
      evidenceIds: ["change-a", "change-s"],
    },
  ];
  return r;
}

test("same-path source existence without comparison spans never supplies pairing", async () => {
  const r = comparisonInput();
  delete r.files[0].spans;
  const { section, prompt } = await rankedPrompt(r, () => ({
    ...hypothesis(),
    category: "possible-transformation",
    citations: [
      { evidenceId: "change-a", quote: "new" },
      { evidenceId: "change-s", quote: "old" },
    ],
  }));
  assert.ok(prompt.evidenceGroups.every((group) => !group.paired));
  assert.equal(section.reason, "invalid-output");
});

test("artifact-only context cannot pair with same-path source without explicit AST link", async () => {
  const r = comparisonInput();
  r.files[0].state = "artifact-only";
  delete r.files[0].spans;
  const { prompt } = await rankedPrompt(r);
  assert.ok(prompt.evidenceGroups.every((group) => !group.paired));
});

test("explicit same-path comparison spans form a complete paired group", async () => {
  const r = comparisonInput();
  const { section, prompt } = await rankedPrompt(r, () => ({
    ...hypothesis(),
    category: "possible-transformation",
    citations: [
      { evidenceId: "change-a", quote: "new" },
      { evidenceId: "change-s", quote: "old" },
    ],
  }));
  assert.equal(section.status, "complete");
  assert.ok(
    prompt.evidenceGroups.some(
      (group) =>
        group.paired &&
        group.evidenceIds.includes("change-a") &&
        group.evidenceIds.includes("change-s"),
    ),
  );
});

test("unavailable comparison span omits the atomic pair rather than leaking its artifact half", async () => {
  const r = comparisonInput();
  delete r.evidence[1].excerpt;
  const prompts = [];
  const section = await client(async (url, options) => {
    prompts.push(JSON.parse(options.body).contents[0].parts[0].text);
    return url.endsWith(":countTokens")
      ? new Response('{"totalTokens":100}')
      : output({ hypotheses: [] });
  }).explain(r, { allowLocal: true });
  assert.equal(section.status, "complete");
  assert.ok(prompts.every((text) => !/"new"|change-a/.test(text)));
  assert.deepEqual(section.omittedEvidenceIds, ["change-a", "change-s"]);
  assert.ok(
    section.omittedEvidenceGroups.some(
      (group) =>
        group.reason === "unavailable-evidence" &&
        group.evidenceIds.length === 2,
    ),
  );
});

function manifestInput() {
  const r = report();
  r.policy.findings = [];
  const values = [
    ["manifest-a", "artifact", "new"],
    ["manifest-s", "source", "old"],
  ];
  r.evidence = values.map(([id, side, value]) => {
    const excerpt = JSON.stringify({ scripts: { install: value } });
    return {
      id,
      side,
      path: "package.json",
      range: [0, Buffer.byteLength(excerpt)],
      excerpt,
      excerptRange: [0, Buffer.byteLength(excerpt)],
    };
  });
  r.files = [
    {
      path: "package.json",
      state: "changed",
      evidenceIds: r.evidence.map((e) => e.id),
    },
  ];
  r.cues = [
    {
      module: "manifest",
      ruleId: "manifest-lifecycle-source-absent",
      field: "/scripts/install",
      evidenceIds: r.evidence.map((e) => e.id),
      bindings: r.evidence.map((e, index) => ({
        side: e.side,
        pointer: "/scripts/install",
        present: true,
        value: index === 0 ? "new" : "old",
        valueType: "string",
        evidenceIds: [e.id],
        evidenceScope: "whole-manifest",
        excerptRange: e.range,
        excerptOmitted: false,
      })),
    },
  ];
  return r;
}

test("explicit same-pointer manifest cue bindings supply paired context", async () => {
  const { section, prompt } = await rankedPrompt(manifestInput(), () => ({
    ...hypothesis(),
    category: "possible-transformation",
    citations: [
      { evidenceId: "manifest-a", quote: "new" },
      { evidenceId: "manifest-s", quote: "old" },
    ],
  }));
  assert.equal(section.status, "complete");
  assert.ok(prompt.evidenceGroups.some((group) => group.paired));
});

for (const change of [
  (r) => {
    r.cues[0].bindings[1].pointer = "/bin/unrelated";
  },
  (r) => {
    delete r.cues[0].bindings;
  },
  (r) => {
    r.cues[0].bindings[1].excerptOmitted = true;
  },
]) {
  test("incomplete or unrelated manifest bindings cannot claim paired context", async () => {
    const r = manifestInput();
    change(r);
    const { prompt } = await rankedPrompt(r);
    assert.ok(prompt.evidenceGroups.every((group) => !group.paired));
  });
}

test("truncated explicit comparison context remains eligible but unpaired", async () => {
  const r = comparisonInput();
  r.evidence[1].range = [2, 900];
  r.evidence[1].excerptRange = [2, 5];
  r.files[0].spans.source = [2, 900];
  const { section, prompt } = await rankedPrompt(r);
  assert.equal(section.status, "complete");
  assert.ok(prompt.evidence.some((e) => e.id === "change-a"));
  assert.ok(prompt.evidenceGroups.every((group) => !group.paired));
});

test("matching manifest pointer strings cannot pair a field absent from bounded evidence", async () => {
  const r = manifestInput();
  r.cues[0].field = "/scripts/unseen";
  for (const binding of r.cues[0].bindings) binding.pointer = "/scripts/unseen";
  const { prompt } = await rankedPrompt(r);
  assert.ok(prompt.evidenceGroups.every((group) => !group.paired));
});

test("policy ownership of one span does not hide the explicit complete comparison group", async () => {
  const r = comparisonInput();
  r.policy.findings = [
    { ruleId: "identity-claim-conflict", evidenceIds: ["change-a"] },
  ];
  const { section, prompt } = await rankedPrompt(r, () => ({
    ...hypothesis(),
    category: "possible-transformation",
    citations: [
      { evidenceId: "change-a", quote: "new" },
      { evidenceId: "change-s", quote: "old" },
    ],
  }));
  assert.equal(section.status, "complete");
  assert.ok(
    prompt.evidenceGroups.some(
      (group) => group.paired && group.evidenceIds.length === 2,
    ),
  );
});

test("a pure deletion keeps the nonempty changed source hunk eligible and unpaired", async () => {
  const r = rankedFixture();
  r.evidence.push(
    {
      id: "deleted-a",
      side: "artifact",
      path: "zzz-deletion.txt",
      range: [0, 0],
      excerpt: "",
      excerptRange: [0, 0],
    },
    {
      id: "deleted-s",
      side: "source",
      path: "zzz-deletion.txt",
      range: [0, 3],
      excerpt: "old",
      excerptRange: [0, 3],
    },
  );
  r.files.push({
    path: "zzz-deletion.txt",
    state: "changed",
    spans: { artifact: [0, 0], source: [0, 3] },
    evidenceIds: ["deleted-a", "deleted-s"],
  });
  const { section, prompt } = await rankedPrompt(r);
  assert.equal(section.status, "complete");
  assert.equal(prompt.evidence[0].id, "deleted-s");
  assert.ok(
    prompt.evidenceGroups
      .filter((group) => group.evidenceIds.includes("deleted-s"))
      .every((group) => !group.paired),
  );
  assert.ok(section.omittedEvidenceIds.includes("deleted-a"));
});

const testRoute = [
  { modelId: "gemini-3.5-flash", thinkingLevel: "high" },
  { modelId: "gemini-3.5-flash-lite", thinkingLevel: "minimal" },
];
function routedClient(fetchImpl, options = {}) {
  return createGemmaClient({
    apiKey: "test-only-key",
    provider: "google",
    quotaVerified: true,
    dailyRequests: 40,
    requestsPerMinute: 40,
    inputTokensPerMinute: 200000,
    route: testRoute,
    totalMs: 90000,
    fetchImpl,
    ...options,
  });
}
function scopedQuota(model, { daily = false, global = false } = {}) {
  return {
    error: {
      status: "RESOURCE_EXHAUSTED",
      message: "synthetic quota diagnostic test-only-key",
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.QuotaFailure",
          violations: [
            {
              quotaMetric:
                "generativelanguage.googleapis.com/generate_content_requests",
              quotaId: daily
                ? "GenerateRequestsPerDayPerProjectPerModel"
                : "GenerateRequestsPerMinutePerProjectPerModel",
              quotaDimensions: global ? {} : { model, location: "global" },
            },
          ],
        },
      ],
    },
  };
}

test("explicit synthetic ordered route falls from high to minimal on transient generation failure with exact accounting", async () => {
  const seen = [];
  const model = routedClient(async (url, options) => {
    assert.equal(
      new URL(url).origin,
      "https://generativelanguage.googleapis.com",
    );
    const body = JSON.parse(options.body);
    seen.push({ url, config: body.generationConfig });
    if (url.endsWith(":countTokens"))
      return new Response('{"totalTokens":100}');
    if (url.includes("gemini-3.5-flash:"))
      return new Response("private transient diagnostic", {
        status: 503,
        headers: { "Retry-After": "0" },
      });
    return output({ hypotheses: [hypothesis()] });
  });
  const before = JSON.stringify(report());
  const result = await model.explain(report(), { allowLocal: true });
  assert.equal(result.status, "complete");
  assert.equal(result.modelId, "gemini-3.5-flash-lite");
  assert.equal(result.generationConfig.thinkingConfig.thinkingLevel, "minimal");
  assert.deepEqual(
    seen
      .filter((item) => item.config)
      .map((item) => item.config.thinkingConfig.thinkingLevel),
    ["high", "minimal"],
  );
  assert.equal(result.preflightCalls, 2);
  assert.equal(result.attempts, 2);
  assert.deepEqual(
    result.attemptLog.map((item) => [
      item.modelId,
      item.preflightCalls,
      item.attempts,
      item.status,
    ]),
    [
      ["gemini-3.5-flash", 1, 1, "unavailable"],
      ["gemini-3.5-flash-lite", 1, 1, "complete"],
    ],
  );
  assert.equal(result.attemptLog[0].reason, "provider");
  assert.equal(result.attemptLog[0].httpStatus, 503);
  assert.deepEqual(
    result.route.map((item) => item.modelId),
    testRoute.map((item) => item.modelId),
  );
  assert.equal(result.configHash, model.configHash);
  assert.equal(JSON.stringify(report()), before);
  assert.doesNotMatch(
    JSON.stringify(result),
    /test-only-key|private transient/,
  );
});

test("explicit model-scoped minute quota permits fallback and Retry-After shares the total budget", async () => {
  let time = 0;
  const waits = [],
    seen = [];
  const model = routedClient(
    async (url) => {
      seen.push(url);
      if (url.endsWith(":countTokens"))
        return new Response('{"totalTokens":100}');
      if (url.includes("gemini-3.5-flash:"))
        return new Response(JSON.stringify(scopedQuota("gemini-3.5-flash")), {
          status: 429,
          headers: { "Retry-After": "2" },
        });
      assert.equal(time, 2000);
      return output({ hypotheses: [hypothesis()] });
    },
    {
      now: () => time,
      sleep: async (ms) => {
        waits.push(ms);
        time += ms;
      },
    },
  );
  const result = await model.explain(report(), { allowLocal: true });
  assert.equal(result.status, "complete");
  assert.deepEqual(waits, [2000]);
  assert.equal(seen.length, 4);
  assert.equal(result.attemptLog[0].failureScope, "model");
  assert.equal(result.attemptLog[0].reason, "quota");
  assert.equal(result.attemptLog[1].modelId, "gemini-3.5-flash-lite");
});

for (const [name, body] of [
  ["global", scopedQuota("gemini-3.5-flash", { global: true })],
  [
    "project-daily",
    scopedQuota("gemini-3.5-flash", { daily: true, global: true }),
  ],
  ["unknown", { error: { message: "quota for this project" } }],
  ["different-model", scopedQuota("another-model")],
])
  test(`ordered route fails closed for ${name} quota without switching tiers`, async () => {
    const seen = [];
    let sleeps = 0;
    const result = await routedClient(
      async (url) => {
        seen.push(url);
        return url.endsWith(":countTokens")
          ? new Response('{"totalTokens":100}')
          : new Response(JSON.stringify(body), {
              status: 429,
              headers: { "Retry-After": "0" },
            });
      },
      {
        sleep: async () => {
          sleeps++;
        },
      },
    ).explain(report(), { allowLocal: true });
    assert.equal(result.status, "unavailable");
    assert.equal(result.reason, "quota");
    assert.equal(seen.length, 2);
    assert.ok(seen.every((url) => url.includes("gemini-3.5-flash:")));
    assert.equal(sleeps, 0);
    assert.equal(result.attempts, 1);
  });

test("fallback tiers share quota reservations and cannot reset the generation budget", async () => {
  const seen = [];
  const model = routedClient(
    async (url) => {
      seen.push(url);
      return url.endsWith(":countTokens")
        ? new Response('{"totalTokens":100}')
        : new Response("transient", {
            status: 503,
            headers: { "Retry-After": "0" },
          });
    },
    { dailyRequests: 3 },
  );
  const result = await model.explain(report(), { allowLocal: true });
  assert.equal(result.reason, "quota");
  assert.equal(result.preflightCalls, 2);
  assert.equal(result.attempts, 1);
  assert.equal(seen.length, 3);
  assert.equal(result.attemptLog[1].failureScope, "local");
  assert.equal(
    (await model.explain(report(), { allowLocal: true })).reason,
    "quota",
  );
  assert.equal(seen.length, 3);
});

test("route identity binds ordered tiers and full configurations but excludes credentials", () => {
  const forbidden = () => {
    throw new Error("synthetic transport must not run");
  };
  const model = routedClient(forbidden);
  const hash = model.configHash;
  assert.equal(model.modelId, "gemini-3.5-flash");
  assert.deepEqual(
    model.configuration.route.map((item) => [
      item.modelId,
      item.generationConfig.thinkingConfig.thinkingLevel,
    ]),
    [
      ["gemini-3.5-flash", "high"],
      ["gemini-3.5-flash-lite", "minimal"],
    ],
  );
  assert.equal(
    routedClient(forbidden, { apiKey: "another-synthetic-key" }).configHash,
    hash,
  );
  assert.notEqual(
    routedClient(forbidden, { route: [...testRoute].reverse() }).configHash,
    hash,
  );
  assert.notEqual(
    routedClient(forbidden, { maxOutputTokens: 900 }).configHash,
    hash,
  );
  const snapshot = model.configuration;
  snapshot.route[0].generationConfig.temperature = 1;
  assert.equal(model.configuration.route[0].generationConfig.temperature, 0);
  assert.doesNotMatch(JSON.stringify(model.configuration), /test-only-key/);
  for (const route of [
    [],
    [{ modelId: "unapproved", thinkingLevel: "high" }],
    [{ ...testRoute[0], endpoint: "https://elsewhere.invalid" }],
  ])
    assert.throws(() => routedClient(forbidden, { route }), /route|model/i);
});

test("default Google route is 3 Flash minimal then Gemma minimal; explicit IDs never expand", () => {
  const forbidden = () => {
    throw new Error("synthetic transport must not run");
  };
  const base = {
    apiKey: "synthetic-marker",
    provider: "google",
    localLimits: {
      generationsPerMinute: 2,
      inputTokensPerMinute: 8000,
      generationsPerDay: 100,
    },
    fetchImpl: forbidden,
  };
  const model = createGemmaClient(base);
  assert.deepEqual(
    model.configuration.route.map((item) => [
      item.modelId,
      item.generationConfig.thinkingConfig.thinkingLevel,
    ]),
    [
      ["gemini-3-flash-preview", "minimal"],
      ["gemma-4-26b-a4b-it", "minimal"],
    ],
  );
  assert.equal(model.configuration.providerQuota, "unknown");
  assert.equal(model.configuration.enabled, true);
  for (const modelId of [
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite",
    "gemma-4-31b-it",
    "gemma-4-26b-a4b-it",
  ]) {
    const selected = createGemmaClient({ ...base, modelId });
    assert.equal(selected.configuration.route.length, 1);
    assert.equal(selected.modelId, modelId);
  }
});

test("local generation caps allow preflight plus two tiers but remain shared across calls and days", async () => {
  let time = 0,
    day = 0;
  const seen = [];
  const model = createGemmaClient({
    apiKey: "test-only-key",
    provider: "google",
    localLimits: {
      generationsPerMinute: 2,
      inputTokensPerMinute: 8000,
      generationsPerDay: 2,
    },
    now: () => time,
    wallNow: () => day,
    fetchImpl: async (url) => {
      seen.push(url);
      if (url.endsWith(":countTokens"))
        return new Response('{"totalTokens":100}');
      if (url.includes("gemini-3-flash-preview:"))
        return new Response("synthetic transient", {
          status: 503,
          headers: { "Retry-After": "0" },
        });
      return output({ hypotheses: [hypothesis()] });
    },
  });
  const result = await model.explain(report(), { allowLocal: true });
  assert.equal(result.status, "complete");
  assert.equal(result.attempts, 2);
  assert.equal(result.preflightCalls, 2);
  assert.equal(result.providerQuota, "unknown");
  assert.equal(seen.length, 4);
  assert.equal(
    (await model.explain(report(), { allowLocal: true })).reason,
    "quota",
  );
  assert.equal(seen.length, 4);
  time = 60000;
  assert.equal(
    (await model.explain(report(), { allowLocal: true })).reason,
    "quota",
  );
  day = 86400000;
  assert.equal(
    (await model.explain(report(), { allowLocal: true })).status,
    "complete",
  );
  assert.equal(seen.length, 8);
});

test("shared factory enables bounded local caps without pretending upstream quotas were verified", async () => {
  const { modelClientFromEnv } = await import("../../src/model/config.mjs");
  const env = { UNMASK_MODEL: "on", GEMINI_API_KEY: "test-only-key" };
  const model = await modelClientFromEnv(env);
  assert.equal(model.configuration.enabled, true);
  assert.equal(model.modelId, "gemini-3-flash-preview");
  assert.equal(model.configuration.route.length, 2);
  assert.equal(model.configuration.providerQuota, "unknown");
  assert.equal(model.configuration.quota.counting, "generations");
  assert.deepEqual(model.configuration.localLimits, {
    generationsPerMinute: 3,
    inputTokensPerMinute: 12000,
    generationsPerDay: 100,
  });
  const unverified = await modelClientFromEnv({
    ...env,
    UNMASK_MODEL_QUOTA_VERIFIED: "false",
  });
  assert.equal(unverified.configHash, model.configHash);
  const override = await modelClientFromEnv({
    ...env,
    UNMASK_MODEL_ID: "gemma-4-26b-a4b-it",
  });
  assert.equal(override.configuration.route.length, 1);
  assert.equal(override.modelId, "gemma-4-26b-a4b-it");
  const legacy = await modelClientFromEnv({
    ...env,
    UNMASK_MODEL_QUOTA_VERIFIED: "true",
    UNMASK_MODEL_REQUESTS_PER_MINUTE: "20",
    UNMASK_MODEL_DAILY_REQUESTS: "100",
    UNMASK_MODEL_INPUT_TOKENS_PER_MINUTE: "20000",
  });
  assert.equal(legacy.configuration.quota.counting, "requests");
  assert.equal(legacy.configuration.providerQuota, "unknown");
  assert.equal(legacy.configuration.operatorDeclaredVerified, true);
  for (const extra of [
    {
      UNMASK_MODEL_QUOTA_VERIFIED: "true",
      UNMASK_MODEL_REQUESTS_PER_MINUTE: "20",
      UNMASK_MODEL_DAILY_REQUESTS: "100",
      UNMASK_MODEL_GENERATIONS_PER_MINUTE: "2",
    },
    { UNMASK_MODEL_GENERATIONS_PER_MINUTE: "0" },
    { UNMASK_MODEL_GENERATIONS_PER_DAY: "1e2" },
    { UNMASK_MODEL_INPUT_TOKENS_PER_MINUTE: "" },
    { UNMASK_MODEL_QUOTA_VERIFIED: "yes" },
    { UNMASK_MODEL_ROUTE: '[{"modelId":"unapproved","thinkingLevel":"high"}]' },
  ])
    await assert.rejects(
      modelClientFromEnv({ ...env, ...extra }),
      /config|limits|route|quota/i,
    );
  assert.doesNotMatch(JSON.stringify(model.configuration), /test-only-key/);
});

test("routing timeout aborts the high attempt, advances once, and ignores late provider completion", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let time = 0,
    resolveLate,
    highSignal;
  const seen = [];
  const model = routedClient(
    async (url, options) => {
      seen.push(url);
      if (url.endsWith(":countTokens"))
        return new Response('{"totalTokens":100}');
      if (url.includes("gemini-3.5-flash:")) {
        highSignal = options.signal;
        queueMicrotask(() => {
          time = 45000;
          t.mock.timers.tick(45000);
        });
        return new Promise((resolve) => {
          resolveLate = resolve;
        });
      }
      return output({ hypotheses: [hypothesis()] });
    },
    { now: () => time },
  );
  const result = await model.explain(report(), { allowLocal: true });
  assert.equal(result.status, "complete");
  assert.equal(highSignal.aborted, true);
  assert.equal(result.modelId, "gemini-3.5-flash-lite");
  assert.equal(result.attemptLog[0].reason, "timeout");
  assert.equal(result.attemptLog[0].latencyMs, 45000);
  assert.equal(result.attempts, 2);
  assert.equal(result.preflightCalls, 2);
  resolveLate(output({ hypotheses: [hypothesis()] }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(seen.length, 4);
});

for (const status of [401, 403, 400])
  test(`ordered route stops on HTTP ${status} and never advances to the cheaper tier`, async () => {
    const seen = [];
    const result = await routedClient(async (url) => {
      seen.push(url);
      return url.endsWith(":countTokens")
        ? new Response('{"totalTokens":100}')
        : new Response("private", { status });
    }).explain(report(), { allowLocal: true });
    assert.equal(result.status, "unavailable");
    assert.equal(result.reason, "provider");
    assert.equal(result.attempts, 1);
    assert.equal(result.attemptLog.length, 1);
    assert.equal(
      result.attemptLog[0].failureScope,
      status === 400 ? "input" : "auth",
    );
    assert.equal(seen.length, 2);
    assert.ok(seen.every((url) => url.includes("gemini-3.5-flash:")));
  });

test("invalid output retries only the current tier while over-budget input never generates or falls through", async () => {
  const seen = [];
  const invalid = await routedClient(async (url) => {
    seen.push(url);
    return url.endsWith(":countTokens")
      ? new Response('{"totalTokens":100}')
      : new Response("{}");
  }).explain(report(), { allowLocal: true });
  assert.equal(invalid.reason, "invalid-output");
  assert.equal(invalid.attempts, 2);
  assert.ok(seen.every((url) => url.includes("gemini-3.5-flash:")));
  const counts = [];
  const input = await routedClient(async (url) => {
    counts.push(url);
    return new Response('{"totalTokens":4001}');
  }).explain(report(), { allowLocal: true });
  assert.equal(input.reason, "input-budget");
  assert.equal(input.attempts, 0);
  assert.equal(counts.length, 1);
});

test("Retry-After cannot escape the ninety-second total route budget", async () => {
  let sleeps = 0;
  const seen = [];
  const blocked = await routedClient(
    async (url) => {
      seen.push(url);
      return url.endsWith(":countTokens")
        ? new Response('{"totalTokens":100}')
        : new Response(JSON.stringify(scopedQuota("gemini-3.5-flash")), {
            status: 429,
            headers: { "Retry-After": "1000" },
          });
    },
    {
      sleep: async () => {
        sleeps++;
      },
    },
  ).explain(report(), { allowLocal: true });
  assert.equal(blocked.reason, "quota");
  assert.equal(sleeps, 0);
  assert.equal(seen.length, 2);
  let time = 0,
    counts = 0,
    generations = 0;
  const expired = await routedClient(
    async (url) => {
      if (url.endsWith(":countTokens")) {
        if (++counts === 2) time += 2000;
        return new Response('{"totalTokens":100}');
      }
      generations++;
      time = 1000;
      return new Response("transient", {
        status: 503,
        headers: { "Retry-After": "88" },
      });
    },
    {
      now: () => time,
      sleep: async (ms) => {
        time += ms;
      },
    },
  ).explain(report(), { allowLocal: true });
  assert.equal(expired.reason, "timeout");
  assert.equal(expired.attempts, 1);
  assert.equal(expired.preflightCalls, 2);
  assert.equal(generations, 1);
  assert.equal(expired.latencyMs, 91000);
});

test("quota model dimensions cannot bypass an explicitly project-wide quota identifier", async () => {
  const body = scopedQuota("gemini-3.5-flash");
  body.error.details[0].violations[0].quotaId =
    "GenerateRequestsPerMinutePerProject";
  const seen = [];
  const result = await routedClient(async (url) => {
    seen.push(url);
    return url.endsWith(":countTokens")
      ? new Response('{"totalTokens":100}')
      : new Response(JSON.stringify(body), { status: 429 });
  }).explain(report(), { allowLocal: true });
  assert.equal(result.reason, "quota");
  assert.equal(result.attemptLog[0].failureScope, "global");
  assert.equal(seen.length, 2);
});

test("a model-specific quota entry cannot override daily or unknown ErrorInfo", async () => {
  for (const reason of ["DAILY_LIMIT_EXCEEDED", "UNKNOWN_QUOTA_SCOPE"]) {
    const body = scopedQuota("gemini-3.5-flash");
    body.error.details.push({
      "@type": "type.googleapis.com/google.rpc.ErrorInfo",
      reason,
      metadata: {},
    });
    let calls = 0;
    const result = await routedClient(async (url) => {
      calls++;
      return url.endsWith(":countTokens")
        ? new Response('{"totalTokens":100}')
        : new Response(JSON.stringify(body), {
            status: 429,
            headers: { "Retry-After": "0" },
          });
    }).explain(report(), { allowLocal: true });
    assert.equal(result.reason, "quota");
    assert.equal(result.attempts, 1);
    assert.equal(calls, 2);
  }
});

test("an explicit model override cannot silently expand through a simultaneous multi-tier route", async () => {
  const forbidden = () => {
    throw new Error("synthetic transport must not run");
  };
  assert.throws(
    () => routedClient(forbidden, { modelId: "gemini-3.5-flash" }),
    /route/i,
  );
  const { modelClientFromEnv } = await import("../../src/model/config.mjs");
  await assert.rejects(
    modelClientFromEnv({
      UNMASK_MODEL: "on",
      GEMINI_API_KEY: "test-only-key",
      UNMASK_MODEL_ID: "gemini-3.5-flash",
      UNMASK_MODEL_ROUTE: JSON.stringify(testRoute),
    }),
    /route/i,
  );
});

test("local limits are snapshotted so caller mutations cannot contradict the routing digest", () => {
  const limits = {
    generationsPerMinute: 2,
    inputTokensPerMinute: 8000,
    generationsPerDay: 100,
  };
  const model = createGemmaClient({
    apiKey: "test-only-key",
    provider: "google",
    localLimits: limits,
    fetchImpl: () => {
      throw new Error("synthetic transport must not run");
    },
  });
  const before = model.configHash;
  limits.generationsPerMinute = 99;
  assert.equal(model.configuration.localLimits.generationsPerMinute, 2);
  assert.equal(model.configHash, before);
});

test("only explicit model-bound minute or daily quota windows permit tier fallthrough", async () => {
  for (const [window, allowed] of [
    ["Hour", false],
    ["", false],
    ["Minute", true],
    ["Day", true],
  ]) {
    const body = scopedQuota("gemini-3.5-flash");
    body.error.details[0].violations[0].quotaId = `GenerateRequestsPer${window}PerProjectPerModel`;
    const seen = [];
    const result = await routedClient(async (url) => {
      seen.push(url);
      if (url.endsWith(":countTokens"))
        return new Response('{"totalTokens":100}');
      if (url.includes("gemini-3.5-flash:"))
        return new Response(JSON.stringify(body), {
          status: 429,
          headers: { "Retry-After": "0" },
        });
      return output({ hypotheses: [hypothesis()] });
    }).explain(report(), { allowLocal: true });
    assert.equal(result.status, allowed ? "complete" : "unavailable", window);
    assert.equal(result.attempts, allowed ? 2 : 1, window);
    assert.equal(seen.length, allowed ? 4 : 2, window);
  }
  for (const window of ["Hour", ""]) {
    const body = scopedQuota("gemini-3.5-flash");
    body.error.details.push({
      "@type": "type.googleapis.com/google.rpc.ErrorInfo",
      reason: "RATE_LIMIT_EXCEEDED",
      metadata: {
        model: "gemini-3.5-flash",
        quota_limit: `GenerateRequestsPer${window}PerProjectPerModel`,
      },
    });
    let calls = 0;
    const result = await routedClient(async (url) => {
      calls++;
      return url.endsWith(":countTokens")
        ? new Response('{"totalTokens":100}')
        : new Response(JSON.stringify(body), {
            status: 429,
            headers: { "Retry-After": "0" },
          });
    }).explain(report(), { allowLocal: true });
    assert.equal(result.reason, "quota");
    assert.equal(result.attempts, 1);
    assert.equal(calls, 2);
  }
});

test("three explicit tiers have at most one transient generation each within shared limits", async () => {
  const route = [
    { modelId: "gemini-3.5-flash", thinkingLevel: "high" },
    { modelId: "gemini-3-flash-preview", thinkingLevel: "minimal" },
    { modelId: "gemma-4-26b-a4b-it", thinkingLevel: "minimal" },
  ];
  for (const [rate, elapsed, allowed] of [
    [2, false, false],
    [2, true, true],
    [3, false, true],
  ]) {
    let time = 0;
    const seen = [];
    const model = createGemmaClient({
      apiKey: "test-only-key",
      provider: "google",
      route,
      localLimits: {
        generationsPerMinute: rate,
        inputTokensPerMinute: rate * 4000,
        generationsPerDay: 100,
      },
      now: () => time,
      fetchImpl: async (url) => {
        seen.push(url);
        if (url.endsWith(":countTokens"))
          return new Response('{"totalTokens":100}');
        if (url.includes("gemma-4-26b-a4b-it:"))
          return output({ hypotheses: [hypothesis()] });
        if (elapsed) time += 31000;
        return new Response("transient", {
          status: 503,
          headers: { "Retry-After": "0" },
        });
      },
    });
    const result = await model.explain(report(), { allowLocal: true });
    assert.equal(result.routingPolicy.maxGenerationAttempts, 3);
    assert.equal(result.attempts, allowed ? 3 : 2);
    assert.equal(result.preflightCalls, allowed ? 3 : 2);
    assert.equal(result.status, allowed ? "complete" : "unavailable");
    assert.equal(result.limits.totalMs, 135000);
    if (allowed) assert.equal(result.modelId, "gemma-4-26b-a4b-it");
    else {
      assert.equal(result.reason, "quota");
      assert.equal(result.attemptLog.at(-1).failureScope, "local");
    }
    assert.equal(seen.length, allowed ? 6 : 4);
  }
});

test("default two-tier policy never sends a third generation", async () => {
  const seen = [];
  const model = createGemmaClient({
    apiKey: "test-only-key",
    provider: "google",
    localLimits: {
      generationsPerMinute: 3,
      inputTokensPerMinute: 12000,
      generationsPerDay: 100,
    },
    fetchImpl: async (url) => {
      seen.push(url);
      return url.endsWith(":countTokens")
        ? new Response('{"totalTokens":100}')
        : new Response("transient", {
            status: 503,
            headers: { "Retry-After": "0" },
          });
    },
  });
  const result = await model.explain(report(), { allowLocal: true });
  assert.equal(result.status, "unavailable");
  assert.equal(result.attempts, 2);
  assert.equal(result.preflightCalls, 2);
  assert.equal(seen.length, 4);
  assert.deepEqual(
    result.attemptLog.map((item) => item.modelId),
    ["gemini-3-flash-preview", "gemma-4-26b-a4b-it"],
  );
  assert.equal(result.limits.totalMs, 135000);
});

test("two-slot default invalid-output retries stay on the first tier and stop at two", async () => {
  const seen = [];
  const model = createGemmaClient({
    apiKey: "test-only-key",
    provider: "google",
    localLimits: {
      generationsPerMinute: 3,
      inputTokensPerMinute: 12000,
      generationsPerDay: 100,
    },
    fetchImpl: async (url) => {
      seen.push(url);
      return url.endsWith(":countTokens")
        ? new Response('{"totalTokens":100}')
        : new Response("{}");
    },
  });
  const result = await model.explain(report(), { allowLocal: true });
  assert.equal(result.reason, "invalid-output");
  assert.equal(result.attempts, 2);
  assert.equal(result.preflightCalls, 2);
  assert.equal(seen.length, 4);
  assert.ok(seen.every((url) => url.includes("gemini-3-flash-preview:")));
});

for (const inputLimit of [4000, 3200]) {
  test(`code-heavy packing reserves the complete prompt within ${inputLimit} input tokens`, async () => {
    const r = rankedFixture(16);
    for (const [index, item] of r.evidence.entries()) {
      item.id = `evidence-${String(index).padStart(3, "0")}-${"abcdef0123456789".repeat(4)}`;
      item.excerpt = 'const opaque = ["a", 1, {}, null];'
        .repeat(20)
        .slice(0, 512);
      item.range = [0, Buffer.byteLength(item.excerpt)];
      r.files[index].state = "changed";
    }
    r.policy.findings = [
      { ruleId: "lifecycle-source-absent", evidenceIds: [r.evidence[15].id] },
    ];
    const before = JSON.stringify(r);
    let prompt;
    let generations = 0;
    const section = await client(
      async (url, options) => {
        const text = JSON.parse(options.body).contents[0].parts[0].text;
        prompt = JSON.parse(text);
        if (url.endsWith(":countTokens"))
          return Response.json({
            totalTokens: Math.ceil(Buffer.byteLength(text) / 2),
          });
        generations++;
        const item = prompt.evidence[0];
        return output({
          hypotheses: [
            {
              ...hypothesis(),
              citations: [{ evidenceId: item.id, quote: item.excerpt }],
            },
          ],
        });
      },
      { maxInputTokens: inputLimit },
    ).explain(r, { allowLocal: true });
    assert.equal(section.status, "complete");
    assert.equal(generations, 1);
    assert.ok(Buffer.byteLength(JSON.stringify(prompt)) + 256 <= inputLimit);
    assert.equal(prompt.evidence[0].id, r.evidence[15].id);
    assert.ok(prompt.evidence.length > 0);
    assert.ok(section.omittedEvidenceIds.length > 0);
    assert.equal(JSON.stringify(r), before);
  });
}

test("conservative input packing retains a complete paired comparison", async () => {
  const r = comparisonInput();
  for (const item of r.evidence) {
    item.excerpt = item.side === "artifact" ? "a".repeat(512) : "s".repeat(512);
    item.range = [0, 512];
    item.excerptRange = [0, 512];
  }
  r.files[0].spans = { artifact: [0, 512], source: [0, 512] };
  const { section, prompt } = await rankedPrompt(r);
  assert.equal(section.status, "complete");
  assert.equal(prompt.evidence.length, 2);
  assert.equal(prompt.evidenceGroups[0].paired, true);
  assert.ok(Buffer.byteLength(JSON.stringify(prompt)) + 256 <= 4000);
});

test("an input envelope too small for one complete group sends no provider request", async () => {
  let requests = 0;
  const section = await client(
    () => {
      requests++;
      throw new Error("provider must not run without a complete bounded group");
    },
    { maxInputTokens: 500 },
  ).explain(report(), { allowLocal: true });
  assert.equal(requests, 0);
  assert.equal(section.reason, "input-budget");
  assert.deepEqual(section.omittedEvidenceIds, ["e1"]);
  assert.equal(section.omittedEvidenceGroups[0].reason, "group-budget");
});

test("Gemini output budget and JSON mode are explicit and identity bound", async () => {
  const requests = [];
  const model = createGemmaClient({
    apiKey: "synthetic-key",
    localLimits: {
      generationsPerMinute: 3,
      inputTokensPerMinute: 12000,
      generationsPerDay: 100,
    },
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url, body });
      return url.endsWith(":countTokens")
        ? new Response('{"totalTokens":100}')
        : output({ hypotheses: [hypothesis()] });
    },
  });
  assert.deepEqual(
    model.configuration.route.map(({ generationConfig: config }) => [
      config.maxOutputTokens,
      config.responseMimeType,
    ]),
    [
      [4096, "application/json"],
      [1000, undefined],
    ],
  );
  const result = await model.explain(report(), { allowLocal: true });
  assert.equal(result.status, "complete");
  assert.equal(result.generationConfig.maxOutputTokens, 4096);
  assert.equal(result.generationConfig.responseMimeType, "application/json");
  assert.match(
    JSON.parse(requests[0].body.contents[0].parts[0].text).task,
    /JSON only/u,
  );
  assert.deepEqual(requests[1].body.generationConfig, result.generationConfig);
  assert.notEqual(
    model.configHash,
    createGemmaClient({ apiKey: "synthetic-key", maxOutputTokens: 1000 })
      .configHash,
  );
  assert.throws(
    () => createGemmaClient({ apiKey: "synthetic-key", maxOutputTokens: 4097 }),
    /resource limits/u,
  );
});

test("prompt binds transformation category to paired citations and keeps unpaired output rejected", async () => {
  const prompts = [];
  const model = client(async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith(":countTokens")) {
      prompts.push(JSON.parse(body.contents[0].parts[0].text));
      return new Response('{"totalTokens":100}');
    }
    return output({
      hypotheses: [{ ...hypothesis(), category: "possible-transformation" }],
    });
  });
  const result = await model.explain(report(), { allowLocal: true });
  assert.equal(result.reason, "invalid-output");
  assert.ok(prompts.length > 0);
  for (const prompt of prompts) {
    assert.match(
      prompt.task,
      /possible-transformation is allowed ONLY for a supplied paired=true group/u,
    );
    assert.match(prompt.task, /cite BOTH artifact and source/u);
    assert.match(
      prompt.task,
      /For unpaired groups use unknown or review-concern only/u,
    );
    assert.match(
      prompt.task,
      /explanation 1–1000, uncertainty 1–500, alternative 1–500, citation quote 1–512/u,
    );
    assert.match(prompt.task, /1–8 citations/u);
    assert.equal(
      prompt.evidenceGroups.every((group) => !group.paired),
      true,
    );
  }
});

test("explicit current-model daily quota falls to next tier with separate calls and unchanged input", async () => {
  const seen = [];
  let sleeps = 0;
  const r = report();
  const before = JSON.stringify(r);
  const model = createGemmaClient({
    apiKey: "synthetic-key",
    provider: "google",
    sleep: async () => {
      sleeps++;
    },
    localLimits: {
      generationsPerMinute: 3,
      inputTokensPerMinute: 12000,
      generationsPerDay: 100,
    },
    fetchImpl: async (url) => {
      seen.push(url);
      if (url.endsWith(":countTokens"))
        return new Response('{"totalTokens":100}');
      if (url.includes("gemini-3-flash-preview:"))
        return Response.json(
          scopedQuota("gemini-3-flash-preview", { daily: true }),
          { status: 429, headers: { "Retry-After": "86400" } },
        );
      return output({ hypotheses: [hypothesis()] });
    },
  });
  const result = await model.explain(r, { allowLocal: true });
  assert.equal(result.status, "complete");
  assert.equal(sleeps, 0);
  assert.equal(result.modelId, "gemma-4-26b-a4b-it");
  assert.equal(result.attempts, 2);
  assert.equal(result.preflightCalls, 2);
  assert.equal(seen.length, 4);
  assert.equal(result.attemptLog[0].failureScope, "model-daily");
  assert.equal(JSON.stringify(r), before);
});

test("daily quota with global, missing or wrong-model bindings never shops another model", async () => {
  for (const variant of [
    "global",
    "project-id",
    "wrong-model",
    "unbound-info",
    "mixed-global",
    "unknown-scope-info",
    "global-info",
  ]) {
    const body = scopedQuota("gemini-3-flash-preview", { daily: true });
    const violation = body.error.details[0].violations[0];
    if (variant === "global") violation.quotaDimensions = {};
    if (variant === "project-id")
      violation.quotaId = "GenerateRequestsPerDayPerProject";
    if (variant === "wrong-model")
      violation.quotaDimensions.model = "another-model";
    if (variant === "unbound-info")
      body.error.details.push({
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "DAILY_LIMIT_EXCEEDED",
        metadata: {},
      });
    if (variant === "mixed-global")
      body.error.details[0].violations.push({
        quotaId: "GenerateRequestsPerDayPerProject",
        quotaDimensions: {},
      });
    if (["unknown-scope-info", "global-info"].includes(variant))
      body.error.details.push({
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "DAILY_LIMIT_EXCEEDED",
        metadata: {
          model: "gemini-3-flash-preview",
          scope: variant === "global-info" ? "project" : "unknown",
          quota_limit: "GenerateRequestsPerDayPerProjectPerModel",
        },
      });
    const seen = [];
    const model = createGemmaClient({
      apiKey: "synthetic-key",
      provider: "google",
      localLimits: {
        generationsPerMinute: 3,
        inputTokensPerMinute: 12000,
        generationsPerDay: 100,
      },
      fetchImpl: async (url) => {
        seen.push(url);
        return url.endsWith(":countTokens")
          ? Response.json({ totalTokens: 100 })
          : Response.json(body, {
              status: 429,
              headers: { "Retry-After": "0" },
            });
      },
    });
    const result = await model.explain(report(), { allowLocal: true });
    assert.equal(result.status, "unavailable", variant);
    assert.equal(result.reason, "quota", variant);
    assert.equal(result.attempts, 1, variant);
    assert.equal(seen.length, 2, variant);
  }
});

test("model-daily without another tier and exhausted local daily allowance remain terminal", async () => {
  let calls = 0;
  const single = client(async (url) => {
    calls++;
    return url.endsWith(":countTokens")
      ? Response.json({ totalTokens: 100 })
      : Response.json(scopedQuota("gemma-4-26b-a4b-it", { daily: true }), {
          status: 429,
          headers: { "Retry-After": "0" },
        });
  });
  const stopped = await single.explain(report(), { allowLocal: true });
  assert.equal(stopped.attempts, 1);
  assert.equal(calls, 2);
  calls = 0;
  const limited = createGemmaClient({
    apiKey: "synthetic-key",
    localLimits: {
      generationsPerMinute: 3,
      inputTokensPerMinute: 12000,
      generationsPerDay: 1,
    },
    fetchImpl: async (url) => {
      calls++;
      return url.endsWith(":countTokens")
        ? Response.json({ totalTokens: 100 })
        : Response.json(
            scopedQuota("gemini-3-flash-preview", { daily: true }),
            { status: 429, headers: { "Retry-After": "0" } },
          );
    },
  });
  const result = await limited.explain(report(), { allowLocal: true });
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "quota");
  assert.equal(result.attempts, 1);
  assert.equal(calls, 2);
  assert.equal(result.attemptLog.at(-1).failureScope, "local");
});

test("committed release expectations bind final default route, thinking and policy digest", () => {
  const model = createGemmaClient({
    apiKey: "synthetic-key",
    provider: "google",
    localLimits: {
      generationsPerMinute: 3,
      inputTokensPerMinute: 12000,
      generationsPerDay: 100,
    },
    fetchImpl: () => {
      throw new Error("Network forbidden");
    },
  });
  const config = JSON.parse(
    readFileSync(
      new URL("../../deployment.config.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(model.configuration.routingPolicy.version, "ordered-fallback-2");
  assert.equal(model.configuration.routingPolicy.maxGenerationAttempts, 2);
  assert.deepEqual(
    config.modelExpectation.routes,
    model.configuration.route.map((tier) => ({
      provider: "google",
      endpointHost: "generativelanguage.googleapis.com",
      modelId: tier.modelId,
      configHash: model.configHash,
      generationConfig: tier.generationConfig,
    })),
  );
});

test("supplemental unknown and authentication ErrorInfo prevents quota fallback", async () => {
  for (const reason of ["UNKNOWN_QUOTA_SCOPE", "API_KEY_INVALID"]) {
    const body = scopedQuota("gemini-3-flash-preview", { daily: true });
    body.error.details.push({
      "@type": "type.googleapis.com/google.rpc.ErrorInfo",
      reason,
      metadata: {
        model: "gemini-3-flash-preview",
        quota_limit: "GenerateRequestsPerDayPerProjectPerModel",
      },
    });
    let calls = 0;
    const model = createGemmaClient({
      apiKey: "synthetic-key",
      localLimits: {
        generationsPerMinute: 3,
        inputTokensPerMinute: 12000,
        generationsPerDay: 100,
      },
      fetchImpl: async (url) => {
        calls++;
        return url.endsWith(":countTokens")
          ? Response.json({ totalTokens: 100 })
          : Response.json(body, { status: 429 });
      },
    });
    const result = await model.explain(report(), { allowLocal: true });
    assert.equal(result.status, "unavailable");
    assert.equal(result.attempts, 1);
    assert.equal(calls, 2);
    assert.equal(result.attemptLog[0].failureScope, "unknown");
  }
});

test("route validation rejects duplicate models even with different thinking levels", () => {
  assert.throws(
    () =>
      createGemmaClient({
        apiKey: "synthetic-key",
        route: [
          { modelId: "gemini-3-flash-preview", thinkingLevel: "minimal" },
          { modelId: "gemini-3-flash-preview", thinkingLevel: "high" },
        ],
      }),
    /Invalid model route/u,
  );
});
