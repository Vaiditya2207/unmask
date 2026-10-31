import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import tar from "tar-stream";
import { analyzeLocal } from "../../src/core/pipeline.mjs";
import { main } from "../../src/cli/main.mjs";
import {
  aggregateExit,
  compareReports,
  renderComparison,
} from "../../src/cli/compare.mjs";

async function archive(prefix, files) {
  const pack = tar.pack(),
    chunks = [];
  const drain = (async () => {
    for await (const chunk of pack) chunks.push(chunk);
  })();
  for (const [name, body] of Object.entries(files))
    pack.entry({ name: `${prefix}/${name}`, mtime: new Date(0) }, body);
  pack.finalize();
  await drain;
  return gzipSync(Buffer.concat(chunks));
}
async function report(t, manifest, extra = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "unmask-compare-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = { "package.json": JSON.stringify(manifest), ...extra };
  const tarballPath = path.join(root, "artifact.tgz");
  const sourceArchivePath = path.join(root, "source.tgz");
  await writeFile(tarballPath, await archive("package", files));
  await writeFile(
    sourceArchivePath,
    await archive("root", {
      "package.json": JSON.stringify({ name: manifest.name, version: "src" }),
    }),
  );
  const value = await analyzeLocal({
    tarballPath,
    sourceArchivePath,
    sourceRoot: "root",
    commit: "d".repeat(40),
    claim: { name: manifest.name, version: manifest.version },
  });
  value.model = { status: "unavailable", reason: "synthetic-hosted-route" };
  return value;
}
const older = (t) =>
  report(
    t,
    {
      name: "fixture",
      version: "1.0.0",
      scripts: { test: "inert text" },
      dependencies: { left: "1.0.0", kept: "2.0.0" },
    },
    { "index.js": "inert one", "old.js": "inert removed" },
  );
const newer = (t) =>
  report(
    t,
    {
      name: "fixture",
      version: "1.1.0",
      scripts: { test: "inert text", postinstall: "inert synthetic text" },
      dependencies: { kept: "2.1.0", right: "3.0.0" },
    },
    { "index.js": "inert two", "setup.js": "inert added" },
  );
async function hosted(t, reports) {
  const ids = new Map();
  const requested = [];
  const server = createServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/check") {
      let body = "";
      for await (const chunk of request) body += chunk;
      const spec = new URLSearchParams(body).get("package");
      requested.push(spec);
      const id = String(ids.size + 1).padStart(32, "a");
      ids.set(id, reports[spec]);
      response.writeHead(303, { location: `/r/${id}` }).end();
      return;
    }
    const match = /^\/r\/([a-f0-9]{32})\.json$/.exec(request.url);
    const value = match && ids.get(match[1]);
    if (!value) return response.writeHead(404).end();
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify(value));
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
  return { origin: `http://127.0.0.1:${server.address().port}`, requested };
}
function capture() {
  let text = "";
  return { write: (chunk) => (text += chunk), text: () => text };
}

test("compare reports script, dependency and file changes via hosted checks", async (t) => {
  const reports = {
    "fixture@1.0.0": await older(t),
    "fixture@1.1.0": await newer(t),
  };
  const { origin, requested } = await hosted(t, reports);
  const stdout = capture();
  const code = await main(["compare", "fixture@1.0.0", "fixture@1.1.0"], {
    env: { UNMASK_SERVER_URL: origin },
    stdout,
    hostedLimits: { pollMs: 1, totalTimeoutMs: 2000, requestTimeoutMs: 1000 },
  });
  assert.deepEqual(requested, ["fixture@1.0.0", "fixture@1.1.0"]);
  assert.equal(code, reports["fixture@1.1.0"].policy.exitCode);
  const text = stdout.text();
  assert.match(text, /Compare fixture 1\.0\.0 -> 1\.1\.0/);
  assert.match(text, /\+ postinstall \[lifecycle\]: "inert synthetic text"/);
  assert.match(text, /- left: "1\.0\.0"/);
  assert.match(text, /~ kept: "2\.0\.0" -> "2\.1\.0"/);
  assert.match(text, /\+ right: "3\.0\.0"/);
  assert.match(text, /\+ setup\.js/);
  assert.match(text, /- old\.js/);
  assert.match(text, /~ index\.js/);
  assert.match(text, /lifecycle script was added or changed/);
  assert.match(text, /not proven safe/);
});

test("compare JSON output is structured and bounded to the artifact manifest", async (t) => {
  const result = compareReports(await older(t), await newer(t));
  assert.equal(result.package, "fixture");
  assert.deepEqual(
    result.scripts.map((change) => [change.key, change.change]),
    [["postinstall", "added"]],
  );
  assert.deepEqual(
    result.dependencies.dependencies.map((change) => change.change),
    ["changed", "removed", "added"],
  );
  assert.deepEqual(
    result.files.added.map((file) => file.path),
    ["setup.js"],
  );
  assert.equal(result.files.unchanged, 0);
});

test("compare refuses unrelated names, same versions and ranges before any request", async () => {
  const stderr = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => stderr.push(String(chunk));
  const fetchImpl = () => assert.fail("no hosted request expected");
  try {
    for (const args of [
      ["fixture@1.0.0", "other@1.1.0"],
      ["fixture@1.0.0", "fixture@1.0.0"],
      ["fixture@^1.0.0", "fixture@1.1.0"],
      ["fixture@1.0.0"],
    ])
      assert.equal(await main(["compare", ...args], { fetchImpl }), 2);
  } finally {
    process.stderr.write = original;
  }
  assert.match(stderr[0], /^unmask error unrelated-packages: /);
  assert.match(stderr[1], /^unmask error same-version: /);
  assert.match(stderr[3], /^unmask error usage: /);
});

test("compare escapes control, ANSI and bidi text from untrusted keys and paths", async (t) => {
  const hostile = "\u001b[2J‮evil\nfake";
  const before = await report(
    t,
    { name: "fixture", version: "1.0.0" },
    { "index.js": "inert" },
  );
  const after = await report(
    t,
    {
      name: "fixture",
      version: "1.1.0",
      scripts: { [hostile]: "inert" },
      dependencies: { [hostile]: "1.0.0\u009b" },
    },
    { "index.js": "inert", [`x${hostile}.js`]: "inert" },
  );
  const result = compareReports(before, after);
  assert.ok(result.files.added.some((file) => file.path.includes("\u001b")));
  const text = renderComparison(result);
  assert.doesNotMatch(text, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/u);
  assert.match(text, /\\u001b\[2J\\u202eevil\\u000afake/);
  assert.equal(text.split("\n").filter((line) => line === "fake").length, 0);
  const stdout = capture();
  await main(["compare", "fixture@1.0.0", "fixture@1.1.0", "--json"], {
    checkHosted: async (spec) => (spec.endsWith("1.0.0") ? before : after),
    stdout,
  });
  assert.doesNotMatch(stdout.text(), /[\u007f-\u009f‪-‮]/u);
  assert.equal(
    JSON.parse(stdout.text()).scripts[0].key,
    hostile,
    "JSON escaping must preserve the original data",
  );
});

test("compare exit aggregates both sides so an incomplete old version is not hidden", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "unmask-compare-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tarballPath = path.join(root, "broken.tgz");
  await writeFile(tarballPath, "broken gzip");
  const broken = await analyzeLocal({
    tarballPath,
    claim: { name: "fixture", version: "1.0.0" },
  });
  const clean = await report(t, { name: "fixture", version: "1.1.0" });
  assert.equal(broken.policy.exitCode, 2);
  assert.equal(clean.policy.exitCode, 0);
  const stdout = capture();
  const code = await main(["compare", "fixture@1.0.0", "fixture@1.1.0"], {
    checkHosted: async (spec) => (spec.endsWith("1.0.0") ? broken : clean),
    stdout,
  });
  assert.equal(code, 2);
  assert.match(stdout.text(), /Aggregate exit 2/);
  assert.match(stdout.text(), /old 1\.0\.0: package manifest is unavailable/);
  assert.equal(aggregateExit(clean, { policy: { exitCode: 3 } }), 3);
  assert.equal(aggregateExit(clean, clean), 0);
});

test("compare uses own keys only and labels non-string manifest values without coercion", async (t) => {
  const before = await report(t, {
    name: "fixture",
    version: "1.0.0",
    scripts: { toString: "inert" },
  });
  const after = await report(t, {
    name: "fixture",
    version: "1.1.0",
    scripts: {
      postinstall: { toString: "not-a-function", valueOf: "not-a-function" },
    },
    dependencies: JSON.parse('{"constructor":"1.0.0","__proto__":"2.0.0"}'),
  });
  const result = compareReports(before, after);
  assert.deepEqual(
    result.dependencies.dependencies.map(({ key, change, from, to }) => ({
      key,
      change,
      from,
      to,
    })),
    [
      { key: "__proto__", change: "added", from: undefined, to: "2.0.0" },
      { key: "constructor", change: "added", from: undefined, to: "1.0.0" },
    ],
  );
  const postinstall = result.scripts.find((c) => c.key === "postinstall");
  assert.equal(postinstall.change, "added");
  assert.equal(postinstall.toType, "object");
  assert.equal(
    postinstall.to,
    '{"toString":"not-a-function","valueOf":"not-a-function"}',
  );
  assert.deepEqual(
    result.scripts.find((c) => c.key === "toString"),
    { key: "toString", change: "removed", from: "inert", lifecycle: false },
  );
  const stdout = capture();
  const code = await main(["compare", "fixture@1.0.0", "fixture@1.1.0"], {
    checkHosted: async (spec) => (spec.endsWith("1.0.0") ? before : after),
    stdout,
  });
  assert.equal(code, aggregateExit(before, after));
  assert.match(stdout.text(), /\+ postinstall \[lifecycle\]: <object> /);
  assert.match(stdout.text(), /values are not strings/);
});
