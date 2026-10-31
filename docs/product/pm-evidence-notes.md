# UNMASK PM: first-hand evidence notes (31 Oct 2026, ~20:10–20:30 IST)

> **Working record, 31 Oct – 1 Nov 2026.** Kept as written during the hackathon, except that private identifiers were removed for publication. Statuses describe the moment of writing; the [product docs index](README.md#then-and-now) shows what shipped since.

Collected by "UNMASK · Product manager" using curl, tar, cmp and openssl only. No package code was installed or executed.
Raw files are in `scratch/`. E = measured here. H = hypothesis.

## npm source mapping (E)

| pkg@ver       | gitHead | SLSA provenance | provenance commit == gitHead | workflow ref                      |
| ------------- | ------- | --------------- | ---------------------------- | --------------------------------- |
| chalk@6.0.1   | 47fc05a | none            | n/a                          | n/a                               |
| express@5.3.0 | cf6722b | yes             | yes                          | refs/tags/v5.3.0, npm-publish.yml |
| zod@4.6.7     | b500a2e | yes             | yes                          | refs/heads/main, release.yml      |
| axios@1.21.0  | aa54a5e | yes             | yes                          | refs/tags/v1.21.0, publish.yml    |

- Attestations come from `GET https://registry.npmjs.org/-/npm/v1/attestations/<name>@<ver>`. The DSSE payload holds the subject sha512 plus the SLSA v1 `buildDefinition.externalParameters.workflow` and `resolvedDependencies[].digest.gitCommit`.
- For zod and express, the attestation subject sha512 equals the registry `dist.integrity` (E). A tampered tarball presented as a real name@version will not match, so this is a cheap, decisive check. Caveat: the signature still needs to be verified with sigstore-js / `npm audit signatures`. Parsing the payload alone is not verification.
- axios declares `prepare: husky`. Lifecycle scripts must be read from the artifact's package.json and compared with the source's.

## npm artifact vs source at pinned commit (E)

| pkg                | artifact files | byte-identical | differ | artifact-only | nature of artifact-only                                       |
| ------------------ | -------------- | -------------- | ------ | ------------- | ------------------------------------------------------------- |
| chalk              | 12             | 12             | 0      | 0             | none                                                          |
| express            | 10             | 10             | 0      | 0             | none                                                          |
| axios              | 92             | 84             | 0      | 8             | dist/ bundles, .min.js, .map                                  |
| zod (repo root)    | 840            | 1              | 1      | 838           | WRONG ROOT, monorepo                                          |
| zod (packages/zod) | 840            | 335            | 0      | 505           | compiled .js/.cjs/.d.ts/.d.cts siblings of .ts; no sourcemaps |

- zod's `repository` has no `directory`, so monorepo subdir discovery must be heuristic (find the package.json whose `name` matches). (E)
- `axios.min.js.map` has 57 `sources` (../lib/...) with `sourcesContent` included. A bundle can be reconciled back to source files via its sourcemap, and sourcesContent can be compared with the git source. (E) Whether the bundle code actually equals the sourcesContent cannot be proven without a rebuild. (H)

## PyPI (E)

- JSON API `https://pypi.org/pypi/<p>/<v>/json` gives `project_urls`, sdist and wheel. The Simple JSON API (`Accept: application/vnd.pypi.simple.v1+json`) gives a per-file `provenance` URL.
- Integrity API `https://pypi.org/integrity/<p>/<v>/<file>/provenance` returned 200 for sigstore 4.5.1 (wheel+sdist) and urllib3 2.5.0. Publisher = {kind GitHub, repository, workflow, environment}. Predicate `https://docs.pypi.org/attestations/publish/v1`.
- The PEP 740 statement has NO commit SHA. The Fulcio cert extensions carry it: OID .1.13 = commit `aaab4ecc…` for urllib3 2.5.0, .1.14 = refs/tags/2.5.0, .1.9 = workflow@ref, .1.21 = the Actions run URL. Exact commit mapping is therefore possible after cert/signature verification (pypi-attestations or sigstore-python).

## Model runtime (E for listing, H for fit)

- Ollama lists gemma4 e2b/e4b (128K ctx, 6.6–9.5 GB), 12b (256K, ~8 GB), 26b (16–19 GB), 31b (~20 GB). Tools and thinking are supported. (ollama.com/library/gemma4)
- Coordinator measured 24 GiB RAM and no ollama binary. H: e4b or 12b fits; qwen3-coder:30b (~19 GB Q4, third-party figure) is too tight next to a browser and the app. Not benchmarked.

## Real-incident signal: axios March 2026 (E from public sources, partly re-checked)

- StepSecurity (stepsecurity.io/blog/axios-compromised-on-npm-malicious-versions-drop-remote-access-trojan): axios@1.14.1 and 0.30.4 were published manually with a stolen token. 1.14.1 had "no trustedPublisher, no gitHead, no corresponding GitHub commit or tag". The only file differing from 1.14.0 was package.json: it added the dependency `plain-crypto-js ^4.2.1` and removed the `prepare` (husky) script. Live about 2h15m and 2h53m before npm unpublished them.
- Re-checked from the registry (E): axios@1.14.0 has attestations and a gitHead. The 1.14.1 and 0.30.4 version docs are no longer served (unpublished). 0.30.3 has no attestation, so the provenance-regression signal applies to the 1.x line only.
- Product signals (generic, not hardcoded):
  1. Provenance regression: the previous version was attested and this one is not.
  2. Missing source anchor: gitHead is absent or doesn't resolve.
  3. Manifest-only delta: a new dependency or changed lifecycle scripts with no matching change in the source package.json.
- ChainDrop (Aug 2026, ~444 packages per StepSecurity/Harness secondary coverage; Microsoft primary post NOT found): some malicious versions carried VALID SLSA provenance via trusted publishing. Provenance proves which commit was built, not that the commit or its contents were authorized. Byte and semantic comparison is still needed even when provenance verifies.
- Child-reported (TypeScript 7.0.2): registry `repository` says microsoft/TypeScript, but gitHead resolves only in microsoft/typescript-go. repository+gitHead is a candidate mapping that must be resolved and reported, never trusted.

## Status

PAUSED at ~20:35 IST on coordinator instruction (#91962). Children were told to stop and send partials. Full memo not written.

## Child partials received (not yet independently verified by PM unless noted)

- Claude child "UNMASK · Maintainer pain + differentiation": PARTIAL memo at `claude-pain-differentiation.md` (~1,900 words, sources E1–E35).
  - 9 of 10 incidents were artifact-only.
  - ChainDrop keyv@6.0.0 shipped with genuine provenance AND its artifact matched its malicious source, so a byte diff alone misses it. Extra signals are needed: unsigned commit, moved or deleted tag. (Cited Microsoft and Datadog, 4 Aug 2026; PM could not find the Microsoft primary post.)
  - Missing provenance is how nx and PyPI (ultralytics wave 2) noticed.
  - Gap (H): no tool does a per-file explained/unexplained comparison of artifact vs the provenance commit with evidence.
- Codex child "UNMASK · Ecosystem + tooling feasibility" (read-only FS, so no file; its full memo is in its own transcript/final response):
  - Independent re-diff of the scratch samples matches PM's counts: axios 8/92 artifact-only, zod 505/840 vs packages/zod. Source-only file counts: chalk 23, express 204, zod 422, axios 6.
  - Spot check: axios sourcemap sampled utils.js matches source exactly.
  - React 19.3.1 has SLSA v1 provenance. TypeScript 7.0.2 gitHead resolves only in microsoft/typescript-go.
  - OSS Rebuild CLI reads anonymous GCS with embedded verification keys (main.go). Reuse candidates: OSS Rebuild attestations, deps.dev mapping, Sigstore verification.
  - H: Qwen2.5-Coder 7B Q4 (~4.7 GB on Ollama) as the explainer.
  - Top risks: wrong source mapping/monorepo root, generated-output false positives or blanket exemptions, model hallucination/latency.
  - It declined to state an ecosystem-wide mapping percentage from this small sample (correctly).
