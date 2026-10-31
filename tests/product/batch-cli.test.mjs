import assert from "node:assert/strict";
import { test } from "node:test";
import { Readable } from "node:stream";
import { once } from "node:events";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { main } from "../../src/cli/main.mjs";
import { createReport } from "../../src/core/report.mjs";
import { compareInventories } from "../../src/core/compare.mjs";
import { policyResult } from "../../src/core/policy.mjs";

function report(name, version) {
  const value = createReport({
    inputs: {
      claim: { name, version },
      artifact: { sha256: "a".repeat(64), sha512: "b".repeat(128) },
      limits: { maxEntries: 20000 },
    },
    source: { status: "unresolved", method: "unresolved", alternatives: [] },
    comparison: compareInventories(
      {
        digest: { sha256: "a".repeat(64) },
        entries: [],
        complete: true,
        failures: [],
      },
      null,
    ),
    manifests: {
      artifact: { status: "unavailable" },
      source: { status: "unavailable" },
      registry: { status: "unavailable" },
    },
  });
  value.model = { status: "unavailable", reason: "synthetic-no-model" };
  return value;
}

test("batch coalesces exact identities and preserves per-item partial failure", async () => {
  const posts = [];
  let output = "";
  let current;
  const code = await main(
    [
      "batch",
      "fixture@1.0.0",
      "fixture@1.0.0",
      "missing@1.0.0",
      "fixture@2.0.0",
      "--json",
    ],
    {
      env: { UNMASK_SERVER_URL: "https://synthetic.invalid" },
      stdout: { write: (text) => (output += text) },
      fetchImpl: async (_url, options) => {
        if (options.method === "POST") {
          current = options.body.get("package");
          posts.push(current);
          return new Response(null, {
            status: 303,
            headers: { location: "/r/" + "a".repeat(32) },
          });
        }
        if (current === "missing@1.0.0")
          return new Response(null, { status: 404 });
        const [name, version] = current.split("@");
        return Response.json(report(name, version));
      },
    },
  );
  assert.equal(code, 2);
  assert.notEqual(output, "", "batch must emit per-item outcomes");
  const result = JSON.parse(output);
  assert.deepEqual(posts, ["fixture@1.0.0", "missing@1.0.0", "fixture@2.0.0"]);
  assert.equal(result.requestedCount, 4);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.completedCount, 2);
  assert.equal(result.errorCount, 1);
  assert.deepEqual(result.items[0].inputIndexes, [0, 1]);
  assert.equal(result.items[0].model.status, "unavailable");
  assert.equal(result.items[1].status, "error");
  assert.equal(result.items[2].status, "completed");
});

function harness(overrides = {}) {
  let output = "";
  const posts = [];
  let identity;
  const runtime = {
    env: { UNMASK_SERVER_URL: "https://synthetic.invalid" },
    stdout: { write: (text) => (output += text) },
    fetchImpl: async (_url, options) => {
      if (options.method === "POST") {
        identity = options.body.get("package");
        posts.push(identity);
        return new Response(null, {
          status: 303,
          headers: { location: "/r/" + "a".repeat(32) },
        });
      }
      const at = identity.lastIndexOf("@");
      return Response.json(
        report(identity.slice(0, at), identity.slice(at + 1)),
      );
    },
    ...overrides,
  };
  return { runtime, posts, output: () => output };
}

test("batch combines bounded stdin and args while preserving scoped exact identities", async () => {
  const h = harness({
    stdin: Readable.from(["@scope/fixture@1.0.0\nfixture@", "2.0.0\n"]),
  });
  assert.equal(
    await main(
      ["batch", "@scope/fixture@1.0.0", "--stdin", "--json"],
      h.runtime,
    ),
    0,
  );
  assert.deepEqual(h.posts, ["@scope/fixture@1.0.0", "fixture@2.0.0"]);
  assert.equal(JSON.parse(h.output()).duplicateCount, 1);
});

test("batch never reads stdin unless explicitly requested", async () => {
  const h = harness();
  Object.defineProperty(h.runtime, "stdin", {
    get: () => assert.fail("implicit stdin read"),
  });
  assert.equal(await main(["batch", "fixture@1.0.0", "--json"], h.runtime), 0);
  assert.equal(h.posts.length, 1);
});

for (const [label, args, stdin] of [
  ["too many args", Array(26).fill("fixture@1.0.0")],
  [
    "too many stdin specs",
    ["--stdin"],
    Readable.from([Array(26).fill("fixture@1.0.0").join("\n")]),
  ],
  ["stdin byte cap", ["--stdin"], Readable.from(["x".repeat(16385)])],
  ["long spec", ["x".repeat(513)]],
  ["invalid UTF-8", ["--stdin"], Readable.from([Buffer.from([0xff])])],
  ["empty stdin", ["--stdin"], Readable.from([" \n\t"])],
  ["duplicate flag", ["fixture@1.0.0", "--json", "--json"]],
  ["unknown option", ["fixture@1.0.0", "--install"]],
]) {
  test("batch rejects " + label + " before any hosted request", async () => {
    const h = harness({ stdin });
    assert.equal(await main(["batch", ...args], h.runtime), 2);
    assert.deepEqual(h.posts, []);
    assert.equal(h.output(), "");
  });
}

test("invalid exact specs are visible item errors and terminal controls are escaped", async () => {
  const h = harness();
  assert.equal(
    await main(
      [
        "batch",
        "fixture@latest",
        "https://example.invalid/a",
        "$(echo injected)@1.0.0",
        "bad\u001b[2J\nforged",
        "bad\u009b2J",
        "fixture@1.0.0",
      ],
      h.runtime,
    ),
    2,
  );
  assert.deepEqual(h.posts, ["fixture@1.0.0"]);
  assert.match(h.output(), /5 errors/);
  assert.doesNotMatch(h.output(), /\u001b/);
  assert.doesNotMatch(h.output(), /\u009b/);
  assert.doesNotMatch(h.output(), /\nforged/);
  assert.match(h.output(), /AI status "unavailable"/);
});

test("hosted rejection pauses the batch rather than retrying or bypassing backpressure", async () => {
  let calls = 0;
  const h = harness({
    fetchImpl: async () => {
      calls++;
      return new Response(null, { status: 429 });
    },
  });
  assert.equal(
    await main(["batch", "fixture@1.0.0", "other@2.0.0", "--json"], h.runtime),
    2,
  );
  const result = JSON.parse(h.output());
  assert.equal(calls, 1);
  assert.equal(result.items[0].status, "error");
  assert.equal(result.items[1].status, "not-checked");
  assert.equal(result.notCheckedCount, 1);
});

test("cancelled batches keep explicit not-checked outcomes and do not submit", async () => {
  const h = harness({ signal: AbortSignal.abort() });
  assert.equal(await main(["batch", "fixture@1.0.0", "--json"], h.runtime), 2);
  assert.deepEqual(h.posts, []);
  assert.equal(JSON.parse(h.output()).items[0].error.code, "batch-cancelled");
});

test("stdin waits are deadline bounded and do not submit partial input", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness({ stdin: new Readable({ read() {} }) });
  const pending = main(["batch", "--stdin", "--json"], h.runtime);
  t.mock.timers.tick(5000);
  assert.equal(await pending, 2);
  assert.deepEqual(h.posts, []);
});

test("hosted checks run serially, including polling before the next submission", async () => {
  const events = [];
  const h = harness();
  const fetch = h.runtime.fetchImpl;
  h.runtime.fetchImpl = async (url, options) => {
    events.push(options.method === "POST" ? "submit" : "report");
    await new Promise((resolve) => setImmediate(resolve));
    return fetch(url, options);
  };
  assert.equal(
    await main(["batch", "fixture@1.0.0", "other@1.0.0", "--json"], h.runtime),
    0,
  );
  assert.deepEqual(events, ["submit", "report", "submit", "report"]);
});

for (const policy of [0, 2, 3]) {
  test("batch preserves completed report policy exit " + policy, async () => {
    const value = report("fixture", "1.0.0");
    if (policy === 2)
      value.failures.push({
        code: "synthetic-incomplete",
        message: "Synthetic incomplete assessment",
      });
    if (policy === 3)
      value.inputs.artifact.expectedIntegrity = {
        algorithm: "sha256",
        digest: "c".repeat(64),
      };
    value.policy = policyResult(value);
    assert.equal(value.policy.exitCode, policy);
    const h = harness({
      fetchImpl: async (_url, options) =>
        options.method === "POST"
          ? new Response(null, {
              status: 303,
              headers: { location: "/r/" + "a".repeat(32) },
            })
          : Response.json(value),
    });
    assert.equal(
      await main(["batch", "fixture@1.0.0", "--json"], h.runtime),
      policy,
    );
    assert.equal(JSON.parse(h.output()).items[0].policyExitCode, policy);
  });
}

test("batch accepts 25 bounded inputs while coalescing to one hosted check", async () => {
  const h = harness();
  assert.equal(
    await main(
      ["batch", ...Array(25).fill("fixture@1.0.0"), "--json"],
      h.runtime,
    ),
    0,
  );
  assert.deepEqual(h.posts, ["fixture@1.0.0"]);
  assert.equal(JSON.parse(h.output()).duplicateCount, 24);
});

test("batch total deadline aborts an active check and leaves remaining items unsubmitted", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  let reached;
  const started = new Promise((resolve) => (reached = resolve));
  const h = harness({
    fetchImpl: async (_url, options) => {
      calls++;
      reached();
      return new Promise((_resolve, reject) =>
        options.signal.addEventListener(
          "abort",
          () => reject(options.signal.reason),
          { once: true },
        ),
      );
    },
  });
  const pending = main(
    ["batch", "fixture@1.0.0", "other@1.0.0", "--json"],
    h.runtime,
  );
  await started;
  t.mock.timers.tick(600000);
  assert.equal(await pending, 2);
  assert.equal(calls, 1);
  const result = JSON.parse(h.output());
  assert.equal(result.items[0].status, "error");
  assert.equal(result.items[1].error.code, "batch-cancelled");
});

test("real CLI stdin uses loopback HTTP and emits JSON partial outcomes", async (t) => {
  let posts = 0;
  const server = createServer(async (req, res) => {
    if (req.url === "/check") {
      let body = "";
      for await (const chunk of req) body += chunk;
      assert.equal(new URLSearchParams(body).get("package"), "fixture@1.0.0");
      posts++;
      res.writeHead(303, { location: "/r/" + "a".repeat(32) });
      return res.end();
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(report("fixture", "1.0.0")));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("../../src/cli/main.mjs", import.meta.url)),
      "batch",
      "--stdin",
      "--json",
    ],
    {
      env: {
        PATH: process.env.PATH,
        UNMASK_SERVER_URL: `http://127.0.0.1:${server.address().port}`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  t.after(() => child.kill());
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exit = once(child, "exit");
  child.stdin.end("fixture@1.0.0\nfixture@1.0.0\nfixture@latest\n");
  assert.equal((await exit)[0], 2, stderr);
  const result = JSON.parse(stdout);
  assert.equal(posts, 1);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.completedCount, 1);
  assert.equal(result.errorCount, 1);
});
