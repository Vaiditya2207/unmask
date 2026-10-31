# Analysis and service contracts

These contracts describe the reviewed implementation. Source and live deployment snapshots are distinguished in the [status and inspected revision](README.md),
[architecture](architecture.md) and [stack](stack.md).

## Inputs and entrypoints

The CLI supports these forms in a built/installed candidate. Public registry metadata now lists version `0.1.0`; this documentation review did not install or verify the published artifact.

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

Module paths below identify the implemented backend. The separately merged Next.js frontend lives under `web/`.

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
Transient model failures and runner failures require a fresh POST. Incomplete
results are reusable only when every failure is an explicitly supported deterministic
cap or `source-selection-unresolved` with reason `ambiguous-manifest`; mixed transient
or unknown failures are not reusable. A queue wait expires after 300 seconds; execution has
a 240-second deadline, including a 120-second deterministic child stage and up to
135 seconds of model work. The outer execution deadline still caps the combined stages.

Reports live in a bounded in-memory LRU store: 200 entries, 64 MiB combined,
up to 30 minutes after completion. Reads do not extend that TTL; capacity eviction or restart can remove results sooner. The hosted result cap is also 64 MiB per
result, including model success and failure sections. This is a single-process
service contract, not distributed admission or durable storage.

## Model and distribution boundaries

The shared factory requires explicit model enablement and configured provider access. The default Google route is `gemini-3-flash-preview` minimal thinking → `gemma-4-26b-a4b-it` minimal thinking. The default route allows at most two generation attempts total, each at most 45 seconds, within 135 seconds overall. Invalid output can retry the same tier within that budget; scoped transient failures can fall through. Proven model-specific daily exhaustion skips directly to the next distinct model without waiting; global, authentication and ambiguous quota failures remain terminal. Input is capped at 4,000 tokens, with default output caps of 4,096 for Gemini and 1,000 for Gemma.

Provider quota remains unknown. Default local controls are three generations/minute, 12,000 input tokens/minute and 100 generations/day, shared by the long-lived client across jobs. These controls reset on restart and do not establish provider entitlement or billing limits. The model has no tools, validates citations, and skips calls without eligible evidence. Hypotheses cannot modify findings or file states. The [live zod result](README.md#model-evidence-and-acceptance) establishes a validated Gemini advisory result, not usefulness, study or open-weight hackathon acceptance.

The package identity is `@xagents_in/unmask`, with current source candidate `0.1.2` pending release and deployment acceptance. Release `0.1.0` was published and verified; the dated [deployment snapshot](README.md) retains its observed runtime versions and commits. One explicit copy build places the backend CLI, core, model, server and original viewer in `dist/`. The CLI bin is `dist/cli/main.mjs`, and the API entrypoint is `dist/server/main.mjs`. Build metadata records version, source commit when clean, dirty status and a source digest. The packed tarball hash is supplied separately, avoiding a circular embedded hash.

The API container consumes the packed tarball and matching lockfile. The separate Next.js service has its own standalone container and serving identity; the observed candidate is `4de9ec1194ac144823102be36de0350633a7c27e`. Its `/check` proxies the API submission with a relative 303; `/api/reports/<id>` passes through job/report JSON. Live schema 1 reports link to the API's original viewer until the Next viewer has a schema mapping. Browser and hosted CLI users need no local provider key.

The API `/version` returns version, commit and tarball hash. The website `/version` returns version and commit. Both observed services are recorded in the [deployment snapshot](README.md); these identifiers do not replace image-digest and routing verification on each rollout. Use `/version` for the public Cloud Run identity smoke; the API's local main-process `/healthz` route can return 404 through the platform frontend. See the [release contract](releases.md) for artifact checks; publication metadata alone does not verify an installed release.

The additive [`GET /r/<id>.details.json` package details endpoint](package-details.md) projects the existing schema-1 report without starting analysis. It shares job/expiry behavior with report JSON; the strict report schema and CLI JSON are unchanged.
