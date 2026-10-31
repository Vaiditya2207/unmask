import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import tar from "tar-stream";
import { createApp } from "../../src/server/app.mjs";
import { analyzeLocal } from "../../src/core/pipeline.mjs";
import { main } from "../../src/cli/main.mjs";
import { checkHosted } from "../../src/cli/hosted.mjs";

const entrypoint = fileURLToPath(
  new URL("../../src/cli/main.mjs", import.meta.url),
);
const id = "a".repeat(32);
const versionInfo = {
  version: "0.0.0",
  commit: "b".repeat(40),
  tarballSha256: "c".repeat(64),
};
async function temp(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "unmask-hosted-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function archive(manifest, prefix) {
  const pack = tar.pack(),
    chunks = [];
  const drain = (async () => {
    for await (const chunk of pack) chunks.push(chunk);
  })();
  pack.entry(
    { name: `${prefix}/package.json`, mtime: new Date(0) },
    JSON.stringify(manifest),
  );
  pack.finalize();
  await drain;
  return gzipSync(Buffer.concat(chunks));
}
async function synthetic(t, code = 0) {
  const root = await temp(t),
    tarballPath = path.join(root, "artifact.tgz"),
    sourceArchivePath = path.join(root, "source.tgz");
  const manifest = { name: "fixture", version: "1.0.0" };
  await writeFile(
    tarballPath,
    code === 2
      ? Buffer.from("broken gzip")
      : await archive(
          {
            ...manifest,
            ...(code === 3
              ? { scripts: { install: "inert synthetic text" } }
              : {}),
          },
          "package",
        ),
  );
  await writeFile(sourceArchivePath, await archive(manifest, "root"));
  const report = await analyzeLocal({
    tarballPath,
    sourceArchivePath,
    sourceRoot: "root",
    commit: "d".repeat(40),
    claim: manifest,
  });
  report.model = { status: "unavailable", reason: "synthetic-hosted-route" };
  assert.equal(report.policy.exitCode, code);
  return report;
}
async function listen(t, server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return `http://127.0.0.1:${server.address().port}`;
}
async function run(args, env = {}) {
  const child = spawn(process.execPath, [entrypoint, ...args], {
    env: { PATH: process.env.PATH, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  try {
    const [code] = await once(child, "exit");
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}
function options(origin, extra = {}) {
  return {
    env: new Proxy(
      {},
      {
        get(_target, key) {
          assert.equal(
            key,
            "UNMASK_SERVER_URL",
            "hosted must not read model/provider configuration",
          );
          return origin;
        },
      },
    ),
    modelFactory() {
      assert.fail("hosted invoked local model factory");
    },
    model() {
      assert.fail("hosted invoked local model");
    },
    hostedLimits: {
      pollMs: 1,
      totalTimeoutMs: 500,
      requestTimeoutMs: 200,
      maxBodyBytes: 1024 * 1024,
      ...extra,
    },
  };
}
for (const code of [0, 2, 3]) {
  test(`hosted real app and CLI preserve report, server model section and exit${code} without cache-dir`, async (t) => {
    const report = await synthetic(t, code),
      root = await temp(t);
    let calls = 0;
    const origin = await listen(
      t,
      createApp({
        versionInfo,
        runAnalysis: async (spec) => {
          calls++;
          assert.equal(spec, "fixture@1.0.0");
          return report;
        },
      }),
    );
    const result = await run(["check", "fixture@1.0.0", "--out", root], {
      UNMASK_SERVER_URL: origin,
      UNMASK_MODEL: "invalid",
      UNMASK_MODEL_KEY: "SYNTHETIC_MUST_NOT_SEND",
    });
    assert.equal(result.code, code, result.stderr);
    assert.equal(calls, 1);
    assert.deepEqual(
      JSON.parse(await readFile(path.join(root, "report.json"), "utf8")),
      report,
    );
    assert.match(
      await readFile(path.join(root, "report.html"), "utf8"),
      /UNMASK/,
    );
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /SYNTHETIC_MUST_NOT_SEND/,
    );
  });
}
test("hosted transport sends only spec, polls pending and never reads provider config or local cache", async (t) => {
  const report = await synthetic(t),
    root = await temp(t);
  let gets = 0,
    posts = 0;
  const origin = await listen(
    t,
    createServer(async (req, res) => {
      assert.equal(req.headers.authorization, undefined);
      assert.equal(req.headers.cookie, undefined);
      if (req.url === "/check") {
        posts++;
        assert.equal(req.method, "POST");
        let body = "";
        for await (const c of req) body += c;
        assert.equal(body, "package=fixture%401.0.0");
        res.writeHead(303, { location: `/r/${id}` });
        res.end();
      } else {
        assert.equal(req.url, `/r/${id}.json`);
        gets++;
        res.writeHead(gets === 1 ? 202 : 200, {
          "content-type": "application/json",
        });
        res.end(
          JSON.stringify(gets === 1 ? { id, status: "running" } : report),
        );
      }
    }),
  );
  const cache = path.join(root, "unused-cache");
  const code = await main(
    ["check", "fixture@1.0.0", "--out", root, "--cache-dir", cache],
    options(origin),
  );
  assert.equal(code, 0);
  assert.equal(posts, 1);
  assert.equal(gets, 2);
  await assert.rejects(access(cache));
});
test("hosted URL configuration prerequisite and offline-only consent fail before any acquisition", async (t) => {
  const root = await temp(t);
  for (const [env, args] of [
    [{}, []],
    [{ UNMASK_SERVER_URL: "http://example.invalid" }, []],
    [{ UNMASK_SERVER_URL: "http://user:secret@127.0.0.1" }, []],
    [{ UNMASK_SERVER_URL: "http://127.0.0.1/path" }, []],
    [{ UNMASK_SERVER_URL: "http://127.0.0.1" }, ["--allow-model"]],
  ]) {
    const result = await run(
      ["check", "fixture@1.0.0", "--out", root, ...args],
      env,
    );
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, /hosted-configuration|conflicting-mode/);
    assert.doesNotMatch(result.stderr, /secret/);
  }
  await assert.rejects(access(path.join(root, "report.json")));
});
for (const location of [
  "https://example.invalid/r/" + id,
  "//example.invalid/r/" + id,
  "/other",
  "/r/" + id + "?key=secret",
  "/r/" + id + "#fragment",
]) {
  test(
    "hosted rejects unsafe report Location without following it: " + location,
    async (t) => {
      const root = await temp(t);
      let calls = 0;
      const origin = await listen(
        t,
        createServer((req, res) => {
          calls++;
          res.writeHead(303, { location });
          res.end();
        }),
      );
      assert.equal(
        await main(["check", "fixture@1.0.0", "--out", root], options(origin)),
        2,
      );
      assert.equal(calls, 1);
      await assert.rejects(access(path.join(root, "report.json")));
    },
  );
}
for (const problem of [
  "poll-redirect",
  "status",
  "invalid-json",
  "oversized",
  "chunked-oversized",
  "schema",
  "policy",
  "claim",
  "failed-job",
  "pending-id",
]) {
  test(
    "hosted rejects " + problem + " without writing a completed report",
    async (t) => {
      const root = await temp(t),
        report = await synthetic(t);
      const origin = await listen(
        t,
        createServer((req, res) => {
          if (req.url === "/check") {
            res.writeHead(303, { location: `/r/${id}` });
            return res.end();
          }
          if (problem === "poll-redirect") {
            res.writeHead(302, { location: "/check" });
            return res.end();
          }
          if (problem === "status") {
            res.writeHead(503);
            return res.end("SYNTHETIC_SECRET");
          }
          res.setHeader("content-type", "application/json");
          if (problem === "invalid-json") return res.end("SYNTHETIC_SECRET");
          if (problem === "oversized") {
            res.setHeader("content-length", "9999999");
            return res.end("{}");
          }
          if (problem === "chunked-oversized") {
            res.write('"');
            res.write("x".repeat(1100000));
            return res.end('"');
          }
          if (problem === "schema")
            return res.end(JSON.stringify({ ...report, schemaVersion: "999" }));
          if (problem === "policy")
            return res.end(
              JSON.stringify({
                ...report,
                policy: { ...report.policy, exitCode: 3 },
              }),
            );
          if (problem === "claim")
            return res.end(
              JSON.stringify({
                ...report,
                inputs: {
                  ...report.inputs,
                  claim: { name: "other", version: "1.0.0" },
                },
              }),
            );
          if (problem === "failed-job")
            return res.end(
              JSON.stringify({
                id,
                status: "failed",
                reason: "SYNTHETIC_SECRET",
              }),
            );
          res.writeHead(202);
          res.end(JSON.stringify({ id: "b".repeat(32), status: "running" }));
        }),
      );
      assert.equal(
        await main(["check", "fixture@1.0.0", "--out", root], options(origin)),
        2,
      );
      await assert.rejects(access(path.join(root, "report.json")));
    },
  );
}
for (const stall of ["headers", "body", "pending"]) {
  test(
    "hosted has a bounded " + stall + " timeout and never falls back locally",
    async (t) => {
      const root = await temp(t);
      let posts = 0;
      const origin = await listen(
        t,
        createServer((req, res) => {
          if (req.url === "/check") {
            posts++;
            res.writeHead(303, { location: `/r/${id}` });
            return res.end();
          }
          if (stall === "body") {
            res.writeHead(200, { "content-type": "application/json" });
            res.write("{");
          }
          if (stall === "pending") {
            res.writeHead(202, { "content-type": "application/json" });
            res.end(JSON.stringify({ id, status: "running" }));
          }
        }),
      );
      assert.equal(
        await main(
          ["check", "fixture@1.0.0", "--out", root],
          options(origin, { totalTimeoutMs: 60, requestTimeoutMs: 30 }),
        ),
        2,
      );
      assert.equal(posts, 1);
      await assert.rejects(access(path.join(root, "report.json")));
    },
  );
}
test("hosted output escapes hostile model text and never overwrites existing reports", async (t) => {
  const root = await temp(t),
    report = await synthetic(t);
  report.model = { status: "<img src=x onerror=alert(1)>" };
  const origin = await listen(
    t,
    createApp({ versionInfo, runAnalysis: async () => report }),
  );
  assert.equal(
    await main(["check", "fixture@1.0.0", "--out", root], options(origin)),
    0,
  );
  const before = await readFile(path.join(root, "report.json"));
  const html = await readFile(path.join(root, "report.html"), "utf8");
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img/);
  assert.equal(
    await main(["check", "fixture@1.0.0", "--out", root], options(origin)),
    2,
  );
  assert.deepEqual(await readFile(path.join(root, "report.json")), before);
});

test("default hosted deadline covers queued plus running lifecycle without resubmission", async (t) => {
  const report = await synthetic(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let posts = 0,
    polls = 0;
  const fetchImpl = async (url, options) => {
    assert.equal(options.signal.aborted, false);
    if (url === "https://synthetic.invalid/check") {
      posts++;
      return new Response(null, {
        status: 303,
        headers: { location: `/r/${id}` },
      });
    }
    assert.equal(url, `https://synthetic.invalid/r/${id}.json`);
    polls++;
    if (polls <= 180) {
      setImmediate(() => t.mock.timers.tick(3000));
      return new Response(
        JSON.stringify({ id, status: polls <= 100 ? "queued" : "running" }),
        { status: 202, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify(report), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  assert.deepEqual(
    await checkHosted("fixture@1.0.0", {
      serverUrl: "https://synthetic.invalid",
      fetchImpl,
      limits: { pollMs: 1 },
    }),
    report,
  );
  assert.equal(posts, 1);
  assert.equal(polls, 181);
});
