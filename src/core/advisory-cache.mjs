import { parsePackageSpec } from "./acquire.mjs";
import { ADVISORY_LIMITS, lookupNpmAdvisories } from "./advisories.mjs";

export const ADVISORY_CACHE_LIMITS = Object.freeze({
  ttlMs: 15 * 60 * 1000,
  staleMs: 6 * 60 * 60 * 1000,
  entries: 256,
  entryBytes: 2 * 1024 * 1024,
  totalBytes: 32 * 1024 * 1024,
});
const systemClock = { now: Date.now };
const COMPLETE = ["found", "none-reported"];

function identity(spec) {
  try {
    const { name, version } = parsePackageSpec(spec);
    return { name, version, key: `${name}@${version}` };
  } catch {
    return null;
  }
}

function unavailable(claim, clock, reasons) {
  return {
    schemaVersion: "1",
    source: "OSV",
    package: claim
      ? { name: claim.name, version: claim.version, ecosystem: "npm" }
      : null,
    queriedAt: new Date(clock.now()).toISOString(),
    status: "unavailable",
    complete: false,
    reasons: [...new Set(reasons)].sort(),
    advisories: [],
    pagesFetched: 0,
    limits: { ...ADVISORY_LIMITS },
  };
}

const NOT_CONTACTED = Object.freeze({
  name: "OSV",
  availability: "not-contacted",
  requests: 0,
  retries: 0,
  timeouts: 0,
  failures: [],
  durationMs: 0,
});
const FRESHNESS = {
  hit: "cached",
  miss: "live",
  coalesced: "live",
  stale: "stale",
  bypass: "none",
};

export function createAdvisoryCache({
  lookup = lookupNpmAdvisories,
  lookupOptions = {},
  exposeStats = false,
  clock = systemClock,
  limits: overrides = {},
} = {}) {
  if (typeof lookup !== "function")
    throw new TypeError("lookup must be a function");
  const limits = { ...ADVISORY_CACHE_LIMITS, ...overrides };
  if (
    Object.keys(limits).some(
      (key) =>
        !Object.hasOwn(ADVISORY_CACHE_LIMITS, key) ||
        !Number.isSafeInteger(limits[key]) ||
        limits[key] < 1 ||
        limits[key] > ADVISORY_CACHE_LIMITS[key],
    ) ||
    limits.staleMs < limits.ttlMs ||
    limits.totalBytes < limits.entryBytes
  )
    throw new TypeError("Invalid advisory cache limits");
  const entries = new Map();
  const flights = new Map();
  let bytes = 0;
  const counts = {
    hit: 0,
    miss: 0,
    coalesced: 0,
    stale: 0,
    uncached: 0,
    bypass: 0,
    evicted: 0,
    expired: 0,
  };

  function drop(key) {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    bytes -= entry.bytes;
  }
  function prune(now) {
    for (const [key, entry] of entries)
      if (now < entry.storedAt || now - entry.storedAt >= limits.staleMs) {
        drop(key);
        counts.expired++;
      }
  }
  function cacheable(result, claim) {
    return (
      result !== null &&
      typeof result === "object" &&
      result.complete === true &&
      COMPLETE.includes(result.status) &&
      Array.isArray(result.reasons) &&
      result.reasons.length === 0 &&
      result.package?.name === claim.name &&
      result.package?.version === claim.version
    );
  }
  function store(claim, result, now) {
    const json = JSON.stringify(result);
    const size = Buffer.byteLength(json);
    if (size > limits.entryBytes) return false;
    drop(claim.key);
    entries.set(claim.key, { json, bytes: size, storedAt: now });
    bytes += size;
    for (const key of entries.keys()) {
      if (entries.size <= limits.entries && bytes <= limits.totalBytes) break;
      drop(key);
      counts.evicted++;
    }
    return entries.has(claim.key);
  }
  function provenance(status, entry, now) {
    return {
      status,
      ttlMs: limits.ttlMs,
      ...(entry
        ? {
            storedAt: new Date(entry.storedAt).toISOString(),
            ageMs: now - entry.storedAt,
          }
        : {}),
    };
  }
  function fly(claim, spec) {
    const controller = new AbortController();
    const flight = { controller, waiters: 0 };
    flight.promise = Promise.resolve()
      .then(() => lookup(spec, { ...lookupOptions, signal: controller.signal }))
      .catch(() => null)
      .then((result) => {
        if (flights.get(claim.key) === flight) flights.delete(claim.key);
        const now = clock.now();
        if (cacheable(result, claim) && store(claim, result, now))
          return { stored: entries.get(claim.key), now };
        return {
          result: result ?? unavailable(claim, clock, ["lookup-failed"]),
          now,
        };
      });
    flights.set(claim.key, flight);
    return flight;
  }
  function settle(claim, outcome, coalesced) {
    const { now } = outcome;
    if (outcome.stored)
      return {
        ...JSON.parse(outcome.stored.json),
        cache: provenance(
          coalesced ? "coalesced" : "miss",
          outcome.stored,
          now,
        ),
      };
    const result = structuredClone(outcome.result);
    const prior = entries.get(claim.key);
    // Only a refresh that produced no advisory data may fall back to an older complete snapshot.
    if (
      result.status === "unavailable" &&
      prior &&
      now >= prior.storedAt &&
      now - prior.storedAt < limits.staleMs
    ) {
      const snapshot = JSON.parse(prior.json);
      return {
        ...snapshot,
        status: "incomplete",
        complete: false,
        reasons: [...new Set(["stale-cache", ...result.reasons])].sort(),
        diagnostics: result.diagnostics,
        cache: {
          ...provenance("stale", prior, now),
          snapshotStatus: snapshot.status,
          refreshStatus: result.status,
        },
      };
    }
    return { ...result, cache: provenance("uncached", null, now) };
  }

  // Aggregate counters only: never package identities, keys or timestamps of individual entries.
  function stats() {
    return {
      entries: entries.size,
      bytes,
      inflight: flights.size,
      hits: counts.hit,
      misses: counts.miss,
      coalesced: counts.coalesced,
      staleServed: counts.stale,
      uncached: counts.uncached,
      bypassed: counts.bypass,
      evicted: counts.evicted,
      expired: counts.expired,
      limits: { ...limits },
    };
  }
  async function cachedLookup(spec, options) {
    const result = await resolve(spec, options);
    const now = clock.now();
    const { status, storedAt } = result.cache;
    counts[status]++;
    const state =
      FRESHNESS[status] ?? (result.status === "unavailable" ? "none" : "live");
    const queried = Date.parse(result.queriedAt);
    const provider =
      status === "hit" ? NOT_CONTACTED : result.diagnostics?.provider;
    return {
      ...result,
      diagnostics: {
        ...(provider ? { provider: structuredClone(provider) } : {}),
        freshness: {
          state,
          ...(state !== "none" && Number.isFinite(queried)
            ? { queriedAt: result.queriedAt, ageMs: Math.max(0, now - queried) }
            : {}),
          ...(storedAt && state !== "stale"
            ? {
                freshUntil: new Date(
                  Date.parse(storedAt) + limits.ttlMs,
                ).toISOString(),
              }
            : {}),
        },
        ...(exposeStats ? { cacheStats: stats() } : {}),
      },
    };
  }
  async function resolve(spec, { signal } = {}) {
    const claim = identity(spec);
    if (!claim) {
      const result = await lookup(spec, { ...lookupOptions, signal });
      return { ...result, cache: provenance("bypass", null, clock.now()) };
    }
    const now = clock.now();
    prune(now);
    const entry = entries.get(claim.key);
    if (entry && now - entry.storedAt < limits.ttlMs) {
      entries.delete(claim.key);
      entries.set(claim.key, entry);
      return {
        ...JSON.parse(entry.json),
        cache: provenance("hit", entry, now),
      };
    }
    if (signal?.aborted)
      return {
        ...unavailable(claim, clock, ["aborted"]),
        cache: provenance("uncached", null, now),
      };
    const existing = flights.get(claim.key);
    const flight = existing ?? fly(claim, spec);
    flight.waiters++;
    let release;
    const aborted = new Promise((resolve) => {
      release = () => resolve(null);
      signal?.addEventListener("abort", release, { once: true });
    });
    try {
      const outcome = await Promise.race([flight.promise, aborted]);
      if (outcome) return settle(claim, outcome, Boolean(existing));
      return {
        ...unavailable(claim, clock, ["aborted"]),
        cache: provenance("uncached", null, clock.now()),
      };
    } finally {
      signal?.removeEventListener("abort", release);
      // The shared upstream request is cancelled only once every waiter has gone.
      if (--flight.waiters === 0 && flights.get(claim.key) === flight) {
        flights.delete(claim.key);
        flight.controller.abort();
      }
    }
  }
  return { lookup: cachedLookup, stats };
}
