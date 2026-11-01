# Advisory cache operations

The hosted server answers exact-version OSV advisory lookups through one in-memory cache per process (`src/core/advisory-cache.mjs`). `startServer` creates it as the default `enrichJob`. The report queue and any other caller of that `enrichJob` share the same instance. An app built with `createApp` and its own `enrichJob`, or with `enrichJob: null`, does not use this cache.

The cache reduces repeat OSV traffic and keeps known advisories visible during short provider outages. It does not turn a lookup into a safety verdict. A cached `none-reported` means only that no advisory was returned for that exact version at the recorded `queriedAt`.

## What is stored

- **Key:** the exact `name@version` accepted by the package parser. Build metadata and prerelease identifiers are part of the key. Invalid specs bypass the cache.
- **Stored results:** only complete results with status `found` or `none-reported`, no reasons, and the requested package identity.
- **Never stored:** unavailable, incomplete, timed-out, aborted, oversized and identity-mismatched results. An outage can't be cached as an empty finding.
- **Copies:** each response is a fresh copy, so callers can't change stored data.

| Limit        | Default    | Meaning                                                                 |
| ------------ | ---------- | ----------------------------------------------------------------------- |
| `ttlMs`      | 15 minutes | A stored result is served without contacting OSV for this long          |
| `staleMs`    | 6 hours    | An expired result may be served, marked stale, while OSV is unavailable |
| `entries`    | 256        | Least recently used results are evicted beyond this count               |
| `entryBytes` | 2 MiB      | Larger results are returned but not stored                              |
| `totalBytes` | 32 MiB     | Total stored JSON bytes; must not be below `entryBytes`                 |

Callers may lower limits but not raise them. Invalid limits throw at construction. The cache is lost on restart and is not shared between Cloud Run instances.

## Response fields

Each result keeps the OSV adapter fields and adds:

- **`cache.status`:**
  - `miss`: queried and stored.
  - `hit`: served from the cache.
  - `coalesced`: shared a concurrent identical request.
  - `stale`: an expired snapshot was served because the refresh was unavailable.
  - `uncached`: returned but not stored.
  - `bypass`: an invalid spec.
- **`diagnostics.provider`:** the OSV requests made for this response, with:
  - `availability`: `available`, `degraded`, `unavailable`, `not-queried` or `not-contacted` (a cache hit).
  - `requests`, `retries` and `timeouts`.
  - `failures`, as `{attempt, reason, httpStatus?}`. These are reason codes only, with no provider messages, URLs, keys or stacks.
- **`diagnostics.freshness`:** `state` (`live`, `cached`, `stale` or `none`), `queriedAt`, `ageMs` and, for stored results, `freshUntil`.

### Stale results

A stale result is downgraded to `status: "incomplete"` and `complete: false`, with reason `stale-cache` plus the failed refresh's reasons. It keeps its original `queriedAt`, and known advisories stay visible.

An incomplete refresh, such as a later page timing out, is returned as it is, without being mixed with older data.

### Timing

In hosted job details, the values were captured when the job's enrichment ran, not when the details page is read.

The OSV lookup deadline, 12 seconds by default, must stay shorter than any caller's own timeout so that partial page records can survive a timeout.

## Retries and provider load

- **Retry:** one retry per lookup, after 250 ms, only for HTTP 429/500/502/503/504 or network errors, and only within the lookup deadline. A `Retry-After` longer than one second disables the retry.
- **Concurrency:** concurrent identical lookups make one upstream request. The shared request is cancelled only when every waiter has aborted.
- **Failures:** failures are not cached, so a persistently failing provider is queried again on each new lookup. The queue and endpoint admission limits bound that traffic.

## Aggregate statistics (opt-in)

`createAdvisoryCache(...).stats()` returns aggregate counters for the process:

```json
{
  "entries": 1,
  "bytes": 746,
  "inflight": 0,
  "hits": 1,
  "misses": 4,
  "coalesced": 1,
  "staleServed": 0,
  "uncached": 1,
  "bypassed": 1,
  "evicted": 1,
  "expired": 2,
  "limits": {
    "ttlMs": 900000,
    "staleMs": 21600000,
    "entries": 2,
    "entryBytes": 2097152,
    "totalBytes": 33554432
  }
}
```

The values above are the output of an actual run of the same lookup sequence as the regression test `aggregate stats count outcomes without exposing package identities`: an entry limit of 2, coalesced, hit, unavailable, bypass, eviction and stale-window expiry. Counters cover the life of the process. `inflight` and `entries` are current values.

### Privacy

Statistics never contain package names, versions, keys, per-entry timestamps, credentials or model data. They do reveal aggregate lookup volume across all users of the process. For that reason, the hosted server does not publish them by default.

### Enabling

Set `UNMASK_ADVISORY_CACHE_STATS=1` for the server process. Every advisory result's `diagnostics` then also carries a `cacheStats` snapshot taken when that result was produced. This includes `vulnerabilityCheck` in report details and the advisory-only results built from the same lookup.

Any other value leaves `cacheStats` out. There is no separate stats route, and `/healthz` is unchanged.
