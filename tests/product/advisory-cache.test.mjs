import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ADVISORY_CACHE_LIMITS,
  createAdvisoryCache,
} from "../../src/core/advisory-cache.mjs";
import { boundedVulnerabilityCheck } from "../../src/server/enrichment.mjs";

const start = Date.parse("2026-11-01T00:00:00Z");
function manualClock() {
  let now = start;
  return {
    now: () => now,
    setTimeout,
    clearTimeout,
    advance(ms) {
      now += ms;
    },
  };
}
const record = (id = "GHSA-synthetic-0001") => ({
  id,
  summary: "Synthetic advisory",
  modified: "2026-10-30T12:00:00Z",
  affected: [
    {
      package: { name: "fixture", ecosystem: "npm" },
      versions: ["1.0.0"],
    },
  ],
});
function osv(script) {
  const requests = [];
  return {
    requests,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      const next =
        typeof script === "function" ? await script(body, options) : script;
      if (next instanceof Error) throw next;
      if (next instanceof Response) return next;
      return Response.json(next);
    },
  };
}
function cacheWith(script, options = {}) {
  const clock = manualClock();
  const upstream = osv(script);
  const cache = createAdvisoryCache({
    clock,
    lookupOptions: { fetchImpl: upstream.fetchImpl, clock },
    ...options,
  });
  return { clock, upstream, cache };
}

test("complete results are cached per exact version and expire after TTL", async () => {
  const { clock, upstream, cache } = cacheWith({ vulns: [record()] });
  const first = await cache.lookup("fixture@1.0.0");
  assert.equal(first.status, "found");
  assert.equal(first.cache.status, "miss");
  clock.advance(60_000);
  const second = await cache.lookup("fixture@1.0.0");
  assert.equal(upstream.requests.length, 1);
  assert.equal(second.cache.status, "hit");
  assert.equal(second.cache.ageMs, 60_000);
  assert.equal(second.cache.storedAt, "2026-11-01T00:00:00.000Z");
  assert.equal(second.queriedAt, first.queriedAt);
  assert.deepEqual(second.advisories, first.advisories);
  second.advisories.length = 0;
  assert.equal((await cache.lookup("fixture@1.0.0")).advisories.length, 1);
  await cache.lookup("fixture@1.0.1");
  await cache.lookup("@other/fixture@1.0.0");
  assert.deepEqual(
    upstream.requests.map((body) => `${body.package.name}@${body.version}`),
    ["fixture@1.0.0", "fixture@1.0.1", "@other/fixture@1.0.0"],
  );
  clock.advance(ADVISORY_CACHE_LIMITS.ttlMs);
  const expired = await cache.lookup("fixture@1.0.0");
  assert.equal(expired.cache.status, "miss");
  assert.equal(expired.queriedAt, new Date(clock.now()).toISOString());
  assert.equal(upstream.requests.length, 4);
});

test("none-reported is cached as a completed query, never as a safety verdict", async () => {
  const { upstream, cache } = cacheWith({ vulns: [] });
  await cache.lookup("fixture@1.0.0");
  const hit = await cache.lookup("fixture@1.0.0");
  assert.equal(upstream.requests.length, 1);
  assert.equal(hit.status, "none-reported");
  assert.equal(hit.cache.status, "hit");
  assert.equal(Object.hasOwn(hit, "safe"), false);
});

for (const failure of [
  new Response("SYNTHETIC_SECRET", { status: 503 }),
  new Error("SYNTHETIC_SECRET"),
  Response.json({ vulns: null }),
])
  test("failures are never cached as empty results", async () => {
    const { upstream, cache } = cacheWith(() =>
      upstream.requests.length === 1 ? failure : { vulns: [record()] },
    );
    const failed = await cache.lookup("fixture@1.0.0");
    assert.equal(failed.status, "unavailable");
    assert.equal(failed.cache.status, "uncached");
    assert.doesNotMatch(JSON.stringify(failed), /SYNTHETIC_SECRET/);
    const retried = await cache.lookup("fixture@1.0.0");
    assert.equal(upstream.requests.length, 2);
    assert.equal(retried.status, "found");
    assert.equal(retried.cache.status, "miss");
  });

test("incomplete pages are returned live but not cached", async () => {
  const { upstream, cache } = cacheWith((body) =>
    body.page_token
      ? new Response("busy", { status: 503 })
      : { vulns: [record()], next_page_token: "next" },
  );
  const first = await cache.lookup("fixture@1.0.0");
  const second = await cache.lookup("fixture@1.0.0");
  assert.equal(first.status, "incomplete");
  assert.equal(second.cache.status, "uncached");
  assert.equal(upstream.requests.length, 4);
});

test("expired snapshot is served as stale-incomplete only when refresh is unavailable", async () => {
  const { clock, upstream, cache } = cacheWith(() =>
    upstream.requests.length === 1
      ? { vulns: [record()] }
      : new Response("down", { status: 503 }),
  );
  const fresh = await cache.lookup("fixture@1.0.0");
  clock.advance(ADVISORY_CACHE_LIMITS.ttlMs + 1);
  const stale = await cache.lookup("fixture@1.0.0");
  assert.equal(upstream.requests.length, 2);
  assert.equal(stale.status, "incomplete");
  assert.equal(stale.complete, false);
  assert.deepEqual(stale.reasons, ["http-error", "stale-cache"]);
  assert.equal(stale.queriedAt, fresh.queriedAt);
  assert.deepEqual(stale.advisories, fresh.advisories);
  assert.equal(stale.cache.status, "stale");
  assert.equal(stale.cache.snapshotStatus, "found");
  assert.equal(stale.cache.refreshStatus, "unavailable");
  assert.equal(stale.cache.ageMs, ADVISORY_CACHE_LIMITS.ttlMs + 1);
  const accepted = boundedVulnerabilityCheck(stale, "fixture@1.0.0", clock);
  assert.equal(accepted.status, "incomplete");
  assert.equal(accepted.cache.status, "stale");
  clock.advance(ADVISORY_CACHE_LIMITS.staleMs);
  const gone = await cache.lookup("fixture@1.0.0");
  assert.equal(gone.status, "unavailable");
  assert.equal(gone.cache.status, "uncached");
  assert.deepEqual(gone.advisories, []);
});

test("concurrent identical lookups share one upstream request", async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const { upstream, cache } = cacheWith(async () => {
    await gate;
    return { vulns: [record()] };
  });
  const lookups = Array.from({ length: 5 }, () =>
    cache.lookup("fixture@1.0.0"),
  );
  const other = cache.lookup("fixture@2.0.0");
  release();
  const results = await Promise.all(lookups);
  await other;
  assert.equal(upstream.requests.length, 2);
  assert.deepEqual(
    results.map((r) => r.cache.status),
    ["miss", "coalesced", "coalesced", "coalesced", "coalesced"],
  );
  results[0].advisories.pop();
  assert.equal(results[1].advisories.length, 1);
});

test("one aborted waiter does not cancel the shared request; the last one does", async () => {
  const signals = [];
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const cache = createAdvisoryCache({
    clock: manualClock(),
    lookup: async (spec, { signal }) => {
      signals.push(signal);
      await gate;
      return {
        schemaVersion: "1",
        source: "OSV",
        package: { name: "fixture", version: "1.0.0", ecosystem: "npm" },
        queriedAt: new Date(start).toISOString(),
        status: "none-reported",
        complete: true,
        reasons: [],
        advisories: [],
        pagesFetched: 1,
        limits: {},
      };
    },
  });
  const a = new AbortController();
  const first = cache.lookup("fixture@1.0.0", { signal: a.signal });
  const second = cache.lookup("fixture@1.0.0");
  a.abort(new Error("SYNTHETIC_SECRET"));
  const aborted = await first;
  assert.equal(aborted.status, "unavailable");
  assert.deepEqual(aborted.reasons, ["aborted"]);
  assert.doesNotMatch(JSON.stringify(aborted), /SYNTHETIC_SECRET/);
  assert.equal(signals[0].aborted, false);
  release();
  assert.equal((await second).status, "none-reported");
  const b = new AbortController();
  const c = manualClock();
  const lone = createAdvisoryCache({
    clock: c,
    lookup: (_spec, { signal }) => {
      signals.push(signal);
      return new Promise(() => {});
    },
  });
  const pending = lone.lookup("fixture@1.0.0", { signal: b.signal });
  b.abort();
  assert.equal((await pending).reasons[0], "aborted");
  assert.equal(signals[1].aborted, true);
});

test("invalid specs bypass the cache and identities cannot collide", async () => {
  const { upstream, cache } = cacheWith({ vulns: [] });
  const invalid = await cache.lookup("fixture@latest");
  assert.equal(invalid.cache.status, "bypass");
  assert.deepEqual(invalid.reasons, ["invalid-package-spec"]);
  await cache.lookup("fixture@1.0.0");
  await cache.lookup("fixture@1.0.0+build");
  await cache.lookup("fixture@1.0.0-1");
  assert.equal(upstream.requests.length, 3);
});

test("mismatched upstream identity is not stored under the requested key", async () => {
  let calls = 0;
  const cache = createAdvisoryCache({
    clock: manualClock(),
    lookup: async () => {
      calls++;
      return {
        schemaVersion: "1",
        source: "OSV",
        package: { name: "fixture", version: "9.9.9", ecosystem: "npm" },
        queriedAt: new Date(start).toISOString(),
        status: "none-reported",
        complete: true,
        reasons: [],
        advisories: [],
        pagesFetched: 1,
        limits: {},
      };
    },
  });
  await cache.lookup("fixture@1.0.0");
  const again = await cache.lookup("fixture@1.0.0");
  assert.equal(again.cache.status, "uncached");
  assert.equal(calls, 2);
});

test("entry count and byte limits evict least recently used snapshots", async () => {
  const { upstream, cache } = cacheWith(
    { vulns: [record()] },
    {
      limits: { entries: 2 },
    },
  );
  await cache.lookup("fixture@1.0.0");
  await cache.lookup("fixture@1.0.1");
  await cache.lookup("fixture@1.0.0");
  await cache.lookup("fixture@1.0.2");
  assert.equal((await cache.lookup("fixture@1.0.0")).cache.status, "hit");
  assert.equal((await cache.lookup("fixture@1.0.1")).cache.status, "miss");
  assert.equal(upstream.requests.length, 4);
  const tiny = cacheWith({ vulns: [record()] }, { limits: { entryBytes: 64 } });
  await tiny.cache.lookup("fixture@1.0.0");
  assert.equal(
    (await tiny.cache.lookup("fixture@1.0.0")).cache.status,
    "uncached",
  );
  assert.equal(tiny.upstream.requests.length, 2);
});

test("cache limits cannot be expanded or inverted", () => {
  for (const limits of [
    { entries: ADVISORY_CACHE_LIMITS.entries + 1 },
    { ttlMs: 0 },
    { ttlMs: 1000, staleMs: 10 },
    { unknown: 1 },
  ])
    assert.throws(() => createAdvisoryCache({ limits }), TypeError);
});
