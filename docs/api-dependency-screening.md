# Dependency screening API

`POST /api/dependency-screening` screens an npm lockfile (v2 or v3). For every exact npm registry identity in the lockfile, the server looks up advisories (OSV) and returns a per-dependency status. It also returns the dependency paths that explain why an advisory-bearing package, or a lock entry it could not screen, is present.

This is advisory identity screening only. It never installs, downloads tarballs or runs package code. It does not verify that tarball contents match the locked integrity, and it does not certify safety. A response with no advisories is not a safety verdict.

Source: `src/server/dependency-screening.mjs` (HTTP, admission and screening) and `src/core/dependency-graph.mjs` (lockfile parsing and path explanation). Tests: `tests/product/dependency-screening.test.mjs`.

## Request

```sh
curl -sS -X POST \
  -H 'content-type: application/json' \
  --data-binary @package-lock.json \
  http://127.0.0.1:3000/api/dependency-screening
```

- The method must be `POST`. The content type must be `application/json`, optionally with `; charset=utf-8`.
- The body is the raw lockfile bytes, at most 2 MiB, decoded as strict UTF-8 and parsed with `JSON.parse`.
- Cross-site browser requests are rejected: `sec-fetch-site: cross-site`, or an `Origin` that is not this host.
- The server never follows `resolved` URLs. The only outbound requests are exact-version OSV queries (`https://api.osv.dev/v1/query`) for accepted registry identities.

## Example

The response below was produced by running this branch's `startServer` on loopback. OSV was replaced by a local stub that reports GHSA-pjwm-rvh2-c87w for ua-parser-js and nothing for other packages. Only `screenedAt` was replaced.

Request lockfile:

```json
{
  "name": "demo",
  "version": "1.0.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "demo",
      "version": "1.0.0",
      "dependencies": {
        "left": "1.0.0",
        "ua-parser-js": "0.7.29"
      }
    },
    "node_modules/left": {
      "version": "1.0.0",
      "resolved": "https://registry.npmjs.org/left/-/left-1.0.0.tgz",
      "integrity": "sha512-bGVmdA==",
      "dependencies": {
        "ua-parser-js": "0.7.29",
        "gitdep": "github:example/gitdep"
      }
    },
    "node_modules/left/node_modules/ua-parser-js": {
      "version": "0.7.29",
      "resolved": "https://registry.npmjs.org/ua-parser-js/-/ua-parser-js-0.7.29.tgz",
      "integrity": "sha512-dWE="
    },
    "node_modules/ua-parser-js": {
      "version": "0.7.29",
      "resolved": "https://registry.npmjs.org/ua-parser-js/-/ua-parser-js-0.7.29.tgz",
      "integrity": "sha512-dWE="
    },
    "node_modules/gitdep": {
      "version": "1.0.0",
      "resolved": "git+ssh://git@github.com/example/gitdep.git#0123abc"
    }
  }
}
```

Response, HTTP 200:

```json
{
  "schemaVersion": "1",
  "source": "OSV",
  "lockfileVersion": 3,
  "root": {
    "name": "demo",
    "version": "1.0.0",
    "location": "",
    "status": "not-screened"
  },
  "screenedAt": "<timestamp>",
  "status": "advisories-found",
  "coverage": {
    "scope": "exact-registry-identities",
    "registryComplete": false,
    "projectScreened": false
  },
  "summary": {
    "entries": 4,
    "identities": 2,
    "advisoryBearing": 1,
    "found": 1,
    "noneReported": 1,
    "incomplete": 0,
    "unavailable": 0,
    "notScreened": 0,
    "rejected": 1,
    "local": 0
  },
  "advisoryBearing": ["ua-parser-js@0.7.29"],
  "statement": "Coverage describes exact registry identities only; the project root, local, rejected and unscreened entries were not checked. No reported advisory is not a safety verdict.",
  "dependencies": [
    {
      "spec": "left@1.0.0",
      "name": "left",
      "version": "1.0.0",
      "locations": ["node_modules/left"],
      "locationCount": 1,
      "dev": false,
      "optional": false,
      "integrity": "sha512-bGVmdA==",
      "integrityStatus": "consistent",
      "status": "none-reported",
      "complete": true,
      "reasons": [],
      "advisories": []
    },
    {
      "spec": "ua-parser-js@0.7.29",
      "name": "ua-parser-js",
      "version": "0.7.29",
      "locations": [
        "node_modules/left/node_modules/ua-parser-js",
        "node_modules/ua-parser-js"
      ],
      "locationCount": 2,
      "dev": false,
      "optional": false,
      "integrity": "sha512-dWE=",
      "integrityStatus": "consistent",
      "status": "found",
      "complete": true,
      "reasons": [],
      "advisories": [
        {
          "id": "GHSA-pjwm-rvh2-c87w",
          "aliases": ["CVE-2021-27292"],
          "summary": "Embedded malware in ua-parser-js",
          "databaseSeverity": "CRITICAL"
        }
      ],
      "explanation": {
        "spec": "ua-parser-js@0.7.29",
        "locations": 2,
        "direct": true,
        "paths": [
          [
            {
              "location": "",
              "name": "demo",
              "version": "1.0.0"
            },
            {
              "location": "node_modules/left",
              "name": "left",
              "version": "1.0.0"
            },
            {
              "location": "node_modules/left/node_modules/ua-parser-js",
              "name": "ua-parser-js",
              "version": "0.7.29"
            }
          ],
          [
            {
              "location": "",
              "name": "demo",
              "version": "1.0.0"
            },
            {
              "location": "node_modules/ua-parser-js",
              "name": "ua-parser-js",
              "version": "0.7.29"
            }
          ]
        ],
        "complete": true,
        "reasons": []
      }
    }
  ],
  "rejected": [
    {
      "location": "node_modules/gitdep",
      "name": "gitdep",
      "reason": "non-registry-resolved",
      "dev": false,
      "optional": false,
      "status": "rejected",
      "explanation": {
        "location": "node_modules/gitdep",
        "locations": 1,
        "direct": false,
        "paths": [
          [
            {
              "location": "",
              "name": "demo",
              "version": "1.0.0"
            },
            {
              "location": "node_modules/left",
              "name": "left",
              "version": "1.0.0"
            },
            {
              "location": "node_modules/gitdep",
              "name": "gitdep",
              "version": "1.0.0"
            }
          ]
        ],
        "complete": true,
        "reasons": []
      }
    }
  ],
  "local": [],
  "limits": {
    "identities": 200,
    "concurrency": 4,
    "deadlineMs": 60000
  }
}
```

## Lockfile rules

The parser reads only `packages`. Files with `lockfileVersion` other than 2 or 3, or without a `packages` object, are rejected as a whole. So is any file with more than 20000 entries.

Each `packages` entry other than the root `""` becomes exactly one of the following:

| Outcome                      | Condition                                                                                                                                                                                 |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| registry identity (screened) | Key under `node_modules/`, exact semver `version`, and `resolved` exactly `https://registry.npmjs.org/<name>/-/<basename>-<version>.tgz`                                                  |
| `local`, `linked-local`      | `link: true` under `node_modules/`                                                                                                                                                        |
| `local`, `workspace-package` | Key without a `node_modules` segment, a `version`, and no `resolved`, `integrity` or `inBundle`                                                                                           |
| `rejected`, with one reason  | `invalid-entry`, `invalid-location`, `alias-identity`, `bundled-dependency`, `no-version`, `non-exact-version`, `missing-resolved`, `non-registry-resolved`, `resolved-identity-mismatch` |

An npm alias entry (`name` differs from the installed folder name) is screened as the real `name@version` only when `resolved` is exactly that package's registry tarball. The folder name is then listed in `installedAs`. Any other alias is rejected as `alias-identity`.

Identities are deduplicated by `name@version`. `locations` lists the first 20 lockfile keys and `locationCount` gives the total. `integrity` is set only when every location carries the same valid SRI (`sha256`, `sha384` or `sha512`). Otherwise `integrityStatus` is `missing` or `conflicting` and `integrity` is `null`.

## Response contract (`schemaVersion: "1"`)

- `status`:
  - `advisories-found` when any dependency carries advisories, whatever that lookup's status.
  - Otherwise `none-reported` when `coverage.registryComplete` is true.
  - Otherwise `incomplete`.
- `coverage.registryComplete` is true only when there are no rejected rows, no identity has `integrityStatus: conflicting` (counted in `summary.integrityConflicting`), and every identity has `complete: true`. `coverage.projectScreened` is always `false`, and `root.status` is always `not-screened`.
- `advisoryBearing` lists the spec of every dependency with at least one advisory, including dependencies whose lookup was `incomplete`.
- `dependencies[].status` and when each value applies:

| `status`        | Meaning                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `found`         | The lookup is complete, bound to this exact identity, and returned advisories                                                  |
| `none-reported` | The lookup is complete, bound to this exact identity, and returned none. This is not a safety verdict                          |
| `incomplete`    | Some advisories were returned, but the lookup stopped early or was inconsistent. The advisories are kept                       |
| `unavailable`   | No usable result: lookup failure, identity mismatch, invalid or inconsistent result, or the deadline reached during the lookup |
| `not-screened`  | Never queried: over the 200-identity limit, deadline reached before start, or request aborted                                  |

- `dependencies[].complete` is true only for `found` or `none-reported` with no reasons.
- `dependencies[].reasons` holds the reasons passed through from the OSV lookup (for example `timeout`, `http-error`, `page-limit`, `response-limit`). It can also hold these screening reasons: `identity-mismatch`, `invalid-lookup-result`, `inconsistent-lookup-result`, `lookup-failed`, `time-limit`, `aborted`, `identity-limit` and `advisory-output-limit`.
- `dependencies[].advisories` holds at most 20 entries. Each has `id`, `aliases`, and optionally `summary`, `databaseSeverity`, `withdrawn`, and `affected` (limited to this package, with `ecosystemSeverity`). Consumers should classify these records with the shared guard classifier rather than reading summaries.
- `dependencies[].explanation` appears only on advisory-bearing dependencies. `rejected[].explanation` appears on every rejected row.
  - Both shapes are `{spec | location, locations, direct, paths, complete, reasons}`.
  - Paths run from the project root `""` (or a workspace folder) to each location, as `{location, name, version}` nodes.
  - Explanation reasons are `path-limit` (20 paths), `depth-limit` (32), `visit-limit` (20000), `edge-limit` (200000 edges), `cycle-without-root`, `unreachable-location` and `explanation-limit`.
  - `explanation-limit` is returned once more than 50 explanations of a kind are needed; that placeholder has `direct: null` and `paths: []`.
- `local[]` and `rejected[]` rows were not screened. They carry `status` `not-screened` and `rejected` respectively.

## Errors and limits

Each row below was observed against the running server. Error bodies are JSON.

| HTTP | Body                                                              | When                                                                                                                                   |
| ---- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 405  | `{"error":"method-not-allowed"}` with `allow: POST`               | Any method other than POST                                                                                                             |
| 403  | `{"error":"origin-rejected"}`                                     | Cross-site fetch metadata or a foreign `Origin`                                                                                        |
| 415  | `{"error":"expected-json-lockfile"}`                              | Content type is not JSON                                                                                                               |
| 503  | `{"error":"advisory-lookup-unavailable"}`                         | Server built without an advisory lookup                                                                                                |
| 413  | `{"error":"lockfile-too-large"}`                                  | Body or declared `content-length` over 2 MiB                                                                                           |
| 400  | `{"error":"body-unavailable"}`                                    | Client aborted or the stream failed. A body slower than 10 s returns 408 with the same body                                            |
| 400  | `{"error":"invalid-lockfile","reason":"invalid-json"}`            | Body is not JSON. Other reasons: `invalid-utf8`, `invalid-lockfile`, `unsupported-lockfile-version`, `missing-packages`, `entry-limit` |
| 429  | `{"error":"screening-limit","retryAfter":600}` with `retry-after` | Limits exceeded (see below). The example shows the 7th screening inside the window                                                     |

Limits are per server process and global (not per client):

- 30 body attempts per 10 minutes.
- At most 2 bodies being read at once.
- 1 screening at a time.
- 6 screenings per 10 minutes.
- The body is read and parsed before the screening slot is taken, so a slow upload cannot hold the slot.

Inside one screening:

- At most 200 identities and 4 concurrent OSV lookups.
- A 60 s deadline that also ends lookups still in flight.
- Each OSV lookup keeps its own limits: 12 s, 1 MiB, 3 pages, 100 advisories.

Clients must treat transport errors, non-200 responses, unknown fields and any row that is not `complete` as unknown, never as permission.
