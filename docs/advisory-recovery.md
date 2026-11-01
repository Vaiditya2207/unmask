# Advisory-only results

UNMASK normally compares the published npm artifact with a source archive. When the exact registry version cannot be acquired or analyzed in time, there are no bytes to compare. A removed version that returns 404 is a common case, and the versions removed for malware are exactly the ones a reviewer most needs to see. Earlier releases ended such checks as a bare `analysis-failed`, which hid known advisories.

The hosted service now always runs the exact-version OSV lookup beside artifact acquisition. Any result that lacks an artifact report carries an `advisoryResult`. Advisory-only results never claim tarball, source or safety evidence.

## Where it appears

| Surface                                         | Behaviour                                                                                                                                                                                             |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /r/<id>.json` for a failed check           | `status: "failed"`, `reason: "analysis-failed"`, plus `advisoryResult`                                                                                                                                |
| `GET /r/<id>.json` after the execution deadline | `status: "incomplete"`, `reason: "execution-timeout"`, plus `advisoryResult`. A lookup that finished is kept; a lookup still pending at the deadline is reported as unavailable with reason `aborted` |
| `GET /r/<id>` (analyzer viewer)                 | The status page lists up to 50 advisory identifiers, HTML-escaped                                                                                                                                     |
| Website `/r/<id>`                               | Terminal status views render an "Advisory-only result" card after revalidating the lookup identity                                                                                                    |
| `GET /r/<id>.decision.json`                     | Guard decisions use the advisory-only lookup when the job has no report-level check, so a known-malware advisory blocks in every profile ([install decision contract](guard-decisions.md))            |
| `GET /api/advisory?package=<name@version>`      | The same result for one exact version, without starting artifact acquisition                                                                                                                          |

## Contract

```json
{
  "schemaVersion": "1",
  "kind": "advisory-only",
  "package": { "name": "node-ipc", "version": "10.1.1", "ecosystem": "npm" },
  "assessment": "advisories-reported",
  "advisoryCount": 1,
  "artifactVerification": {
    "status": "not-performed",
    "reason": "analysis-failed"
  },
  "sourceComparison": {
    "status": "not-performed",
    "reason": "analysis-failed"
  },
  "safetyVerdict": "not-provided",
  "notice": "Published advisories match this exact version. The registry artifact was not inspected, so no tarball or source evidence is included.",
  "vulnerabilityCheck": {
    "schemaVersion": "1",
    "source": "OSV",
    "status": "found",
    "advisories": ["..."]
  }
}
```

- `assessment` is one of `advisories-reported`, `advisory-lookup-incomplete`, `no-advisory-reported` or `advisory-lookup-unavailable`.
- `artifactVerification.reason` is one of `analysis-failed`, `execution-timeout` or `not-requested`. The endpoint always uses `not-requested`.
- `vulnerabilityCheck` is the bounded, identity-checked OSV envelope used elsewhere in the service. It includes cache provenance and diagnostics from the [advisory cache](advisory-cache.md).
- `no-advisory-reported` and `advisory-lookup-unavailable` are not evidence of safety. An artifact that cannot be acquired is not, by itself, evidence of malware. The worker reports any acquisition failure as `analysis-failed`, so a registry 404 cannot be told apart from a transient failure.

## Exact-version endpoint

`GET /api/advisory?package=<url-encoded name@exact-version>`

| Response | Meaning                                                                                                          |
| -------- | ---------------------------------------------------------------------------------------------------------------- |
| 200      | Advisory-only result. Header `x-unmask-reused: true` when an identical in-flight lookup was shared               |
| 400      | `{"error":"invalid-package-spec"}`: ranges, tags, URLs, a missing version, or extra or repeated query parameters |
| 429      | `{"error":"rate-limited","retryAfter":N}` with a `Retry-After` header                                            |
| 503      | `{"error":"advisory-lookup-disabled"}` when the server runs without advisory lookups                             |

Limits are per process:

- identical in-flight requests are coalesced
- at most 2 lookups run at once
- 30 lookups are admitted per 10 minutes
- each lookup has a 15 second budget; failures and timeouts are reported as unavailable, never as empty

The queue, this endpoint and dependency screening share one advisory cache, so a repeated lookup within the cache TTL does not contact OSV.

## Executed example

This run used a local server built from this branch. The worker was a fixture that exits like a registry 404, and OSV made exactly one read-only request:

```text
REAL OSV: POST /check node-ipc@10.1.1 -> {"status":"failed","reason":"analysis-failed","assessment":"advisories-reported","artifactVerification":{"status":"not-performed","reason":"analysis-failed"},"safetyVerdict":"not-provided","advisories":["GHSA-97m3-w2cp-4xx6"],"lookupStatus":"found","reasons":[],"cache":"miss","freshness":"live","provider":"available"} | real OSV page requests: 1
REAL OSV cached: GET /api/advisory node-ipc@10.1.1 -> {"assessment":"advisories-reported","cache":"hit","provider":"not-contacted"} | real OSV page requests: 1
```

This example does not demonstrate behaviour against the deployed service, other advisories or later OSV data.
