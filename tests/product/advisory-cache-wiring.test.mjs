import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { compareInventories } from "../../src/core/compare.mjs";
import { createReport } from "../../src/core/report.mjs";
import { createAdvisoryCache } from "../../src/core/advisory-cache.mjs";
import { startServer } from "../../src/server/main.mjs";

const versionInfo = {
  version: JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  ).version,
  commit: "unknown",
  tarballSha256: "unknown",
};
const report = createReport({
  inputs: {
    artifact: { sha256: "a".repeat(64), sha512: "b".repeat(128) },
    limits: { entries: 20000 },
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
// Any request leaving loopback fails the test instead of reaching a real provider.
function guardNetwork(t) {
  const real = globalThis.fetch;
  const blocked = [];
  globalThis.fetch = (url, options) => {
    const target = new URL(url instanceof Request ? url.url : String(url));
    if (target.hostname !== "127.0.0.1") {
      blocked.push(target.host);
      return Promise.reject(new TypeError("network blocked by test"));
    }
    return real(url, options);
  };
  t.after(() => (globalThis.fetch = real));
  return blocked;
}
async function serve(t, options) {
  const root = await mkdtemp(path.join(os.tmpdir(), "unmask-cache-wiring-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worker = path.join(root, "fixture.mjs");
  await writeFile(
    worker,
    `import { writeFile } from 'node:fs/promises';let s='';for await(const c of process.stdin)s+=c;const r=JSON.parse(s);await writeFile(r.workDir+'/report.json',${JSON.stringify(JSON.stringify(report))});`,
  );
  const runtime = await startServer({
    host: "127.0.0.1",
    port: 0,
    tempRoot: path.join(root, "jobs"),
    versionInfo,
    modelClient: null,
    runnerOptions: { workerURL: pathToFileURL(worker) },
    ...options,
  });
  t.after(() => runtime.close());
  const base = `http://127.0.0.1:${runtime.server.address().port}`;
  return { runtime, base };
}
async function checkDetails(base) {
  const submitted = await fetch(`${base}/check`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "package=fixture%401.0.0",
    redirect: "manual",
  });
  const location = submitted.headers.get("location");
  for (let i = 0; i < 400; i++) {
    const response = await fetch(`${base}${location}.json`);
    if (response.status !== 202) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return (await fetch(`${base}${location}.details.json`)).json();
}

test("an injected advisory cache is the single instance behind hosted enrichment", async (t) => {
  const blocked = guardNetwork(t);
  const osv = [];
  const cache = createAdvisoryCache({
    lookupOptions: {
      fetchImpl: async (_url, options) => {
        osv.push(JSON.parse(options.body));
        return Response.json({ vulns: [] });
      },
    },
  });
  const { runtime, base } = await serve(t, { advisoryCache: cache });
  assert.equal(runtime.advisoryCache, cache);
  const details = await checkDetails(base);
  assert.equal(details.vulnerabilityCheck.status, "none-reported");
  assert.equal(details.vulnerabilityCheck.cache.status, "miss");
  const again = await runtime.advisoryCache.lookup("fixture@1.0.0");
  assert.equal(again.cache.status, "hit");
  assert.equal(osv.length, 1);
  assert.deepEqual(osv[0].package, { name: "fixture", ecosystem: "npm" });
  assert.equal(cache.stats().hits, 1);
  assert.deepEqual(blocked, []);
});

test("default server builds its own cache and never reaches OSV outside it", async (t) => {
  const blocked = guardNetwork(t);
  const previous = process.env.UNMASK_ADVISORY_CACHE_STATS;
  process.env.UNMASK_ADVISORY_CACHE_STATS = "1";
  t.after(() =>
    previous === undefined
      ? delete process.env.UNMASK_ADVISORY_CACHE_STATS
      : (process.env.UNMASK_ADVISORY_CACHE_STATS = previous),
  );
  const { runtime, base } = await serve(t, {});
  assert.equal(typeof runtime.advisoryCache.stats, "function");
  const check = (await checkDetails(base)).vulnerabilityCheck;
  assert.equal(check.status, "unavailable");
  assert.equal(check.cache.status, "uncached");
  assert.equal(check.diagnostics.cacheStats.uncached, 1);
  assert.deepEqual([...new Set(blocked)], ["api.osv.dev"]);
  assert.equal(runtime.advisoryCache.stats().entries, 0);
});

test("explicit enrichment opts out of the shared cache and conflicting options are rejected", async (t) => {
  const { runtime } = await serve(t, { enrichJob: null });
  assert.equal(Object.hasOwn(runtime, "advisoryCache"), false);
  const cache = createAdvisoryCache();
  for (const options of [
    { advisoryCache: cache, enrichJob: async () => ({}) },
    { advisoryCache: cache, enrichJob: null },
    { advisoryCache: {} },
  ]) {
    const outcome = await startServer({
      modelClient: null,
      port: 0,
      ...options,
    }).catch((error) => error);
    if (!(outcome instanceof TypeError)) {
      await outcome?.close?.();
      assert.fail("conflicting advisory options were accepted");
    }
  }
});
