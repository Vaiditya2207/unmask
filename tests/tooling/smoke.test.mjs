import assert from "node:assert/strict";
import { test } from "node:test";
import { smokeHttpCandidate } from "../../scripts/smoke-candidate.mjs";

const identity = {
  version: "1.0.0",
  commit: "a".repeat(40),
  tarballSha256: "b".repeat(64),
};
const location = `/r/${"c".repeat(32)}`;
function transport({
  wrongVersion = false,
  failedJob = false,
  wrongClaim = false,
  model,
  evidence = [],
} = {}) {
  const calls = [];
  let polls = 0;
  const report = {
    inputs: {
      artifact: { kind: "registry", sha256: "d".repeat(64) },
      claim: { name: "fixture", version: wrongClaim ? "2.0.0" : "1.0.0" },
    },
    evidence,
    policy: { exitCode: 3 },
    model: model ?? { status: "disabled" },
  };
  return {
    calls,
    fetchImpl: async (url, options = {}) => {
      const route = new URL(url).pathname;
      calls.push({ route, method: options.method ?? "GET" });
      if (route === "/healthz") return new Response('{"status":"ok"}');
      if (route === "/version")
        return Response.json({
          ...identity,
          commit: wrongVersion ? "f".repeat(40) : identity.commit,
        });
      if (route === "/") return new Response('<form action="/check"></form>');
      if (route === "/check")
        return new Response(null, { status: 303, headers: { location } });
      if (route === `${location}.json`) {
        if (++polls === 1)
          return Response.json({ status: "running" }, { status: 202 });
        return Response.json(failedJob ? { status: "failed" } : report);
      }
      if (route === location)
        return new Response(
          `<html>${report.inputs.artifact.sha256}${report.model.hypotheses?.[0]?.explanation ?? ""}</html>`,
        );
      throw new Error("Unexpected smoke request");
    },
  };
}

test("HTTP smoke validates exact identity then normal POST, persisted JSON/HTML and follow-up", async () => {
  const f = transport();
  const result = await smokeHttpCandidate({
    baseURL: "http://127.0.0.1:9000",
    identity,
    packageSpec: "fixture@1.0.0",
    mode: "recorded",
    fetchImpl: f.fetchImpl,
    pause: async () => {},
  });
  assert.equal(result.status, "passed");
  assert.equal(result.transport, "recorded");
  assert.ok(
    f.calls.some((call) => call.route === "/check" && call.method === "POST"),
  );
  assert.ok(
    f.calls.filter((call) => call.route === `${location}.json`).length >= 3,
  );
  assert.ok(f.calls.some((call) => call.route === location));
});

test("HTTP smoke refuses a version mismatch before submitting work", async () => {
  const f = transport({ wrongVersion: true });
  await assert.rejects(
    smokeHttpCandidate({
      baseURL: "http://127.0.0.1:9000",
      identity,
      packageSpec: "fixture@1.0.0",
      mode: "recorded",
      fetchImpl: f.fetchImpl,
    }),
    /identity|version/i,
  );
  assert.equal(
    f.calls.some((call) => call.route === "/check"),
    false,
  );
});

test("HTTP smoke rejects a finished job without a persisted result", async () => {
  const f = transport({ failedJob: true });
  await assert.rejects(
    smokeHttpCandidate({
      baseURL: "http://127.0.0.1:9000",
      identity,
      packageSpec: "fixture@1.0.0",
      mode: "recorded",
      fetchImpl: f.fetchImpl,
      pause: async () => {},
    }),
    /report|result/i,
  );
});

test("HTTP smoke rejects a different package report returned for the submitted candidate", async () => {
  const f = transport({ wrongClaim: true });
  await assert.rejects(
    smokeHttpCandidate({
      baseURL: "http://127.0.0.1:9000",
      identity,
      packageSpec: "fixture@1.0.0",
      mode: "recorded",
      fetchImpl: f.fetchImpl,
      pause: async () => {},
    }),
    /report|package/i,
  );
});

test("configured deployed smoke requires real-model proof rather than disabled output", async () => {
  const f = transport();
  await assert.rejects(
    smokeHttpCandidate({
      baseURL: "http://127.0.0.1:9000",
      identity,
      packageSpec: "fixture@1.0.0",
      mode: "recorded",
      modelExpectation: {
        modelId: "configured-model",
        configHash: "a".repeat(64),
        provider: "google",
        endpointHost: "generativelanguage.googleapis.com",
        generationConfig: { temperature: 0 },
      },
      fetchImpl: f.fetchImpl,
      pause: async () => {},
    }),
    /model|preflight|config/i,
  );
});

test("model HTTP smoke checks normal-route citations, rendered rationale and stable follow-up", async () => {
  const expectation = {
    provider: "google",
    endpointHost: "generativelanguage.googleapis.com",
    modelId: "configured-model",
    configHash: "a".repeat(64),
    generationConfig: { temperature: 0 },
  };
  const model = {
    ...expectation,
    status: "complete",
    promptHash: "b".repeat(64),
    attempts: 1,
    preflightCalls: 1,
    hypotheses: [
      {
        category: "review-concern",
        explanation: "Review this command.",
        uncertainty: "Intent is unverified.",
        alternative: "It could be packaging.",
        citations: [{ evidenceId: "e1", quote: "install" }],
      },
    ],
  };
  const f = transport({
    model,
    evidence: [{ id: "e1", side: "artifact", excerpt: "install command" }],
  });
  const result = await smokeHttpCandidate({
    baseURL: "http://127.0.0.1:9000",
    identity,
    packageSpec: "fixture@1.0.0",
    mode: "recorded",
    modelExpectation: expectation,
    fetchImpl: f.fetchImpl,
    pause: async () => {},
  });
  assert.equal(result.modelAcceptance, "recorded-diagnostic");
  assert.equal(result.modelProof.hypothesesCount, 1);
  assert.ok(f.calls.some((call) => call.route === location));
});
