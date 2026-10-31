import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import { test } from "node:test";
import { createApp, createCacheKeyPrefix } from "../../src/server/app.mjs";
import { createHash } from "node:crypto";
import { createReportStore } from "../../src/server/store.mjs";
import { createGemmaClient, attachModel } from "../../src/model/client.mjs";
import { compareInventories } from "../../src/core/compare.mjs";
import { createReport, canonicalReport } from "../../src/core/report.mjs";

const versionInfo = {
  version: "0.0.0",
  commit: "a".repeat(40),
  tarballSha256: "b".repeat(64),
};
const report = (name = "example", code = 0) => ({
  inputs: {
    claim: { name, version: "1.0.0" },
    artifact: { sha256: "c".repeat(64) },
  },
  coverage: { inventory: { files: 0, bytes: 0, complete: true } },
  files: [],
  evidence: [],
  failures: [],
  policy: { exitCode: code, findings: [] },
  model: { status: "disabled" },
});
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function start(t, options = {}) {
  const app = createApp({
    versionInfo,
    runAnalysis: async () => report(),
    ...options,
  });
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        app.closeAllConnections();
        app.close(resolve);
      }),
  );
  const origin = `http://127.0.0.1:${app.address().port}`;
  return {
    app,
    origin,
    get: (path) => fetch(origin + path, { redirect: "manual" }),
    post: (value) =>
      fetch(origin + "/check", {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ package: value }),
      }),
  };
}
async function finished(s, path) {
  for (let i = 0; i < 30; i++) {
    const r = await s.get(path + ".json");
    if (r.status !== 202) return r;
    await tick();
  }
  throw new Error("job did not finish");
}
function fakeClock() {
  let now = 0,
    id = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const key = ++id;
      timers.set(key, { at: now + ms, fn });
      return key;
    },
    clearTimeout(key) {
      timers.delete(key);
    },
    advance(ms) {
      now += ms;
      for (const [key, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(key);
          timer.fn();
        }
      }
    },
  };
}

test("real HTTP: GET never analyzes; POST redirects to private report, shared viewer and JSON", async (t) => {
  let calls = 0;
  const s = await start(t, {
    runAnalysis: async (name, { signal }) => {
      calls++;
      assert.equal(name, "@scope/example@1.0.0");
      assert.ok(signal instanceof AbortSignal);
      return report("<script>bad</script>");
    },
  });
  assert.equal((await s.get("/")).status, 200);
  assert.equal((await s.get("/healthz")).status, 200);
  assert.deepEqual(await (await s.get("/version")).json(), versionInfo);
  assert.equal(calls, 0);
  for (const input of [
    "https://evil.test/a",
    "example@latest",
    "example@^1.0.0",
    "example",
    "../x@1.0.0",
    "UPPER@1.0.0",
    "example@1.0.0-01",
  ])
    assert.equal((await s.post(input)).status, 400, input);
  const response = await s.post("@scope/example@1.0.0");
  assert.equal(response.status, 303);
  const path = response.headers.get("location");
  assert.match(path, /^\/r\/[a-f0-9]{32}$/);
  const json = await finished(s, path);
  assert.equal(json.status, 200);
  assert.equal(json.headers.get("x-content-type-options"), "nosniff");
  assert.equal((await json.json()).inputs.claim.name, "<script>bad</script>");
  const html = await (await s.get(path)).text();
  assert.match(html, /Review evidence for &lt;script&gt;/);
  assert.doesNotMatch(html, /<script>bad/);
  assert.match(html, new RegExp("c".repeat(64)));
  assert.match(html, /Download report JSON/);
  assert.equal(calls, 1);
  assert.equal((await s.get("/check")).status, 405);
  assert.equal((await s.get("/upload")).status, 404);
});

test("one active plus one waiting; duplicates reuse admission and third distinct request gets 429", async (t) => {
  const first = deferred(),
    second = deferred();
  let calls = 0;
  const s = await start(t, {
    runAnalysis: () => {
      calls++;
      return calls === 1 ? first.promise : second.promise;
    },
  });
  const one = await s.post("one@1.0.0"),
    path = one.headers.get("location");
  assert.equal((await s.post("one@1.0.0")).headers.get("location"), path);
  const two = await s.post("two@1.0.0");
  assert.equal(two.status, 303);
  assert.match(
    await (await s.get(two.headers.get("location"))).text(),
    /Queued/,
  );
  const three = await s.post("three@1.0.0");
  assert.equal(three.status, 429);
  assert.ok(Number(three.headers.get("retry-after")) > 0);
  assert.match(await three.text(), /shared global limit/i);
  assert.equal(calls, 1);
  first.resolve(report());
  await finished(s, path);
  await tick();
  assert.equal(calls, 2);
  second.resolve(report());
  await finished(s, two.headers.get("location"));
  assert.equal((await s.post("one@1.0.0")).headers.get("location"), path);
  assert.equal(calls, 2);
});

test("global six-per-ten-minute admission excludes cached hits and resets by clock", async (t) => {
  const clock = fakeClock();
  let calls = 0;
  const s = await start(t, {
    clock,
    runAnalysis: async () => {
      calls++;
      return report();
    },
  });
  for (let i = 0; i < 6; i++) {
    const r = await s.post(`pkg${i}@1.0.0`);
    assert.equal(r.status, 303);
    await finished(s, r.headers.get("location"));
  }
  assert.equal((await s.post("pkg0@1.0.0")).status, 303);
  assert.equal(calls, 6);
  const limited = await s.post("pkg6@1.0.0");
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "600");
  clock.advance(600000);
  assert.equal((await s.post("pkg6@1.0.0")).status, 303);
});

test("deadline aborts runner, does not overlap an uncooperative runner, expires waiting job without GET work", async (t) => {
  const clock = fakeClock(),
    pending = deferred();
  let signal,
    calls = 0;
  const s = await start(t, {
    clock,
    runAnalysis: (_name, options) => {
      calls++;
      signal = options.signal;
      return pending.promise;
    },
  });
  const one = await s.post("one@1.0.0"),
    two = await s.post("two@1.0.0");
  clock.advance(240000);
  assert.equal(signal.aborted, true);
  let result = await (
    await s.get(one.headers.get("location") + ".json")
  ).json();
  assert.equal(result.status, "incomplete");
  assert.equal(result.reason, "execution-timeout");
  assert.equal(calls, 1);
  clock.advance(60000);
  result = await (await s.get(two.headers.get("location") + ".json")).json();
  assert.equal(result.reason, "queue-expired");
  assert.equal(calls, 1);
  pending.resolve(report());
  await tick();
  await tick();
  result = await (await s.get(one.headers.get("location") + ".json")).json();
  assert.equal(result.status, "incomplete");
  assert.equal((await s.get("/healthz")).status, 200);
});

test("runner errors remain generic and incomplete reports retain evidence", async (t) => {
  let call = 0;
  const s = await start(t, {
    runAnalysis: async () => {
      if (++call === 1) throw new Error("SECRET stack file:///private");
      return report("example", 2);
    },
  });
  const failed = await s.post("one@1.0.0");
  const response = await finished(s, failed.headers.get("location"));
  const body = await response.text();
  assert.match(body, /analysis-failed/);
  assert.doesNotMatch(body, /SECRET|stack|private/);
  const incomplete = await s.post("two@1.0.0");
  const json = await finished(s, incomplete.headers.get("location"));
  assert.equal((await json.json()).policy.exitCode, 2);
  assert.match(
    await (await s.get(incomplete.headers.get("location"))).text(),
    /Incomplete analysis/,
  );
});

test("bounded bodies, malformed forms, foreign origin and hostile echoed input do not run", async (t) => {
  let calls = 0;
  const s = await start(t, {
    runAnalysis: async () => {
      calls++;
      return report();
    },
  });
  const post = (body, headers = {}) =>
    fetch(s.origin + "/check", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...headers,
      },
      body,
      redirect: "manual",
    });
  assert.equal((await post("package=" + "x".repeat(5000))).status, 413);
  assert.equal((await post("package=x@1.0.0&package=y@1.0.0")).status, 400);
  assert.equal(
    (await post("package=x@1.0.0", { origin: "https://evil.test" })).status,
    403,
  );
  assert.equal(
    (await post("{}", { "content-type": "application/json" })).status,
    415,
  );
  const attack = '\"><img src=x onerror=alert(1)>';
  const invalid = await post(new URLSearchParams({ package: attack }));
  assert.equal(invalid.status, 400);
  const html = await invalid.text();
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
  assert.equal(calls, 0);
  const chunked = await new Promise((resolve, reject) => {
    const req = request(
      s.origin + "/check",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    req.on("error", reject);
    req.write("package=");
    req.end("x".repeat(5000));
  });
  assert.equal(chunked, 413);
});

test("report store enforces LRU, byte cap, immutable JSON and exact TTL", () => {
  const clock = fakeClock();
  const store = createReportStore({
    maxEntries: 2,
    maxBytes: 300,
    ttlMs: 100,
    clock,
  });
  const put = (id) =>
    store.put({
      id,
      key: id,
      status: "done",
      report: { label: id },
      createdAt: clock.now(),
    });
  put("a");
  put("b");
  assert.ok(store.get("a"));
  put("c");
  assert.equal(store.get("b"), undefined);
  assert.ok(store.get("a"));
  assert.ok(store.bytes <= 300);
  const record = store.get("a");
  record.report.label = "changed";
  assert.equal(store.get("a").report.label, "a");
  assert.equal(
    store.put({
      id: "huge",
      key: "huge",
      status: "done",
      report: { x: "x".repeat(1000) },
      createdAt: 0,
    }),
    false,
  );
  clock.advance(100);
  assert.equal(store.get("a"), undefined);
  assert.equal(store.bytes, 0);
});

test("oversized report becomes incomplete rather than escaping store limits", async (t) => {
  const s = await start(t, {
    limits: { maxReportBytes: 1024 },
    runAnalysis: async () => ({ ...report(), oversized: "x".repeat(2000) }),
  });
  const r = await s.post("large@1.0.0");
  const response = await finished(s, r.headers.get("location"));
  const result = await response.json();
  assert.equal(result.status, "incomplete");
  assert.equal(result.reason, "report-too-large");
});

test("successful completion starts the waiting job once; policy findings use the shared viewer", async (t) => {
  const pending = deferred();
  let calls = 0;
  const s = await start(t, {
    runAnalysis: async () => {
      if (++calls === 1) return pending.promise;
      const result = report("example", 3);
      result.policy.findings = [
        { ruleId: "lifecycle-source-absent", message: "Review this script." },
      ];
      return result;
    },
  });
  const first = await s.post("first@1.0.0"),
    second = await s.post("second@1.0.0");
  assert.equal(calls, 1);
  pending.resolve(report());
  await finished(s, first.headers.get("location"));
  await finished(s, second.headers.get("location"));
  assert.equal(calls, 2);
  const html = await (await s.get(second.headers.get("location"))).text();
  assert.match(html, /Review required/);
  assert.match(html, /lifecycle-source-absent/);
  assert.match(html, /Cached analysis/);
});

test("POST can retry unavailable model reports while GET only reads them", async (t) => {
  let calls = 0;
  const s = await start(t, {
    runAnalysis: async () => {
      calls++;
      return { ...report(), model: { status: "unavailable" } };
    },
  });
  const first = await s.post("example@1.0.0");
  await finished(s, first.headers.get("location"));
  await s.get(first.headers.get("location"));
  assert.equal(calls, 1);
  const second = await s.post("example@1.0.0");
  assert.notEqual(
    second.headers.get("location"),
    first.headers.get("location"),
  );
  await finished(s, second.headers.get("location"));
  assert.equal(calls, 2);
});

test("request body deadline responds without analysis and close aborts an active runner", async (t) => {
  let calls = 0,
    signal;
  const pending = deferred();
  const s = await start(t, {
    limits: { bodyTimeoutMs: 20 },
    runAnalysis: (_name, options) => {
      calls++;
      signal = options.signal;
      return pending.promise;
    },
  });
  const status = await new Promise((resolve, reject) => {
    const req = request(
      s.origin + "/check",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
      },
      (res) => {
        res.resume();
        res.on("end", () => {
          req.end();
          resolve(res.statusCode);
        });
      },
    );
    req.on("error", reject);
    req.write("package=");
  });
  assert.equal(status, 408);
  assert.equal(calls, 0);
  const response = await s.post("pending@1.0.0");
  assert.equal(response.status, 303);
  assert.equal(signal.aborted, false);
  s.app.closeAllConnections();
  await new Promise((resolve) => s.app.close(resolve));
  assert.equal(signal.aborted, true);
  pending.resolve(report());
});

test("default store evicts the 201st entry and byte pressure evicts old records", () => {
  const store = createReportStore();
  for (let i = 0; i < 201; i++)
    assert.equal(store.put({ id: String(i) }), true);
  assert.equal(store.size, 200);
  assert.equal(store.get("0"), undefined);
  const small = createReportStore({ maxBytes: 100 });
  small.put({ id: "a", data: "x".repeat(45) });
  small.put({ id: "b", data: "x".repeat(45) });
  assert.equal(small.get("a"), undefined);
  assert.ok(small.bytes <= 100);
});

test("unserializable runner output fails closed without losing the job", async (t) => {
  const cyclic = report();
  cyclic.cycle = cyclic;
  const s = await start(t, { runAnalysis: async () => cyclic });
  const response = await s.post("cyclic@1.0.0");
  const result = await finished(s, response.headers.get("location"));
  assert.equal(result.status, 200);
  assert.equal((await result.json()).reason, "analysis-failed");
  assert.equal((await s.get("/healthz")).status, 200);
});

test("cache key isolates disabled, enabled, model, prompt and generation configurations", () => {
  const config = {
    enabled: false,
    modelId: "test-model",
    promptHash: "prompt-a",
    generationConfig: { temperature: 0 },
  };
  const digest = (value) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const key = (value) =>
    createCacheKeyPrefix(
      { ...versionInfo, modelConfigDigest: digest(value) },
      { executionMs: 240000 },
    );
  const disabled = key(config);
  assert.equal(key({ ...config }), disabled);
  for (const changed of [
    { ...config, enabled: true },
    { ...config, modelId: "another-model" },
    { ...config, promptHash: "prompt-b" },
    { ...config, generationConfig: { temperature: 1 } },
  ])
    assert.notEqual(key(changed), disabled);
  assert.notEqual(
    createCacheKeyPrefix(versionInfo, {}),
    createCacheKeyPrefix(
      { ...versionInfo, modelConfigDigest: digest(config) },
      {},
    ),
  );
});

test("transient analysis and model retries each consume new HTTP admission", async (t) => {
  for (const kind of [
    "runner-error",
    "source-fetch-failed",
    "parse-timeout",
    "model-unavailable",
  ]) {
    let calls = 0;
    const s = await start(t, {
      limits: { maxNewChecks: 2 },
      runAnalysis: async () => {
        calls++;
        if (kind === "runner-error") throw new Error("private detail");
        const result = report("example", kind === "model-unavailable" ? 0 : 2);
        if (kind === "model-unavailable")
          result.model = { status: "unavailable" };
        else
          result.failures = [
            { code: kind, message: "Transient analysis failure" },
          ];
        return result;
      },
    });
    const first = await s.post("example@1.0.0");
    await finished(s, first.headers.get("location"));
    const second = await s.post("example@1.0.0");
    assert.equal(second.status, 303, kind);
    assert.notEqual(
      second.headers.get("location"),
      first.headers.get("location"),
      kind,
    );
    await finished(s, second.headers.get("location"));
    assert.equal((await s.post("example@1.0.0")).status, 429, kind);
    assert.equal(calls, 2, kind);
  }
});

test("incomplete deterministic cap reports alone reuse HTTP admission", async (t) => {
  for (const code of [
    "compressed-cap",
    "expanded-cap",
    "ratio-cap",
    "entry-cap",
    "path-cap",
    "metadata-cap",
  ]) {
    let calls = 0;
    const s = await start(t, {
      limits: { maxNewChecks: 1 },
      runAnalysis: async () => {
        calls++;
        const result = report("example", 2);
        result.failures = [
          { code, message: "Deterministic input cap reached" },
        ];
        return result;
      },
    });
    const first = await s.post("example@1.0.0");
    await finished(s, first.headers.get("location"));
    const reused = await s.post("example@1.0.0");
    assert.equal(reused.status, 303, code);
    assert.equal(
      reused.headers.get("location"),
      first.headers.get("location"),
      code,
    );
    assert.equal(reused.headers.get("x-unmask-reused"), "true", code);
    assert.equal(calls, 1, code);
    assert.equal((await s.post("other@1.0.0")).status, 429, code);
  }
});

test("mixed or unknown incomplete failures and unavailable model cap results are retryable", async (t) => {
  for (const variant of ["mixed", "unknown", "empty", "model-unavailable"]) {
    let calls = 0;
    const s = await start(t, {
      limits: { maxNewChecks: 2 },
      runAnalysis: async () => {
        calls++;
        const result = report("example", 2);
        result.failures =
          variant === "empty"
            ? []
            : [{ code: "expanded-cap", message: "Cap reached" }];
        if (variant === "mixed")
          result.failures.push({
            code: "source-fetch-failed",
            message: "Transient fetch failure",
          });
        if (variant === "unknown")
          result.failures = [
            { code: "unknown-cap", message: "Unclassified failure" },
          ];
        if (variant === "model-unavailable")
          result.model = { status: "unavailable" };
        return result;
      },
    });
    const first = await s.post("example@1.0.0");
    await finished(s, first.headers.get("location"));
    const second = await s.post("example@1.0.0");
    assert.equal(second.status, 303, variant);
    assert.notEqual(
      second.headers.get("location"),
      first.headers.get("location"),
      variant,
    );
    await finished(s, second.headers.get("location"));
    assert.equal((await s.post("example@1.0.0")).status, 429, variant);
    assert.equal(calls, 2, variant);
  }
});

test("queue expiry and execution timeout retries consume new HTTP admission", async (t) => {
  const timeoutClock = fakeClock();
  let calls = 0;
  const timeout = await start(t, {
    clock: timeoutClock,
    limits: { maxNewChecks: 2, executionMs: 5 },
    runAnalysis: (_name, { signal }) => {
      calls++;
      return new Promise((resolve) =>
        signal.addEventListener("abort", () => resolve(report()), {
          once: true,
        }),
      );
    },
  });
  const first = await timeout.post("timeout@1.0.0");
  timeoutClock.advance(5);
  await tick();
  assert.equal(
    (await (await timeout.get(first.headers.get("location") + ".json")).json())
      .reason,
    "execution-timeout",
  );
  const second = await timeout.post("timeout@1.0.0");
  assert.equal(second.status, 303);
  assert.notEqual(
    second.headers.get("location"),
    first.headers.get("location"),
  );
  timeoutClock.advance(5);
  await tick();
  assert.equal((await timeout.post("timeout@1.0.0")).status, 429);
  assert.equal(calls, 2);
  const queueClock = fakeClock();
  let queueCalls = 0;
  const queued = await start(t, {
    clock: queueClock,
    limits: { maxNewChecks: 3, queueTtlMs: 5, executionMs: 10 },
    runAnalysis: (_name, { signal }) => {
      queueCalls++;
      return new Promise((resolve) =>
        signal.addEventListener("abort", () => resolve(report()), {
          once: true,
        }),
      );
    },
  });
  await queued.post("active@1.0.0");
  const waiting = await queued.post("waiting@1.0.0");
  queueClock.advance(5);
  assert.equal(
    (await (await queued.get(waiting.headers.get("location") + ".json")).json())
      .reason,
    "queue-expired",
  );
  const retry = await queued.post("waiting@1.0.0");
  assert.equal(retry.status, 303);
  assert.notEqual(
    retry.headers.get("location"),
    waiting.headers.get("location"),
  );
  queueClock.advance(5);
  await tick();
  assert.equal((await queued.post("waiting@1.0.0")).status, 429);
  assert.equal(queueCalls, 1);
});

test("actual HTTP report includes paired syntax suggestions and retained inspection annotations", async (t) => {
  const value = report("example", 2);
  value.policy.findings = [
    { ruleId: "integrity-mismatch", evidenceIds: ["artifact"] },
  ];
  value.evidence = [
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
  value.cues = [
    {
      ruleId: "syntax-process-execution",
      priority: "review",
      summary: "Process execution syntax observed",
      literalStatus: "found-in-inspected-source",
      evidenceIds: ["artifact", "source"],
    },
  ];
  value.annotations = [
    {
      code: "syntax-not-inspected",
      path: "unsupported.tsx",
      reason: "unsupported-ts-jsx",
    },
  ];
  const s = await start(t, { runAnalysis: async () => value });
  const response = await s.post("example@1.0.0");
  const path = response.headers.get("location");
  await finished(s, path);
  const html = await (await s.get(path)).text();
  for (const content of [
    "Incomplete analysis",
    "Review required",
    "Review suggested",
    "syntax-process-execution",
    "unsupported.tsx",
    'href="#evidence-0"',
    'href="#evidence-1"',
  ])
    assert.ok(html.includes(content), content);
  assert.equal(
    (await (await s.get(path + ".json")).json()).cues[0].ruleId,
    "syntax-process-execution",
  );
});

function syntheticAnalysis(state) {
  const inventory = (side, text) => {
    const content = Buffer.from(text);
    return {
      digest: {
        sha256: createHash("sha256")
          .update(side + text)
          .digest("hex"),
        sha512: createHash("sha512")
          .update(side + text)
          .digest("hex"),
      },
      entries:
        state === "empty"
          ? []
          : [
              {
                path: "index.js",
                originalPath: `${side}/index.js`,
                type: "file",
                size: content.length,
                content,
                inspection: "retained",
                sha256: createHash("sha256").update(content).digest("hex"),
              },
            ],
      complete: true,
      failures: [],
    };
  };
  const artifact = inventory("package", 'console.log("synthetic change");');
  const source = inventory(
    "source",
    state === "changed"
      ? 'console.log("synthetic base");'
      : 'console.log("synthetic change");',
  );
  return createReport({
    inputs: {
      artifact: { ...artifact.digest, kind: "registry" },
      sourceArchive: { ...source.digest, kind: "remote" },
      limits: { entries: 20000 },
    },
    source: {
      status: "selected",
      method: "publisher-gitHead",
      complete: true,
      alternatives: [],
    },
    comparison: compareInventories(artifact, source),
    manifests: {
      artifact: { status: "unavailable" },
      source: { status: "unavailable" },
      registry: { status: "unavailable" },
    },
  });
}
function enableSyntheticModel(t) {
  const previous = process.env.UNMASK_MODEL;
  process.env.UNMASK_MODEL = "on";
  t.after(() => {
    if (previous === undefined) delete process.env.UNMASK_MODEL;
    else process.env.UNMASK_MODEL = previous;
  });
}
function syntheticClient(fetchImpl, overrides = {}) {
  return createGemmaClient({
    apiKey: "synthetic-not-a-credential",
    provider: "google",
    modelId: "gemma-4-26b-a4b-it",
    quotaVerified: true,
    dailyRequests: 2,
    requestsPerMinute: 2,
    inputTokensPerMinute: 20000,
    fetchImpl,
    ...overrides,
  });
}

test(
  "synthetic analysis/provider: concurrent eligible HTTP requests coalesce one model attempt and reuse admission",
  { timeout: 5000 },
  async (t) => {
    enableSyntheticModel(t);
    const counting = deferred(),
      releaseCount = deferred();
    t.after(() => releaseCount.resolve());
    const calls = { analysis: 0, model: 0, countTokens: 0, generateContent: 0 };
    const eligible = syntheticAnalysis("changed");
    assert.equal(eligible.files[0].state, "changed");
    const cited = eligible.evidence.find((item) => item.side === "artifact");
    const client = syntheticClient(
      async (url, options) => {
        const endpoint = new URL(url);
        assert.equal(
          endpoint.origin,
          "https://generativelanguage.googleapis.com",
        );
        assert.equal(options.method, "POST");
        assert.equal(options.redirect, "error");
        const method = endpoint.pathname.split(":").at(-1);
        assert.equal(
          endpoint.pathname,
          `/v1beta/models/gemma-4-26b-a4b-it:${method}`,
        );
        const body = JSON.parse(options.body);
        const prompt = JSON.parse(body.contents[0].parts[0].text);
        if (prompt.scope.files) {
          assert.ok(
            prompt.evidence.some(
              (item) =>
                item.id === cited.id && item.excerpt.includes(cited.excerpt),
            ),
          );
        } else assert.deepEqual(prompt.evidence, []);
        if (method === "countTokens") {
          calls.countTokens++;
          counting.resolve();
          await releaseCount.promise;
          return new Response('{"totalTokens":100}');
        }
        assert.equal(method, "generateContent");
        calls.generateContent++;
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        summary: "One changed file has an excerpt to review.",
                        hypotheses: prompt.evidence.length
                          ? [
                              {
                                category: "review-concern",
                                explanation:
                                  "The artifact excerpt warrants review.",
                                uncertainty: "Execution was not observed.",
                                alternative: "This may be an intentional edit.",
                                citations: [
                                  {
                                    evidenceId: cited.id,
                                    quote: cited.excerpt,
                                  },
                                ],
                              },
                            ]
                          : [],
                      }),
                    },
                  ],
                },
              },
            ],
          }),
        );
      },
      { dailyRequests: 4, requestsPerMinute: 4 },
    );
    const build = { ...versionInfo, modelConfigDigest: client.configHash };
    const s = await start(t, {
      versionInfo: build,
      limits: { maxNewChecks: 2 },
      runAnalysis: async (name, { signal }) => {
        calls.analysis++;
        const input =
          name === "eligible@1.0.0"
            ? structuredClone(eligible)
            : syntheticAnalysis("empty");
        calls.model++;
        return attachModel(input, await client.explain(input, { signal }));
      },
    });
    const responses = await Promise.all([
      s.post("eligible@1.0.0"),
      s.post("eligible@1.0.0"),
    ]);
    assert.deepEqual(
      responses.map((item) => item.status),
      [303, 303],
    );
    const path = responses[0].headers.get("location");
    assert.match(path, /^\/r\/[a-f0-9]{32}$/);
    assert.equal(responses[1].headers.get("location"), path);
    assert.deepEqual(
      responses.map((item) => item.headers.get("x-unmask-reused")).sort(),
      ["false", "true"],
    );
    await counting.promise;
    const pending = await s.get(path + ".json");
    assert.equal(pending.status, 202);
    const running = await pending.json();
    assert.equal(running.status, "running");
    assert.equal(running.id, path.split("/").at(-1));
    assert.deepEqual(calls, {
      analysis: 1,
      model: 1,
      countTokens: 1,
      generateContent: 0,
    });
    assert.equal((await s.get(path)).status, 200);
    assert.equal((await s.get("/healthz")).status, 200);
    assert.deepEqual(calls, {
      analysis: 1,
      model: 1,
      countTokens: 1,
      generateContent: 0,
    });
    releaseCount.resolve();
    const completed = await finished(s, path);
    assert.equal(completed.status, 200);
    const result = await completed.json();
    assert.equal(result.model.status, "complete");
    assert.equal(result.model.preflightCalls, 1);
    assert.equal(result.model.attempts, 1);
    assert.equal(result.model.configHash, build.modelConfigDigest);
    assert.equal(result.model.hypotheses[0].citations[0].quote, cited.excerpt);
    assert.equal(canonicalReport(result), canonicalReport(eligible));
    for (const route of [path, path + ".json", "/", "/version"])
      assert.equal((await s.get(route)).status, 200);
    const reused = await s.post("eligible@1.0.0");
    assert.equal(reused.status, 303);
    assert.equal(reused.headers.get("location"), path);
    assert.equal(reused.headers.get("x-unmask-reused"), "true");
    assert.deepEqual(calls, {
      analysis: 1,
      model: 1,
      countTokens: 1,
      generateContent: 1,
    });
    assert.equal(client.configHash, build.modelConfigDigest);
    const fresh = await s.post("empty@1.0.0");
    assert.equal(fresh.status, 303);
    assert.notEqual(fresh.headers.get("location"), path);
    const second = await (
      await finished(s, fresh.headers.get("location"))
    ).json();
    assert.equal(second.model.status, "complete");
    assert.match(second.model.summary, /changed file/);
    assert.deepEqual(second.model.hypotheses, []);
    assert.equal(second.model.scope.files, 0);
    assert.equal((await s.post("third@1.0.0")).status, 429);
    assert.equal(
      (await s.post("eligible@1.0.0")).headers.get("location"),
      path,
    );
    assert.deepEqual(calls, {
      analysis: 2,
      model: 2,
      countTokens: 2,
      generateContent: 2,
    });
  },
);

test(
  "synthetic analysis/provider: identical and empty HTTP reports receive one real summary call and reuse it",
  { timeout: 5000 },
  async (t) => {
    enableSyntheticModel(t);
    for (const state of ["byte-identical", "empty"]) {
      const releaseAnalysis = deferred();
      t.after(() => releaseAnalysis.resolve());
      const calls = {
        analysis: 0,
        model: 0,
        countTokens: 0,
        generateContent: 0,
      };
      const input = syntheticAnalysis(state);
      assert.equal(input.files.length, state === "empty" ? 0 : 1);
      assert.ok(input.files.every((file) => file.state === "byte-identical"));
      const client = syntheticClient(
        async (url, options) => {
          assert.equal(
            new URL(url).origin,
            "https://generativelanguage.googleapis.com",
          );
          const prompt = JSON.parse(
            JSON.parse(options.body).contents[0].parts[0].text,
          );
          assert.equal(prompt.scope.findings + prompt.scope.cues, 0);
          assert.equal(prompt.evidence.length, input.evidence.length);
          if (url.endsWith(":countTokens")) {
            calls.countTokens++;
            return new Response('{"totalTokens":100}');
          }
          calls.generateContent++;
          return Response.json({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        summary: `Scope lists ${prompt.scope.files} files; matching bytes are not proof the package is safe.`,
                        hypotheses: [],
                      }),
                    },
                  ],
                },
              },
            ],
          });
        },
        { dailyRequests: 4, requestsPerMinute: 4 },
      );
      const build = { ...versionInfo, modelConfigDigest: client.configHash };
      const s = await start(t, {
        versionInfo: build,
        limits: { maxNewChecks: 2 },
        runAnalysis: async (_name, { signal }) => {
          calls.analysis++;
          await releaseAnalysis.promise;
          calls.model++;
          const value = structuredClone(input);
          return attachModel(value, await client.explain(value, { signal }));
        },
      });
      const responses = await Promise.all([
        s.post("skipped@1.0.0"),
        s.post("skipped@1.0.0"),
      ]);
      assert.deepEqual(
        responses.map((item) => item.status),
        [303, 303],
      );
      const path = responses[0].headers.get("location");
      assert.equal(responses[1].headers.get("location"), path);
      const pending = await s.get(path + ".json");
      assert.equal(pending.status, 202);
      assert.equal((await pending.json()).status, "running");
      assert.deepEqual(calls, {
        analysis: 1,
        model: 0,
        countTokens: 0,
        generateContent: 0,
      });
      releaseAnalysis.resolve();
      const result = await (await finished(s, path)).json();
      assert.equal(
        result.model.status,
        "complete",
        JSON.stringify([
          result.model.reason,
          result.model.attemptLog,
          result.evidence?.length,
        ]),
      );
      assert.match(result.model.summary, /not proof the package is safe/);
      assert.deepEqual(result.model.hypotheses, []);
      assert.equal(result.model.scope.files, input.files.length);
      assert.equal(canonicalReport(result), canonicalReport(input));
      assert.equal(client.configHash, build.modelConfigDigest);
      for (const route of [path, path + ".json", "/healthz", "/version"])
        assert.equal((await s.get(route)).status, 200);
      const reused = await s.post("skipped@1.0.0");
      assert.equal(reused.status, 303);
      assert.equal(reused.headers.get("location"), path);
      assert.equal(reused.headers.get("x-unmask-reused"), "true");
      assert.deepEqual(calls, {
        analysis: 1,
        model: 1,
        countTokens: 1,
        generateContent: 1,
      });
      const fresh = await s.post("second@1.0.0");
      assert.equal(fresh.status, 303);
      assert.notEqual(fresh.headers.get("location"), path);
      await finished(s, fresh.headers.get("location"));
      assert.equal((await s.post("third@1.0.0")).status, 429);
      assert.deepEqual(calls, {
        analysis: 2,
        model: 2,
        countTokens: 2,
        generateContent: 2,
      });
      assert.equal(client.configHash, build.modelConfigDigest);
    }
  },
);

for (const scenario of [
  {
    label: "HTTP 403 permission denial",
    status: 403,
    failAt: "generateContent",
    reason: "provider",
    count: 1,
    generate: 1,
  },
  {
    label: "HTTP 401 authentication failure",
    status: 401,
    failAt: "countTokens",
    reason: "preflight",
    count: 1,
    generate: 0,
  },
  {
    label: "invalid output after bounded retry",
    status: 200,
    failAt: "generateContent",
    reason: "invalid-output",
    count: 2,
    generate: 2,
  },
]) {
  test(
    `synthetic analysis/provider: unavailable ${scenario.label} requires new POST admission and GET never retries`,
    { timeout: 5000 },
    async (t) => {
      enableSyntheticModel(t);
      const calls = {
        analysis: 0,
        model: 0,
        countTokens: 0,
        generateContent: 0,
      };
      const input = syntheticAnalysis("changed");
      const client = syntheticClient(
        async (url) => {
          const endpoint = new URL(url);
          assert.equal(
            endpoint.origin,
            "https://generativelanguage.googleapis.com",
          );
          const method = endpoint.pathname.split(":").at(-1);
          assert.ok(["countTokens", "generateContent"].includes(method));
          assert.equal(
            endpoint.pathname,
            `/v1beta/models/gemma-4-26b-a4b-it:${method}`,
          );
          calls[method]++;
          if (method === scenario.failAt)
            return new Response("{}", { status: scenario.status });
          assert.equal(method, "countTokens");
          return new Response('{"totalTokens":100}');
        },
        {
          dailyRequests: 20,
          requestsPerMinute: 20,
          inputTokensPerMinute: 200000,
        },
      );
      const build = { ...versionInfo, modelConfigDigest: client.configHash };
      const s = await start(t, {
        versionInfo: build,
        limits: { maxNewChecks: 2 },
        runAnalysis: async (_name, { signal }) => {
          calls.analysis++;
          calls.model++;
          const value = structuredClone(input);
          return attachModel(value, await client.explain(value, { signal }));
        },
      });
      const paths = [];
      for (let attempt = 1; attempt <= 2; attempt++) {
        const response = await s.post("unavailable@1.0.0");
        assert.equal(response.status, 303);
        assert.equal(response.headers.get("x-unmask-reused"), "false");
        const path = response.headers.get("location");
        assert.ok(!paths.includes(path));
        paths.push(path);
        const terminal = await finished(s, path);
        assert.equal(terminal.status, 200);
        const result = await terminal.json();
        assert.equal(result.model.status, "unavailable");
        assert.equal(result.model.reason, scenario.reason);
        assert.equal(result.model.preflightCalls, scenario.count);
        assert.equal(result.model.attempts, scenario.generate);
        assert.equal(result.model.configHash, build.modelConfigDigest);
        assert.equal(canonicalReport(result), canonicalReport(input));
        const expected = {
          analysis: attempt,
          model: attempt,
          countTokens: attempt * scenario.count,
          generateContent: attempt * scenario.generate,
        };
        assert.deepEqual(calls, expected);
        for (const previous of paths) {
          assert.equal((await s.get(previous)).status, 200);
          const reread = await s.get(previous + ".json");
          assert.equal(reread.status, 200);
          assert.equal((await reread.json()).model.reason, scenario.reason);
        }
        assert.deepEqual(calls, expected);
        assert.equal(client.configHash, build.modelConfigDigest);
      }
      assert.equal((await s.post("unavailable@1.0.0")).status, 429);
      assert.deepEqual(calls, {
        analysis: 2,
        model: 2,
        countTokens: 2 * scenario.count,
        generateContent: 2 * scenario.generate,
      });
    },
  );
}

test("default cache expires thirty minutes after completion and reads never slide it", async (t) => {
  const clock = fakeClock(),
    pending = deferred();
  let calls = 0;
  const s = await start(t, {
    clock,
    limits: { maxNewChecks: 2 },
    runAnalysis: async () => (++calls === 1 ? pending.promise : report()),
  });
  const first = await s.post("cached@1.0.0");
  const path = first.headers.get("location");
  clock.advance(60000);
  pending.resolve(report());
  await finished(s, path);
  clock.advance(1800000 - 1);
  const before = await s.get(path + ".json");
  assert.equal(before.status, 200);
  assert.equal(before.headers.get("cache-control"), "no-store");
  const reused = await s.post("cached@1.0.0");
  assert.equal(reused.status, 303);
  assert.equal(reused.headers.get("location"), path);
  assert.equal(reused.headers.get("x-unmask-reused"), "true");
  assert.equal(calls, 1);
  const anotherVersion = await s.post("cached@1.0.1");
  assert.equal(anotherVersion.status, 303);
  assert.notEqual(anotherVersion.headers.get("location"), path);
  await finished(s, anotherVersion.headers.get("location"));
  clock.advance(1);
  const expired = await s.get(path + ".json");
  assert.equal(expired.status, 404);
  assert.equal(expired.headers.get("cache-control"), "no-store");
  const fresh = await s.post("cached@1.0.0");
  assert.equal(fresh.status, 303);
  assert.notEqual(fresh.headers.get("location"), path);
  assert.equal(fresh.headers.get("x-unmask-reused"), "false");
  await finished(s, fresh.headers.get("location"));
  assert.equal(calls, 3);
  assert.equal((await s.post("admission-proof@1.0.0")).status, 429);
});

test("default store expiry follows completion even when the terminal record is saved later", () => {
  const clock = fakeClock();
  clock.advance(10);
  const store = createReportStore({ clock });
  const value = {
    id: "completed",
    key: "completed",
    status: "done",
    report: report(),
    finishedAt: 0,
  };
  assert.equal(store.put(value), true);
  clock.advance(1800000 - 11);
  assert.ok(store.get("completed"));
  assert.equal(store.put(value), true);
  clock.advance(1);
  assert.equal(store.get("completed"), undefined);
});

test("shared result lookups isolate release and routing identities as well as the exact package version", () => {
  const info = { ...versionInfo, modelConfigDigest: "route-a" };
  const key = (build, spec = "cached@1.0.0") =>
    `${createCacheKeyPrefix(build, {})}\n${spec}`;
  const store = createReportStore();
  store.put({
    id: "original",
    key: key(info),
    status: "done",
    report: report(),
  });
  assert.equal(store.findKey(key(info)).id, "original");
  for (const build of [
    { ...info, version: "1.0.1" },
    { ...info, commit: "c".repeat(40) },
    { ...info, modelConfigDigest: "route-b" },
    { ...info, policyVersion: "another-policy" },
  ])
    assert.equal(store.findKey(key(build)), undefined);
  assert.equal(store.findKey(key(info, "cached@1.0.1")), undefined);
});

test("package details HTTP shares pending/terminal/expired jobs and leaves raw JSON unchanged", async (t) => {
  const gate = deferred();
  const clock = fakeClock();
  let analysisCalls = 0;
  let modelCalls = 0;
  const input = syntheticAnalysis("changed");
  const before = JSON.stringify(input);
  const s = await start(t, {
    clock,
    limits: { reportTtlMs: 100 },
    runAnalysis: async () => {
      analysisCalls++;
      await gate.promise;
      modelCalls++;
      return input;
    },
  });
  assert.equal((await s.get(`/r/${"f".repeat(32)}.details.json`)).status, 404);
  const response = await s.post("example@1.0.0");
  const location = response.headers.get("location");
  const pending = await s.get(location + ".details.json");
  assert.equal(pending.status, 202);
  assert.equal(pending.headers.get("retry-after"), "3");
  assert.equal(pending.headers.get("cache-control"), "no-store");
  assert.equal((await pending.json()).key, undefined);
  gate.resolve();
  const raw = await (await finished(s, location)).text();
  assert.equal(raw, before);
  const details = await s.get(location + ".details.json");
  assert.equal(details.status, 200);
  assert.equal(
    details.headers.get("content-disposition"),
    'attachment; filename="unmask-package-details.json"',
  );
  assert.match(details.headers.get("content-type"), /application\/json/u);
  assert.equal((await details.json()).detailsVersion, "1");
  clock.advance(99);
  assert.equal((await s.get(location + ".details.json")).status, 200);
  assert.equal(await (await s.get(location + ".json")).text(), raw);
  assert.equal(analysisCalls, 1);
  assert.equal(modelCalls, 1);
  clock.advance(1);
  assert.equal((await s.get(location + ".details.json")).status, 404);
  assert.equal((await s.get(location + ".json")).status, 404);
  assert.equal(analysisCalls, 1);
  assert.equal(modelCalls, 1);
});

test("package details preserves incomplete reports and terminal jobs without reports", async (t) => {
  for (const failed of [false, true]) {
    const input = syntheticAnalysis("changed");
    input.coverage.inventory.complete = false;
    input.coverage.inventory.lowerBound = true;
    input.coverage.complete = false;
    input.policy = { exitCode: 2, findings: [] };
    let calls = 0;
    const s = await start(t, {
      runAnalysis: async () => {
        calls++;
        if (failed) throw new Error("synthetic analysis failure");
        return input;
      },
    });
    const path = (await s.post("example@1.0.0")).headers.get("location");
    const raw = await (await finished(s, path)).json();
    const response = await s.get(path + ".details.json");
    assert.equal(response.status, 200);
    const details = await response.json();
    if (failed) assert.deepEqual(details, raw);
    else {
      assert.equal(details.inventory.complete, false);
      assert.equal(details.coverage.counters.inventory.lowerBound, true);
    }
    assert.equal(calls, 1);
  }
});

function syntheticAdvisories(spec, status = "none-reported") {
  const separator = spec.lastIndexOf("@");
  return {
    schemaVersion: "1",
    source: "OSV",
    package: {
      ecosystem: "npm",
      name: spec.slice(0, separator),
      version: spec.slice(separator + 1),
    },
    queriedAt: "2026-11-01T00:00:00.000Z",
    status,
    complete: ["found", "none-reported"].includes(status),
    reasons: [],
    advisories:
      status === "found"
        ? [{ id: "OSV-SYNTHETIC", summary: "Synthetic advisory" }]
        : [],
    pagesFetched: 1,
    limits: { responseBytes: 1048576 },
  };
}

test("hosted enrichment coalesces exactly once, caches with the job and starts TTL after lookup", async (t) => {
  const gate = deferred();
  const started = deferred();
  const clock = fakeClock();
  let analysisCalls = 0,
    lookupCalls = 0,
    signal;
  const input = syntheticAnalysis("changed");
  const original = JSON.stringify(input);
  const s = await start(t, {
    clock,
    limits: { reportTtlMs: 100, maxNewChecks: 2 },
    runAnalysis: async (_spec, options) => {
      analysisCalls++;
      signal = options.signal;
      return input;
    },
    enrichJob: async (spec, options) => {
      lookupCalls++;
      assert.equal(options.signal, signal);
      started.resolve();
      if (lookupCalls === 1) await gate.promise;
      return syntheticAdvisories(spec, "found");
    },
  });
  assert.equal((await s.get(`/r/${"e".repeat(32)}.details.json`)).status, 404);
  assert.equal(lookupCalls, 0);
  const first = await s.post("example@1.0.0");
  const location = first.headers.get("location");
  await started.promise;
  clock.advance(50);
  assert.equal((await s.get(location + ".details.json")).status, 202);
  assert.equal(
    (await s.post("example@1.0.0")).headers.get("location"),
    location,
  );
  assert.equal(analysisCalls, 1);
  assert.equal(lookupCalls, 1);
  gate.resolve();
  assert.equal(await (await finished(s, location)).text(), original);
  let details = await (await s.get(location + ".details.json")).json();
  assert.equal(details.vulnerabilityCheck.status, "found");
  assert.equal(details.vulnerabilityCheck.package.name, "example");
  assert.equal(
    details.scope.knownVulnerabilities,
    "queried-exact-package-only",
  );
  assert.equal(details.scope.safetyVerdict, "not-provided");
  assert.equal(details.responseLimits.combinedBytes, 4194304);
  for (let index = 0; index < 3; index++)
    await s.get(location + ".details.json");
  assert.equal(
    (await s.post("example@1.0.0")).headers.get("location"),
    location,
  );
  clock.advance(99);
  assert.equal((await s.get(location + ".details.json")).status, 200);
  clock.advance(1);
  assert.equal((await s.get(location + ".details.json")).status, 404);
  const fresh = (await s.post("example@1.0.0")).headers.get("location");
  assert.notEqual(fresh, location);
  await finished(s, fresh);
  assert.equal(analysisCalls, 2);
  assert.equal(lookupCalls, 2);
  assert.equal(await (await s.get(fresh + ".json")).text(), original);
});

test("lookup failure, malformed identity and result/store caps preserve the core report", async (t) => {
  for (const variant of ["throws", "identity", "oversized", "storage"]) {
    const input = syntheticAnalysis("changed");
    const original = JSON.stringify(input);
    let calls = 0;
    const s = await start(t, {
      ...(variant === "storage"
        ? { limits: { maxReportBytes: Buffer.byteLength(original) + 4000 } }
        : {}),
      runAnalysis: async () => input,
      enrichJob: async (spec) => {
        calls++;
        if (variant === "throws") throw new Error("private provider details");
        const result = syntheticAdvisories(
          spec,
          ["oversized", "storage"].includes(variant)
            ? "found"
            : "none-reported",
        );
        if (variant === "identity") result.package.name = "different-package";
        if (variant === "oversized")
          result.advisories = [{ summary: "x".repeat(2097152) }];
        if (variant === "storage")
          result.advisories = [{ summary: "x".repeat(100000) }];
        return result;
      },
    });
    const location = (await s.post("example@1.0.0")).headers.get("location");
    assert.equal(await (await finished(s, location)).text(), original, variant);
    const details = await (await s.get(location + ".details.json")).json();
    assert.equal(details.vulnerabilityCheck.status, "unavailable", variant);
    assert.equal(details.scope.knownVulnerabilities, "not-assessed", variant);
    assert.equal(
      details.vulnerabilityCheck.reasons[0],
      {
        throws: "lookup-failed",
        identity: "invalid-result",
        oversized: "result-byte-cap",
        storage: "storage-byte-cap",
      }[variant],
    );
    assert.equal(calls, 1);
    assert.doesNotMatch(JSON.stringify(details), /private provider details/u);
    assert.equal(
      (await s.post("example@1.0.0")).headers.get("location"),
      location,
    );
    assert.equal(calls, 1);
  }
});

test("execution abort during enrichment retains completed core report and releases the queue", async (t) => {
  const clock = fakeClock();
  const started = deferred();
  const input = syntheticAnalysis("changed");
  const original = JSON.stringify(input);
  let lookupCalls = 0,
    aborted = false;
  const s = await start(t, {
    clock,
    limits: { executionMs: 50 },
    runAnalysis: async () => input,
    enrichJob: async (_spec, { signal }) => {
      lookupCalls++;
      signal.addEventListener(
        "abort",
        () => {
          aborted = true;
        },
        { once: true },
      );
      started.resolve();
      return new Promise(() => {});
    },
  });
  const location = (await s.post("example@1.0.0")).headers.get("location");
  await started.promise;
  clock.advance(50);
  await tick();
  assert.equal(aborted, true);
  assert.equal(await (await s.get(location + ".json")).text(), original);
  const details = await (await s.get(location + ".details.json")).json();
  assert.equal(details.vulnerabilityCheck.status, "unavailable");
  assert.equal(details.vulnerabilityCheck.reasons[0], "aborted");
  assert.equal(details.scope.knownVulnerabilities, "not-assessed");
  assert.equal(lookupCalls, 1);
  const second = await s.post("another@1.0.0");
  await tick();
  assert.equal(second.status, 303);
  assert.equal(lookupCalls, 2);
  clock.advance(50);
});

test("incomplete or disabled advisory checks do not claim known-vulnerability completion", async (t) => {
  for (const enabled of [false, true]) {
    const input = syntheticAnalysis("changed");
    const s = await start(t, {
      runAnalysis: async () => input,
      ...(enabled
        ? { enrichJob: async (spec) => syntheticAdvisories(spec, "incomplete") }
        : {}),
    });
    const location = (await s.post("example@1.0.0")).headers.get("location");
    await finished(s, location);
    const details = await (await s.get(location + ".details.json")).json();
    assert.equal(
      details.vulnerabilityCheck.status,
      enabled ? "incomplete" : "not-assessed",
    );
    assert.equal(details.scope.knownVulnerabilities, "not-assessed");
  }
});
