import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import tar from "tar-stream";
import { analyzeLocal } from "../../src/core/pipeline.mjs";
import { readArchive } from "../../src/core/archive.mjs";
import { createReportStore } from "../../src/server/store.mjs";
import { createApp } from "../../src/server/app.mjs";

async function archive(files, prefix = "package") {
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
async function fixture(t, { limits, sourceNames } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "unmask-store-producer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = JSON.stringify({ name: "fixture", version: "1.0.0" });
  const tarballPath = path.join(root, "artifact.tgz");
  const bytes = await archive({
    "package.json": manifest,
    "one/two/three/four/file.js": "export default 1;",
  });
  await writeFile(tarballPath, bytes);
  const options = {
    tarballPath,
    limits,
    claim: { name: "fixture", version: "1.0.0" },
  };
  if (sourceNames) {
    options.sourceArchivePath = path.join(root, "source.tgz");
    options.sourceRoot = "root";
    options.commit = "a".repeat(40);
    await writeFile(
      options.sourceArchivePath,
      await archive(
        Object.fromEntries(
          sourceNames.map((name, i) => [
            `packages/p${i}/package.json`,
            JSON.stringify({ name, version: "1.0.0" }),
          ]),
        ),
        "root",
      ),
    );
  }
  return { report: await analyzeLocal(options), bytes };
}
function cache(report) {
  const store = createReportStore();
  store.put({
    id: "report",
    key: "fixture@1.0.0",
    status: "incomplete",
    report,
  });
  return store;
}
async function http(t, runAnalysis, { maxNewChecks = 1 } = {}) {
  const app = createApp({
    runAnalysis,
    versionInfo: {
      version: "0.0.0",
      commit: "unknown",
      tarballSha256: "unknown",
    },
    limits: { maxNewChecks },
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
  const base = `http://127.0.0.1:${app.address().port}`;
  return {
    get: (uri) => fetch(base + uri),
    post: (value) =>
      fetch(base + "/check", {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ package: value }),
      }),
  };
}
async function completed(server, uri) {
  for (let i = 0; i < 40; i++) {
    const result = await server.get(uri + ".json");
    if (result.status !== 202) return result;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("Report did not finish");
}

test("actual archive producers emit reusable path-depth and path-node cap reports", async (t) => {
  for (const [code, limits] of [
    ["path-depth-cap", { pathDepth: 2 }],
    ["path-node-cap", { pathNodes: 8 }],
  ]) {
    const { report } = await fixture(t, { limits });
    assert.equal(report.policy.exitCode, 2);
    assert.deepEqual(
      report.failures.map((failure) => failure.code),
      [code],
    );
    assert.equal(cache(report).findKey("fixture@1.0.0")?.id, "report", code);
  }
});

test("actual ambiguous-manifest report remains incomplete and reuses POST while GET never retries", async (t) => {
  const { report } = await fixture(t, { sourceNames: ["fixture", "fixture"] });
  assert.equal(report.policy.exitCode, 2);
  assert.deepEqual(
    report.failures.map(({ code, reason }) => ({ code, reason })),
    [{ code: "source-selection-unresolved", reason: "ambiguous-manifest" }],
  );
  let calls = 0;
  const server = await http(t, async () => {
    calls++;
    return report;
  });
  const first = await server.post("fixture@1.0.0");
  assert.equal(first.status, 303);
  const uri = first.headers.get("location");
  assert.equal(
    (await (await completed(server, uri)).json()).policy.exitCode,
    2,
  );
  assert.match(await (await server.get(uri)).text(), /Incomplete analysis/);
  await completed(server, uri);
  assert.equal(calls, 1);
  const again = await server.post("fixture@1.0.0");
  assert.equal(again.status, 303);
  assert.equal(again.headers.get("location"), uri);
  assert.equal(again.headers.get("x-unmask-reused"), "true");
  assert.equal((await server.post("another@1.0.0")).status, 429);
  assert.equal(calls, 1);
});

test("actual non-ambiguous source failure and cap-plus-parse-timeout require new POST admission", async (t) => {
  const missing = (await fixture(t, { sourceNames: ["other-a", "other-b"] }))
    .report;
  assert.equal(missing.failures[0].code, "source-selection-unresolved");
  assert.equal(missing.failures[0].reason, "manifest-not-found");
  const { report: cap, bytes } = await fixture(t, { limits: { pathNodes: 8 } });
  const timed = await readArchive(bytes, {
    kind: "artifact",
    limits: { parseMs: 0 },
  });
  assert.equal(timed.failures[0].code, "parse-timeout");
  const mixed = structuredClone(cap);
  mixed.failures.push(...timed.failures);
  for (const report of [missing, mixed]) {
    assert.equal(cache(report).findKey("fixture@1.0.0"), undefined);
    let calls = 0;
    const server = await http(
      t,
      async () => {
        calls++;
        return report;
      },
      { maxNewChecks: 2 },
    );
    const first = await server.post("fixture@1.0.0");
    await completed(server, first.headers.get("location"));
    await server.get(first.headers.get("location"));
    assert.equal(calls, 1);
    const retry = await server.post("fixture@1.0.0");
    assert.equal(retry.status, 303);
    assert.notEqual(
      retry.headers.get("location"),
      first.headers.get("location"),
    );
    await completed(server, retry.headers.get("location"));
    assert.equal(calls, 2);
    assert.equal((await server.post("fixture@1.0.0")).status, 429);
  }
});
