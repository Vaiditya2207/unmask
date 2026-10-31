# Analysis and service contracts

These contracts describe the pending implementation, not code shipped by this
documentation-only change. See the [status and inspected revision](README.md),
[architecture](architecture.md) and [stack](stack.md).

## Inputs and entrypoints

The CLI supports the following forms in the reviewed implementation. These
commands require the pending package build; they are not scaffold commands.

```bash
unmask check package-name@1.2.3 --out OUTPUT
unmask check --tarball PACKAGE.tgz --offline --cache-dir CACHE --out OUTPUT
unmask check --tarball PACKAGE.tgz --source-archive SOURCE.tgz \
  --commit FULL_SHA --source-root ARCHIVE_ROOT --offline \
  --cache-dir CACHE --out OUTPUT
```

Local mode also accepts `--claim name@version` and `--source-dir RELATIVE_DIR`.
A selected local source requires a full 40-character commit claim and explicit
safe archive root. Registry and local/offline modes cannot be combined. Tags,
ranges and mutable source refs are not accepted as exact input.

Every CLI check requires `--out`; offline checks also require `--cache-dir`.
Hosted checks accept an optional `--cache-dir` without reading or writing it.
Output writes use
exclusive creation: existing `report.json` or `report.html` files are not
silently overwritten. Package paths never become output destinations. Local
input bytes are retained as the analyzed artifact, not replaced by registry bytes.
Offline mode prevents registry and source acquisition, including inferred lookups.

Public exact-version checks submit only the spec to `POST /check`, then poll the
same-origin `/r/ID.json`. The hosted report is untrusted: the CLI bounds transport,
validates the report schema, exact claim and deterministic policy, renders escaped
HTML locally, and returns its validated policy exit code. No local/provider key
is read or transmitted, and hosted failures never trigger local acquisition.
The default origin is `https://unmask-386156642190.asia-south1.run.app`;
`UNMASK_SERVER_URL` selects another service. See [CLI configuration](cli.md) for
bounds and release-verification prerequisites.

`--allow-model` applies only to offline local evidence. It permits sending selected
evidence even with `--offline`, whose scope is acquisition. Without the flag no
local model factory is invoked. Invalid local model configuration is disclosed
under the model stage while deterministic analysis continues. Hosted checks reject
this flag and follow the service's published model/data disclosure instead.

## Module interfaces

Module paths refer to the pending layout rather than files already on main.

| Module                                  | Interface and responsibility                                                                                               |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `core/acquire.mjs`                      | `parsePackageSpec`, `fetchBlob`, `getRegistryRelease`: exact identity and bounded approved-host acquisition                |
| `core/resolve.mjs`                      | `resolveSource`: source candidates, trust labels and conflicting claims                                                    |
| `core/archive.mjs`                      | `readArchive(bytes, options)`: inert bounded inventory                                                                     |
| `core/source.mjs`                       | `selectSourcePackage(inventory, options)`: explicit or unambiguous package directory                                       |
| `core/compare.mjs`                      | `compareInventories(artifact, sourceOrNull)`: correspondence, coverage and evidence                                        |
| `core/pipeline.mjs`                     | `analyzeLocal(options)`: local input orchestration, syntax and manifest observations                                       |
| `core/online.mjs`                       | `analyzeRegistry(spec, options)`: captured registry inputs through the same local core; optional advisory model attachment |
| `core/report.mjs`                       | `createReport`, `validateReport`, `canonicalReport`: validated JSON and deterministic serialization                        |
| `core/policy.mjs`                       | `policyResult(report)`: deterministic exit code and exact findings                                                         |
| `core/syntax.mjs`, `core/manifests.mjs` | Bounded JavaScript inspection and manifest observations; cues remain distinct from policy                                  |
| `model/config.mjs`                      | `modelClientFromEnv(env)`: shared explicit configuration factory, independent of the server                                |
| `model/client.mjs`                      | `createGemmaClient(options)`, `attachModel`: bounded evidence bundling, citation checks and advisory output                |
| `server/runner.mjs`                     | `createRunner(options)`: one active invocation per runner, child lifetime, output bounds and cleanup                       |
| `server/main.mjs`, `server/app.mjs`     | `startServer`, `createApp`: HTTP lifecycle, queue/store wiring and metadata                                                |
| `viewer/render.mjs`                     | `renderReport(report)`: shared escaped HTML evidence view                                                                  |

## Archive and source objects

`readArchive` consumes original gzip-compressed tar bytes with
`{kind, limits?, retentionBudget?, sourceRoot?}`. `kind` is `artifact` or `source`.
Artifact mapping strips one validated leading path component. Source mapping
requires its declared root, then the selected package directory.

```text
ArchiveInventory = {digest: {sha256, sha512}, entries, complete, failures, totals}
Entry = {
  path, originalPath, type, size,
  sha256?, content, inspection, linkTarget?
}
```

`path` may be null for an unmapped entry. Regular-file content is either an inert
retained Buffer or null; it is not public JSON. `inspection` distinguishes
retained content, per-file or shared retention limits, and nonregular entries.
Links retain their raw targets and are never dereferenced. Failures carry stable
codes and bounded evidence; incomplete totals are lower bounds.

The parser rejects unsafe original or effective paths, unsupported entry types,
traversal, NULs and canonical collisions, including case and Unicode collisions.
Over-retention regular files are stream-hashed rather than represented by a
misleading retained prefix. Source package selection requires an explicit usable
directory or exactly one matching manifest; ambiguity remains unresolved.

## Correspondence and evidence

Every accepted artifact regular file appears once in the comparison:
`{path, originalPath, size, artifactSha256, sourceSha256?, state, reason?, localization}`.

| State            | Meaning                                                                      |
| ---------------- | ---------------------------------------------------------------------------- |
| `byte-identical` | Equal size and SHA-256 against an observed regular source file               |
| `changed`        | A usable counterpart exists and bytes differ                                 |
| `artifact-only`  | Absence can be established within the complete selected source inventory     |
| `not-compared`   | Source or mapping is unavailable, incomplete, linked or otherwise unsuitable |

Incomplete source, a source link at or above a path, or an unresolved package root
cannot establish absence. Changed retained files can expose half-open byte spans;
limits can reduce localization to a whole-file difference. A sourcemap or matching
filename does not establish bundle equivalence.

Evidence records bind IDs to the input blob digest, side, original/normalized
path and byte range. Excerpts preserve provenance and have explicit excerpt
ranges. A model citation must quote the supplied evidence; a valid quotation
proves a location, not semantic correctness.

## Report and exit policy

```text
Report = {
  schemaVersion, analyzerVersion, policyVersion, limitsVersion,
  inputs, source, files, coverage, evidence, manifests,
  cues, annotations, failures, model, run, policy
}
policy = {exitCode, findings}
```

The report schema version is `1`; the reviewed default policy is `default-1`.
`inputs` includes original artifact digests, optional source and registry-document
digests, identity claims, parser identity and effective limits. `source` records
selection status, method, optional repository/commit/directory and alternatives.
Supported method labels include `publisher-gitHead`, `user-full-SHA`,
`provenance-claimed`, `provenance-verified`, `unresolved` and `conflicting`.
A supported label is not evidence that a cryptographic verifier ran.

`coverage` separates inventory, correspondence, syntax inspection and model
review. `run` holds operational observations, surface, timestamps and timings.
`model` contains only advisory state and validated output. Report validation
checks JSON structure, evidence references, byte ranges, counters and consistency
with the computed policy.

`canonicalReport` sorts object keys and excludes only top-level `run` and `model`.
Parity requires the same complete captured input set, analyzer, policy, parser
and effective limits. Re-fetching a mutable registry document can change that
input set. CLI/web parity is not a promise that unrelated live requests hash alike.

| Exit | Contract                                                                                                  |
| ---- | --------------------------------------------------------------------------------------------------------- |
| `0`  | Deterministic report completed without a default-policy finding; not a safety verdict                     |
| `1`  | Unexpected internal execution error; no completed result is claimed                                       |
| `2`  | Input/usage failure or incomplete deterministic analysis; accepted inputs may still have a partial report |
| `3`  | Completed deterministic analysis with at least one default-policy review finding                          |

Incomplete analysis takes precedence over findings: exit `2` retains any findings
in the report. Failure before accepting artifact bytes emits no invented input
hashes or fabricated report. Model failure does not alter the policy exit code.

Default findings are `integrity-mismatch`, `identity-claim-conflict`,
`lifecycle-source-absent` and `lifecycle-implicit-gyp`.
`provenance-verification-failed` is reserved for an explicitly implemented failed
verifier; the current acquisition path records provenance as not assessed.
Lifecycle absence requires complete, unambiguous source and usable manifests.
Registry/tarball normalization differences and syntax cues remain observations;
they do not automatically become a policy finding.

## HTTP contract

| Route              | Behavior                                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| `GET /`            | Registry-only release form; no analysis starts                                                           |
| `POST /check`      | Form-encoded `package=name@version`; admitted or reused jobs return `303` and `Location: /r/<32-hex-id>` |
| `GET /r/<id>`      | Escaped status or completed evidence page; pending pages have retry guidance                             |
| `GET /r/<id>.json` | Pending job metadata returns `202`; terminal metadata or report returns `200`                            |
| `GET /healthz`     | Main-process JSON health response; not analysis or deployment acceptance                                 |
| `GET /version`     | JSON strings `version`, `commit`, `tarballSha256`; unknown development metadata remains `unknown`        |

Admission refusal returns `429` with `Retry-After`. Input/body/content-type,
origin and method checks can return `400`, `403`, `405`, `408`, `413` or `415`.
Unknown, expired, evicted or restart-lost report locations return `404`. GETs
never submit or retry work. Report URLs are bearer locations, not authentication.

The in-process queue has one active job and one waiting slot. New admission is
shared globally within that server process: six checks per ten minutes. Coalesced
or reusable results do not consume a new admission. Keys bind exact identity,
build/analyzer/policy/limits versions, effective limits and model configuration.
Transient model failures and runner failures require a fresh POST; deterministic
cap results can be reused. A queue wait expires after 300 seconds; execution has
a 240-second deadline, including a 120-second deterministic child stage and up to
90 seconds of model work.

Reports live in a bounded in-memory LRU store: 200 entries, 64 MiB combined,
24-hour TTL. They are lost on restart. The hosted result cap is also 64 MiB per
result, including model success and failure sections. This is a single-process
service contract, not distributed admission or durable storage.

## Model and distribution boundaries

The shared factory requires explicit model enablement, verified positive quota
limits and configured provider access. The adapter supports a fixed Google host
and the candidate Gemma IDs listed in the [stack](stack.md). It has no tools,
bounds input/output, validates citations and skips calls without eligible
evidence. Hypotheses cannot modify deterministic findings or file states.

The pending package identity is `@xagents_in/unmask`, still private at `0.0.0` in
the inspected source. One explicit copy build places the CLI, core, model,
server and viewer in `dist/`. The CLI bin is `dist/cli/main.mjs` and the hosted
entrypoint is `dist/server/main.mjs`. Both consume the same report and renderer.
Build metadata records version, source commit when clean, dirty status and a
source digest; the deployed tarball digest is supplied separately, not invented
or calculated circularly from its own embedded metadata.

The intended image consumes the exact packed tarball and matching lockfile.
The reviewed snapshot has no Dockerfile or deployment proof. An npm account and
scope are selected, but neither registry publication nor a serving image follows
from that selection. See the existing [release contract](releases.md) for the
guarded tooling and remaining release steps.
