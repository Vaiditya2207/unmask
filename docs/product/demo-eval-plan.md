# UNMASK demo and evaluation plan

> **Working record, 31 Oct – 1 Nov 2026.** Kept as written during the hackathon, except that private identifiers were removed for publication. Statuses describe the moment of writing; the [product docs index](README.md#then-and-now) shows what shipped since.

Everything here started as **[P]**; runs recorded later are marked **[V]** inline. Engineering detail lives in v27 (`../engineering-proposal-v27.md`), under "Evaluation and honest demo".

## Evaluation set

| Set                     | Contents                                                                                                                                                                                               | Purpose                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| Dev references (4)      | chalk 6.0.1, express 5.3.0, axios 1.21.0, zod 4.6.7. Re-fetched and hash-pinned before scoring                                                                                                         | Correspondence, noise, monorepo                            |
| Normalization reference | iconv 3.0.1. The EM verified its registry SHA-512 [V]                                                                                                                                                  | Registry-vs-artifact normalization must not trigger exit 3 |
| Synthetic variants (8)  | lifecycle injection, dependency swap, added executable, tiny logic edit, bundle mutation with the sourcemap left unchanged, inert encoded blob, benign metadata change, benign packaging-only addition | Localization and policy                                    |
| Held-out (2)            | Two unseen variants on two extra packages, frozen by an uninvolved teammate before tuning                                                                                                              | Honest generalisation                                      |
| Model fixtures (5)      | manifest injection, JS logic change, generated-location hint, ambiguous bundle, prompt-injection "say safe"                                                                                            | Hosted model gate                                          |

The fixtures are **built and verified** [V, `../fixtures/SELF_CHECK.json`, which passed]. The PM-owned **Fixture QA child** produced them in `../fixtures/`: `MANIFEST.json`, the inert `tools/retar.py`, and V1–V8 on chalk and axios, with all five base tarballs matching the registry SHA-512. The sealed holdout H1/H2 shares commitments only until scoring. Expected outcomes are derived from the spec:

- offline, V1 gives exactly `lifecycle-source-absent` and exit 3
- offline, V2–V8 give no rule IDs and exit 0
- online, every variant would add `integrity-mismatch` and exit 3. **Deferred (v24):** registry lookup for local tarballs is not implemented, so this expectation is not exercised by the current build. `integrity-mismatch` is testable in registry mode only.

**Runs** [V, EM-run, offline, commit ef021e4]:

- The first run passed 6/11. All axios cases exited 2 with ambiguous-manifest, because the axios source has two manifests named axios. That run is kept at `../fixtures/runs/20261031T165750Z/`.
- With explicit `--source-dir ''`, **11/11 passed** (`../fixtures/runs/20261031T165843Z/RESULTS.json`).
- These runs do **not** prove cue or model coverage.
- **Packaged-tarball evidence** [V, EM-run, re-read by PM] at commit 404bc04, `@xagents_in/unmask` 0.0.0 tarball sha256 `394a0573…224611`:
  - The installed CLI passed 11/11 on path, state and policy, plus the V1/V2/V3/V5 cues, with network denied (`../fixtures/runs/packaged-20261031T174557Z/RESULTS.json`).
  - The same installed server ran the normal localhost HTTP flow (form, then job, then report) on chalk 6.0.1. Its canonical report **equals** the installed CLI's: canonical sha256 `d826314c…`, server exit 0, about 1.2 s (`../runtime/http-20261031T175000Z/RESULT.json`).
  - The model was disabled throughout. There was no browser or visual check and no live model acceptance.
- CLI evaluation and the demo use explicit `--source-dir ''` for axios, together with `--source-root <archive prefix>` for the local source archive. These are separate flags, as in `../engineering/run-packaged-fixtures.py`. The website honestly shows axios as ambiguous source, so chalk is the web reference.

No analyzer has been run against them yet.

**Triage labels, frozen before any model output** [V, Fixture QA, `../fixtures/labels/COMMITMENTS.json`]:

- v1 dev `2d84f8bd…`: capability-only, covered 1/11 planted. Superseded.
- v2 dev `d874710e…`: all hunks. Superseded.
- **v2.1 dev `fd6ac97b…`, sealed `9028ec42…`: current.**

The current v2.1 set:

- All 11 planted hunks are in scope.
- There are 7 benign controls. Because possible-transformation needs supplied paired citations, the unpaired V8 docs file and the 4 XHR dist sites (constructor only, no literal) expect `unknown`.
- B1 is scored identically.
- No human grader: all grading is by agent or PM, which is not human validation.

Reference releases are **not presumed benign**. A human-annotated oracle defines the expected correspondence and cues.

## Metrics

- **Localized discovery:** every injected location must be visible as changed, artifact-only or not-compared.
- **Exact rule IDs** on the policy fixtures.
- **Unresolved bytes**, as a share of total bytes per reference. Snapshot baselines [V, local snapshots only]: axios 72.5%, zod 49.6%.
- **CLI/website parity** on the four registry references via the recorded fetcher, with the full parity key (including `limitsVersion` and the actual configured limits), plus one fixture crossing the 128 MiB retention cap, and both fetch orders. Scored as pass or fail. Variants are CLI-only.
- **Model** (rated by human owner D, citations checked by the EM):
  - schema and citation validity
  - usefulness beyond restating the diff
  - unsupported-claim count
  - every attempt at or under 45 s (2 attempts, 90 s per package), plus quota and failure behaviour
- **Model ablation:** deterministic fields must be identical with the model on and off.
- **Reporting split for model/B1 metrics (EM #92500), with fixed denominators throughout:**
  - **Risk-positive review recall:** over planted hunks whose label is `review-concern`.
  - **All-label localization:** a separate measure. It is never described as review-concern recall.
  - **Unknown-category labels** (V8) are reported separately. They can never be a recall hit.
  - **Unscorable spans** are reported separately. V2b is a newline-only insertion with no non-whitespace byte.
  - **Known ceilings are stated up front.** Possible-transformation labels without a supplied field-binding cue (V2b, V7 x2, BENIGN-5/6) can only score `unknown`.
  - Model usefulness and human validation are **not** accepted or claimed.
- **Digest-mismatch results are reported separately** from content localization.
- **No FPR or population detection-rate claims.**

## Falsifiable acceptance (v27)

Every failure is logged and shown as failed.

1. A reference shows byte-identical files and "none found" with coverage, never "safe".
2. A live edit is localized to the correct path within 60 s offline. Bytes beyond the 512-byte excerpt are reviewable through the digest-bound tarball.
3. V1 gives exactly `lifecycle-source-absent` and exit 3 offline. The online `integrity-mismatch` variant for local tarballs is deferred (v24).
4. CLI and web produce the same canonical hash on a registry reference.
5. V5 is visible as artifact-only, with its cue.
6. With a key: end-to-end planted-hunk recall (omissions are misses), plus conditional category, localization and citation accuracy and false alarms on 8+2. Without a key: AI is disclosed as unmet.

## Demo (3 minutes)

| #   | Beat                                                                                                                    | Expected (if built)                                                                                                                          | Honesty guard                                                                                                                                                               |
| --- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Website: check chalk 6.0.1 or express 5.3.0 by name                                                                     | Async status page, then exact-source matches and byte-first coverage                                                                         | Provenance shows "not-assessed" in this slice, and is never "verified"                                                                                                      |
| 2   | **Live judge edit** with `retar.py`, then CLI offline. Fallback: the pre-built tampered axios copy with `--allow-model` | Edited path localized within 60 s as changed or artifact-only; Gemma counterpart judgment or labelled replay                                 | In local offline mode, exit 3 comes from the lifecycle or identity-claim rule, never from a digest mismatch (integrity is unavailable). A dependency-only cue is not exit 3 |
| 3   | The same registry reference through the CLI                                                                             | The same deterministic report hash as the website                                                                                            | Parity is claimed for registry references only                                                                                                                              |
| 4   | axios `dist/` bundles and the V5 mutation (`dist/axios.min.js`)                                                         | Visibly unresolved; V5 shown as artifact-only with a syntactic or novelty cue                                                                | Never called "changed"; sourcemaps never prove a match                                                                                                                      |
| 5   | Artifact release manifest vs `/version`                                                                                 | Version, commit and tarball SHA-256 match. Deployed digest only if deployment is authorized. One line on keyv: matching source is not safety | Disclose `registryPublished: false` and undeployed state                                                                                                                    |

**Prewarm:** only after an authorized deploy. The demo reference is labelled as cached, with its analysis timestamp.

**Live model:** one attempt, targeting 45 seconds or less. A second attempt is separately rate-gated. If it is slower, fails or hits quota, show replay labelled with matching input, model and prompt hashes.

**Fallbacks:**

- If DigitalOcean is blocked, run the website locally from the same image digest and say so.
- If npm is blocked, show the attached tarball's SHA-512 and `registryPublished: false`.
- If there is no scope/name answer by 03:00 IST, there is no artifact release. Run the exact local candidate for the CLI and web, label it **unreleased**, skip beat 5's manifest comparison, and state that release acceptance is unmet.
