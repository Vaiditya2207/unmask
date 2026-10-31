# UNMASK user stories and acceptance criteria

> **Working record, 31 Oct – 1 Nov 2026.** Kept as written during the hackathon, except that private identifiers were removed for publication. Statuses describe the moment of writing; the [product docs index](README.md#then-and-now) shows what shipped since.

Every story is **[P]**, proposed and not yet implemented.

Priority:

- **P0** — protected core
- **P1** — core, cut only with explicit acceptance-unmet disclosure
- **S** — stretch

Lane is the owning stream from v27: A acquisition, B diff/CLI, C viewer/web, D model/eval, E release/deploy. Rule IDs and states use v27 terms (`../engineering-proposal-v27.md`).

## CLI

**CLI-1 (P0, A+B): check a local tarball against an explicit source.**
As a judge, I can run `unmask check --tarball FILE.tgz --source-archive SOURCE.tgz --commit FULL_SHA --source-root ARCHIVE_ROOT [--source-dir RELATIVE_DIR] --offline --cache-dir CACHE --out OUTPUT`, optionally with `--claim name@version`, and get a report. This is the implemented local mode per v23: offline, with `--source-root` naming the archive prefix and `--source-dir` naming the package directory. Online tarball plus remote source fetch is not in the current implementation.

- The report records the SHA-256/512 of the exact input bytes, and never replaces the local input with a registry download.
- Both blobs are captured first, then inspected artifact-first and source-second in original TAR order, so results never depend on network arrival order. Path depth, path length and aggregate path-node limits apply.
- Provenance shows `not-assessed` in this slice.
- Every artifact regular file has exactly one state: byte-identical, changed, artifact-only or not-compared(reason). Coverage bytes use the full artifact inventory as the denominator.
- If the claim conflicts with the inner `package.json` name or version, the report contains that conflict, and its rule ID gives exit 3.
- It writes `report.json` (schema-valid) and `report.html` (escaped, strict CSP, no network).
- Nothing from the target is executed. A test with an install-script fixture proves no hook runs.

**CLI-0 (P0, A+B): pre-artifact failures.** A missing, unreadable or oversize local file exits 2 with a bounded diagnostic. No report and no fabricated digests are produced. Once an artifact is accepted, failures produce a partial report.

**CLI-6 (P0, B): package review summary.** The header shows "Review required" when any exit-3 rule fires, "Review suggested" when only cues exist, and "Incomplete" if and only if the exit code is 2, with findings and rule IDs still visible beneath it. An artifact-only report with unresolved source is "Completed, source unavailable" with 0% source coverage, and it exits 0 or 3. It also shows counts and byte coverage. There is no grade, and it never says "safe". The website shows the same.

**CLI-7 (P0-lite, B or independent lane): novelty cue.** In artifact-only and changed JS, Acorn extracts string literals with Unicode-correct byte spans.

- A literal with no exact match among the selected source's literals is novel.
- Only a direct literal as the first argument of a recognized call counts. Novelty is not-assessed for TS-only source, a truncated index, or an unsupported or unretained matched source; each of these has a test.
- Two pairs produce a `review-suggested` cue: a novel network destination used with a network call, and a novel shell command used with a process call.
- The reference distribution is measured first. The cue never triggers exit 3. "Novel" means not found in the inspected literals.

**CLI-2 (P0, B): exit codes mean exactly what they say.**

- Failed or incomplete acquisition or parse gives 2. A review-policy finding gives 3. Otherwise 0. An internal error gives 1.
- An exit-2 report still lists policy findings in its JSON.
- Policy tests assert exact rule IDs: `integrity-mismatch` (registry mode; remote lookup for local tarballs is deferred, v24), `identity-claim-conflict`, `lifecycle-source-absent`, `lifecycle-implicit-gyp`.
- A dependency-only cue does not by itself give exit 3.

**CLI-3 (P0, A+B+package lane): check by name, hosted by default (v27, user-authorized; implementation pending).** `unmask check name@exact-version` sends only that spec to the UNMASK service: `POST /check`, then same-origin polling of `/r/<id>.json`. The default URL is the actual deployed HTTPS URL, with `UNMASK_SERVER_URL` as an override. The CLI writes the report and renders HTML locally, and returns the report's exit code.

- No model key, local files or environment values are sent.
- No silent local fallback: a hosted failure gives exit 2 with a clear message.
- It shares the server's admission (6 per 10 min) and queue.
- Hosted responses are validated as untrusted input.
- It needs `--out` but not `--cache-dir`.
- The CLI help states that the package name and version are sent to the service.

_Superseded default, below:_ the earlier local registry-mode acceptance, which still describes the server's own acquisition behaviour.

**CLI-3a (server-side acquisition, unchanged).**
`unmask check name@version` fetches only from registry.npmjs.org and codeload.github.com at a full SHA, and follows no redirects.

- If the source is unresolved or conflicting, it produces an artifact-only report and states that source comparison is unavailable. It never silently uses HEAD or a tag.
- For a monorepo (zod), it selects `packages/zod` only by `repository.directory` or by an unambiguous name match. If ambiguous, it selects nothing.

**CLI-4 (P0, A+B): offline replay.**
`--offline` with a supplied source archive makes no network requests. Integrity shows as unavailable. Results are deterministic.

**CLI-5 (P1, D): model triage.** Scope (v18): every changed or artifact-only hunk, including manifest hunks. Deterministic retrieval provides context only. A pre-registered B1 baseline is scored identically. For each hunk, the model returns `review-concern`, `possible-transformation` or `unknown` (the implemented schema IDs) with a localized, cited rationale. A counterpart can exist for a malicious logic edit.

- Scoring on the 8+2 fixtures: end-to-end recall over all planted hunks, where omissions are misses. Conditional category, localization and citation accuracy and false alarms are measured on eligible included cases.
- `unknown` (insufficient context) is excluded from the reasoning success rate but kept in the end-to-end denominator.
- Novelty cues are never credited to the model.
- Budget ranking: policy evidence, then novel-literal pairs, then capability pairs, then path and range. Omitted IDs are listed.
- Source maps are not used in the initial gate.
  Model configuration comes from the environment (see the public stack docs). The CLI sends excerpts **only** with `--allow-model`, for registry and local input alike (v23, stricter consent). Without the flag, the specified state is `not-sent(consent-required)`, checked by fail-if-called factory, countTokens and generate stubs on both input types. This is pending implementation (v25); the current code returns `disabled`; otherwise the status is `not-sent(local-input)`, proved by a stub that fails if called. Without configuration, the status is `disabled`.
- The model stage is at most 2 attempts of at most 45 s each, within 90 s. Failed model sections are never cached.
- With the model on or off, the canonical deterministic fields are byte-identical.

## Website

**WEB-1 (P0, C): check by name, asynchronously.**
As a developer, I enter `name@version`. POST `/check` returns 303 to `/r/<id>`. The status page shows queued, running, done or failed(reason), refreshing by meta-refresh with no script. When done, it shows the report and a JSON link.

- A GET never starts analysis or retries a model call.
- Identical requests (same exact name/version, analyzer, policy, limits and `modelConfigDigest`) reuse a queued, running or terminal `done` job without admission. Failed, timeout, queue-expired and transient model-unavailable results are never reused; a new POST consumes admission.
- Input must be a valid npm name and an exact semver. Any URL is rejected.
- The page leads with identity, byte-first coverage, rule IDs labelled "review required", then files, evidence and a separate model panel.
- The words "safe", "clean" or "verified safe" never appear as a verdict.

**WEB-2 (P0, C+B): parity with the CLI.**
On the four registry references, through an injected recorded fetcher, the website and CLI canonical deterministic reports are byte-identical for the same parity key: artifact, source-archive and registry-doc digests, policy version, analyzer version and `limitsVersion`. The canonical report includes the actual configured limits. A fixture crossing the 128 MiB retention cap, and both fetch orders, must also be parity-equal. Time, cache, host and surface fields are excluded via `report.run`; deterministic tool versions are included. Variants are CLI-only.

**WEB-3 (P0, C): hosted limits.**

- One instance with no autoscale. The main process serves HTTP and `/healthz`. One analysis child process with a 512 MiB heap; a child failure leaves `/healthz` up.
- One active and one waiting job. A waiting job expires after 300 s as `incomplete(queue-expired)`, with no automatic retry. Overflow returns 429 with Retry-After and a shared-global-limit message.
- Execution budget 240 s: acquisition plus compare at most 120 s, model at most 90 s.
- Global admission of 6 new checks per 10 minutes. No per-IP limit is claimed until the proxy header is verified.
- The core single 128 MiB retained-buffer cap across artifact and source, the same in CLI and web, checked before allocation. Content beyond it is stream-hashed: byte comparison stays valid, syntax and model are marked `not-inspected(retention-cap)`, and localization is whole-file.
- Memory: 512 + 128 + 64 = 704 MiB plus overhead. Proposed floor 2 GiB, pending measurement.
- Each job gets a private temp directory (at most 50 MiB per blob plus 1 MiB of metadata). The parent deletes it after the worker exits, on every path. A startup sweep removes own-prefix leftovers before any job is accepted.
- Reports kept in an LRU (64 MiB, 200 reports) under random 128-bit IDs, with noindex and no listing. **Completed reusable results expire 30 minutes after completion** (v27, user-requested), with no sliding TTL. Failed, model-unavailable or invalid results are never reused. The cache identity includes the routing policy digest and does not change after a tier fallback.
- Logs contain no excerpts.
- `UNMASK_MODEL=off` gives `model: disabled`, with deterministic results unchanged.

**WEB-4 (P1, D): hosted Gemma.**

- The model stays `disabled` until a project budget is configured and the IDs and quota are verified with the key. No daily number is assumed.
- The report names the provider, model ID and prompt hash.
- Once the operator-set cap is exhausted, the status is `unavailable(quota)`.
- The key never appears in responses, logs, the image or the repo.

**WEB-5: removed.** Website upload was cut from scope in v10 (21:30 trigger). Local tarballs use CLI-1.

**WEB-6 (P1, C+E): version endpoint.**
`GET /version` returns version, commit SHA and tarball SHA-256. It deliberately omits the image digest, which would be circular.

## Release and operator

**REL-1 (P0, E): a version bump creates an immutable artifact release.**
_Dormant while the user's no-new-PRs/no-push rule applies; it takes effect only when pushes and merges are re-authorized._

- A merge to main that bumps `package.json` runs the tests. An explicit `npm run build` clears `dist/` and copies allowlisted own source and assets, with no bundler and no prepack/prepare hooks. CI runs `npm pack` once (recording SHA-512/256), then smoke-tests the packed CLI and server.
- A main run with no version change, or with an incomplete scaffold, skips successfully with a named reason. PRs do not require a version bump.
- The release queues with `queue: max` and `cancel-in-progress: false`, and re-reads the tags and versions instead of trusting queue order.
- CI asserts npm CLI 11.5.1 or later for OIDC publishing and 11.15 or later for `npm trust`.
- Only an npm `E404` counts as "version absent". Auth or network errors fail closed.
- **Blocked until the user gives BOTH the scope/name string and owner identity AND explicit push/PR authorization (05:30 handoff) [B]. Absence is never permission.** The name gate is now answered: `@xagents_in/unmask`, owner `xagents_in` (`decisions-log.md`). Only the push/PR authorization remains. Account creation is not needed for the artifact release. Without an answer, there is no release or deploy; the demo uses the exact local candidate, labelled unreleased, and acceptance is unmet. Registry publication waits for the actual account. The working package is private `unmask@0.0.0`, which produces no release. The manifest includes the package name. After a refusal or a name change, the fix is a new patch under the chosen name; an old tarball is never renamed.
- The linux/amd64 GHCR image installs that exact tarball with the committed lockfile, via `npm ci --omit=dev --ignore-scripts`, with no independent build. Its digest is recorded.
- Then `release-manifest.json` with `registryPublished`, then the tag `vX.Y.Z` and a GitHub Release with the tarball attached.
- It refuses if the tag, npm version or GHCR tag already exists, if the version doesn't increase, or if the scaffold is incomplete.
- With npm blocked, the release completes with `registryPublished: false`, and registry acceptance stays unmet [B]. The owner later bootstraps the exact attached tarball with 2FA (no provenance claim); OIDC trusted publishing covers later versions.

**REL-2 (P1, E): deploy an exact digest.**
Not authorized yet. [B: DigitalOcean project]

- Once authorized, the operator uses the App Platform App Spec editor to set `image.digest` from the manifest and omit the tag.
- The dashboard digest equals the manifest digest, and `/version` matches version, commit and tarball SHA-256.
- Rollback means choosing an older manifest digest.
- GHCR visibility is a manual setting, still pending.

## Evaluation

**EVAL-1 (P0, D):** fixtures are in `../fixtures/MANIFEST.json`, built by the Fixture QA child and verified (`SELF_CHECK.json` passed; the holdout is sealed). the 4 references, 8 variants, the iconv normalization reference and 2 frozen held-out variants are scored as `demo-eval-plan.md` describes. All misses are reported.
