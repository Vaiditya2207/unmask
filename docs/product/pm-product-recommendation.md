# UNMASK: product recommendation for the joint plan

> **Working record, 31 Oct – 1 Nov 2026.** Kept as written during the hackathon, except that private identifiers were removed for publication. Statuses describe the moment of writing; the [product docs index](README.md#then-and-now) shows what shipped since.

Prepared 31 Oct 2026, 20:20–20:35 IST, by the independent UNMASK PM (Claude Opus 5.5, tab "UNMASK PM", parent: none). This memo builds on the saved research; it does not redo it. Sources used: `pm-evidence-notes.md`, `claude-pain-differentiation.md`, `codex-ecosystem-partial.md`, `relocation-research-record.json` (early thesis and Grill01 Q1–Q13), plus the checks listed in §0.

Tags: **[E]** = evidence (measured or primary source), **[H]** = hypothesis. **No users were interviewed, so demand is still a hypothesis.** When a source file corresponds to a package file, that does not prove the generated output is equivalent.

## 0. Verification done in this session

1. **axios/zod source-only discrepancy: resolved [E].** I recomputed the counts from `scratch/*/art` and `scratch/*/src` using `find | sort | comm` and `diff -qr`. These read local files only and execute nothing.

   | sample                        | published files | source files | shared, byte-identical | differing | artifact-only | source-only |
   | ----------------------------- | --------------: | -----------: | ---------------------: | --------: | ------------: | ----------: |
   | chalk 6.0.1                   |              12 |           35 |                     12 |         0 |             0 |          23 |
   | express 5.3.0                 |              10 |          214 |                     10 |         0 |             0 |         204 |
   | axios 1.21.0                  |              92 |          506 |                     84 |         0 |             8 |     **422** |
   | zod 4.6.7 (vs `packages/zod`) |             840 |          341 |                    335 |         0 |           505 |       **6** |

   The Codex memo's table is **correct**. The summary in `pm-evidence-notes.md` ("zod 422, axios 6") had the two numbers swapped. Use the table above.

   Limit: these are local snapshot comparisons. When the archives were downloaded, nobody checked their sha512 against `dist.integrity`, so the comparison is not an authenticated upstream one.

2. **ChainDrop primary source: found [E].** Microsoft Security published it on 4 Aug 2026. Its own words: "Many malicious versions had no corresponding source-code commit, pull request, tag, or legitimate release". The worm hit "more than 400 packages". Packages published through trusted publishing "can carry valid provenance". The earlier PM could not find this post; it exists.
3. **keyv@6.0.0: confirmed [E]** (Datadog, 4–5 Aug 2026).
   - Unsigned malicious commits were replayed onto `main` with no recorded PR merge.
   - The `v6.0.0` tag points to the malicious commit and was deleted and recreated repeatedly.
   - The package carries genuine SLSA provenance from `release.yaml`.
   - Datadog calls provenance "neither forged nor a safety verdict".
   - Consequence: in this case the package matches its source, so comparing them **cannot** catch it. That is our honest limit, and the demo should state it.

## 1. The exact pain

When an engineer reviews a dependency bump, nothing answers this question: **"Does this tarball contain anything that isn't in the commit it claims to come from, and if so, why?"**

- The tools they have today answer different questions:
  - Vulnerability databases ask "is it a known bad version?" [E24]
  - Behaviour scanners ask "does it look malicious?" [E14][E23]
  - Provenance answers "where was it built?" npm itself says provenance "does not guarantee the package has no malicious code" [E26].
- In 9 of the 10 incidents we happened to review, the malicious change existed **only in the published package** [E, claude memo §1]. Examples: xz's m4 file, axios 1.14.1 adding `plain-crypto-js` in `package.json` only, Shai-Hulud's `bundle.js`, nx's `postinstall`. This is an anecdotal, non-representative sample. It motivates the problem; it is **not** evidence of how well UNMASK would detect attacks.
- What makes the check painful by hand:
  - **Noise.** axios ships 8 dist bundles with no repo twin. zod has 505 compiled siblings, and comparing it against the wrong monorepo root gives 838/840 "unexplained" [E].
  - **Unreliable source mapping.** The TypeScript 7.0.2 `gitHead` resolves only in a different repository [E]. zod's manifest names no package directory [E].
  - **Mixed signals.** Reviewers have no clean way to keep integrity, provenance, mapping and content evidence apart.

## 2. Primary user

- **For judging: the organizers' evaluation harness.** It feeds real releases (mostly legitimate differences) and tampered copies, possibly as a local tarball plus a claimed name@version and source. This drives every core requirement [E, HACKATHON brief via handoff].
- **For the product story [H]: a security or platform engineer reviewing a Dependabot or Renovate bump PR.** Trigger: one bump PR. Need: one readable verdict with a link and line-level evidence. False-positive tolerance: very low. The research found this persona the most underserved.
- **Secondary [H]: a maintainer checking "was this release mine?" right after publishing.** nx noticed its compromise through missing provenance [E12]. StepSecurity sells this as an enterprise product, for your own packages only [E22].
- **Out of scope:** registry-wide malware hunting. Socket, Aikido and Datadog already do it at scale. We would be competing on their ground.

## 3. Differentiated scope

**Positioning: "Provenance says _where_ it was built. UNMASK shows _what's inside_ and _why each byte is there_."**

UNMASK is a **source-to-artifact reconciliation receipt**, not a malware scanner. For each package it does five things:

_(Aligned with EM engineering-proposal-v1, 31 Oct 2026.)_

1. **Reports each trust anchor separately**, labelled verified, claimed, heuristic or none (Grill Q1). The anchors are registry integrity, provenance, publisher-asserted `gitHead`/repository, and a user-pinned full commit SHA. Per EM v4, core accepts no tag or branch resolution. Parsed provenance is "claimed". **Parsing provenance proves nothing about the signature.** Only actual Sigstore verification can label it "verified".
2. **Resolves the source as a candidate mapping**, with method, confidence and alternatives. Monorepo subdirectory search uses a `package.json` name match. It never silently falls back to HEAD.
3. **Gives every artifact file an exhaustive correspondence state:** byte-identical, changed, artifact-only, or not-compared(reason). Source-only files are listed separately. Coverage counts and bytes use the full artifact inventory as the denominator.
4. **Adds independent, evidence-linked risk cues.** These sit on top of the states and never replace them:
   - manifest, lifecycle, dependency or entrypoint changes with no matching source change
   - added network, process, filesystem/credential or dynamic-execution constructs

   A cue is a reason to review, with its uncertainty stated. It is not proof of maliciousness.

5. **Keeps generated-file explanations as hypotheses.** Sourcemaps, stems, tsconfig and release deltas are mapping hints only.
6. **Uses an open-weight model to write hypotheses in a separate panel.** It returns strict JSON with evidence IDs and quotes, and a validator checks that each quote exists. That proves the location, not the reasoning. The model cannot change states, suppress differences, lower cues, reduce UNEXPLAINED, or say "safe".

How this differs from existing tools [E, claude memo §3]:

- **OSS Rebuild** gives yes/no for popular packages only.
- **diffoscope** shows differences but gives no verdict.
- **Socket, Snyk, Aikido** judge behaviour or match a database, without correlating with source.
- **StepSecurity** covers only your own packages and checks where a release was built, not its contents.

No reviewed tool gives a per-file explained/unexplained reconciliation against the provenance commit **[H — absence in the docs we read, not proven absence]**.

**Rules on what may and may not explain a file (CORRECTED per EM).** The only strong correspondence in core is identical bytes. An earlier draft proposed letting an AST-equal transpile turn a file green. That is withdrawn: AST equality is not semantic proof, and comments, directives, ASI, literals and property order can all matter. A bounded transform stage is **stretch** scope: a pinned trusted tool with fixed options, and only **exact emitted-byte equality** earns `reproduced-with-tool-and-options`. axios shows why the rest stays open: its sourcemap matches the source [E], but that does not prove the bundle matches [H].

## 4. Distribution

| Surface                                                                                                                                                                                                    | Decision                   | Why                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **CLI** `unmask check <name>@<ver>` and `unmask check --tarball FILE --claim name@ver --source https://github.com/OWNER/REPO --commit FULL_SHA [--source-dir PATH]` (EM v4 shape) → versioned JSON receipt | **Core**                   | The organizers' input shapes. Everything else consumes this JSON                                                              |
| **Local viewer** `unmask view receipt.json`: static page, text-only rendering, strict CSP, no remote loads                                                                                                 | **Core (demo surface)**    | Makes the demo visual without a server that handles untrusted archives                                                        |
| **GitHub Action** wrapper: read lockfile diff, run CLI, write job summary + upload receipt artifact                                                                                                        | **Stretch**                | Fits the bump-review persona. Dependabot runs get restricted tokens, so use the job summary, not PR comments [E, GitHub docs] |
| `npx unmask` (publish the CLI to npm)                                                                                                                                                                      | **Stretch, user decision** | Cheap once the CLI exists, but publishing is an external action                                                               |
| Hosted website                                                                                                                                                                                             | **Reject**                 | It would ingest untrusted archives at scale and costs time; no judging benefit                                                |
| Release watch feed (watchlist ≤50, packument ETag polling)                                                                                                                                                 | **Stretch**                | Matches "monitor releases" in the brief, but isn't needed for the demo (Grill Q11)                                            |

## 5. Demo (3 minutes, honest; aligned with EM proposal v1)

No demo result is promised before evaluation. In particular, no "zero suspicious" claim.

1. **Real pinned release with exact-source matches.** Example: chalk 6.0.1 or express 5.3.0. In the local snapshots every published file was byte-identical (12/12 and 10/10 [E]); the real tool must re-fetch and hash-check them. Show the anchors as they actually come out (provenance "claimed" unless verified).
2. **Organizer-style tampered local copy (axios-1.14.1 pattern), generated locally and never published.** This is the main beat. Take the real 1.21.0 tarball and:
   - add an artifact-only dependency
   - drop the `prepare` script
   - inject one `child_process` line into `dist/node/axios.cjs`

   Expected to show, if the build works:
   - the digest mismatch, reported separately from the content findings
   - the manifest change, with exact evidence
   - the injected line, localised as a changed file with a cue
   - a live model hypothesis with validated quotes, or a disclosed replay or failure

   Rerun with the registry unreachable to show the content findings stand without the hash.

3. **A difficult generated bundle left visibly unresolved.** Example: the 8 artifact-only axios `dist/` files [E]. Show the sourcemap hint and the model hypothesis in their own panel, with the files still unresolved.
4. **Source-matching code is not a safety claim.** Show the ChainDrop quote [E] and the keyv limit: when the source itself is compromised, a source-vs-artifact match can't catch it.

## 6. Core vs stretch

**Core (must ship by freeze; aligned with EM proposal v1):**

- npm adapter: registry name@version **and** local `.tgz` + claimed name/version/repository/commit (mandatory)
- safe in-memory archive reader with caps (Grill Q7)
- GitHub codeload source fetch at the exact commit
- monorepo package-root resolution
- exhaustive per-file correspondence states (byte-identical, changed, artifact-only, not-compared)
- full manifest diff and evidence-linked risk cues
- provenance parsed and labelled "claimed", with no signature claim
- versioned report JSON + local viewer
- **meaningful local open-weight model, passing the EM's 5-case gate.** Model-off reports remain usable, but they **fail** the event's meaningful-AI acceptance.
- compact evaluation (§7)

**Stretch, in priority order:**

1. Sigstore verification, turning "claimed" into "verified"
2. Bounded transform stage: pinned tool, exact emitted bytes only
3. Release-to-release context: the previous report adds context, but it never excludes unchanged content from analysis
4. GitHub Action
5. Watch feed
6. Source-side signals (unsigned commit, recreated tag, off-schedule release)
7. PyPI adapter. The PEP 740 commit lives in Fulcio cert OID .1.13 [E]. npm-first is an explicit limitation against the full npm/PyPI problem scope.
8. Verified OSS Rebuild attestations

**Rejected for the hackathon:** executing builds or package code, hosted service, per-package allowlists, any "safe" verdict.

## 7. Held-out evaluation

Compact core, per EM correction (31 Oct):

- **4 dev reference releases**, re-fetched and hash-pinned: plain JS, TS, bundle/minified, monorepo. Example forms: chalk, express, axios, zod.
- **8 synthetic local variants**, each recording the modified paths and spans:
  - lifecycle injection
  - dependency swap
  - added executable
  - tiny logic edit
  - bundle mutation with the sourcemap left unchanged
  - obfuscation
  - benign metadata change
  - benign packaging-only addition

  Payloads are never executed. Archive-rejection fixtures are kept separate.

- **Held-out:** 2 unseen variants on 2 extra reference packages, frozen by a teammate before any tuning. All results are reported, including misses. A broader held-out set is stretch.
- **Oracle:** manually annotated differences. Reference releases are **not** presumed benign. A cue on a real release is scored against the human annotation and is not automatically a false positive. No population detection rate or FPR claim from this convenience sample.
- **Metrics:**
  - localized modification discovery
  - accuracy of high-priority cues against annotations
  - unresolved file and byte share
  - completeness
  - latency
- **Digest mismatch is scored separately** from content localization, so a trivial hash check can't inflate the content results.
- **Model ablation** runs on identical deterministic evidence with the model on and off. It scores explanation usefulness and the unsupported-claim rate. The deterministic states must come out unchanged. The model never reduces UNEXPLAINED.

## 8. Build order

PM concurs with the EM proposal v1 build order.

- Four human-owned streams:
  - A: acquisition, archive and source mapping
  - B: diff, evidence and schema
  - C: viewer and CLI wiring
  - D: model and evaluation fixtures
- Schema first, then one local archive-to-report vertical slice before adding breadth.
- First 45 minutes: model feasibility gate, schema and archive threat fixtures.
- The final 90 minutes before the 06:30 freeze are reserved for fixes, docs, rehearsal and PR/CI review.
- Recompute the available time at approval. Cut stretch work first.

## 9. Decisions that belong to the user

1. ~~Repository URL submission by 20:30 IST.~~ Done: the user confirmed it was submitted.
2. **Model runtime install.** Ollama isn't installed, and nothing has been downloaded or benchmarked. The candidates are gemma4 e4b/12b and Qwen2.5-Coder 7B. Installing and pulling needs the user's go-ahead; the Grill Q13 gate decides which model.
3. **Whether to publish the CLI to npm** (`npx unmask`). This is an external publish.
4. **Team assignment** for the four build lanes in §8.

Everything else is an ordinary design decision that EM/PM can propose for the grill reviewers.

## 10. Risks and unknowns

- Wrong source mapping or monorepo root (mitigation: confidence + alternatives, never silent fallback).
- Noisy unresolved generated output on real releases, the main judging risk. Core leaves it visibly unresolved; the stretch transform stage's coverage is **unmeasured**.
- Model latency, JSON validity, hallucination. Not benchmarked; the gate is required.
- Demand is a hypothesis. No interviews.
- The scratch archives were not hash-bound, so demo inputs must be re-fetched and verified by the real tool.

## 11. Internal-only rule

This memo and every research/planning file stay internal. Keep them out of the public repo. The repo `.gitignore` now guards `internal/`, `research/` and `*.internal.md`. This folder sits outside the repo.
