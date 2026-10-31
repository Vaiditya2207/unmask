# UNMASK delivery priorities and ownership handoff

> **Working record, 31 Oct – 1 Nov 2026.** Kept as written during the hackathon, except that private identifiers were removed for publication. Statuses describe the moment of writing; the [product docs index](README.md#then-and-now) shows what shipped since.

These are product priorities. Engineering lanes, the schedule and the cut order are defined in v27 (`../engineering-proposal-v27.md`) under "Delivery and gates". As relayed by EM, full coding is authorized after these docs, as **local worktree commits only. No new PRs, pushes or deployment** until the user says otherwise. Per the user, there is one owner child each for Server, Web and Package, assigned by EM. PM owns the Fixture QA child; its fixtures are done in `../fixtures/`. Deploy and release effort waits until the packaged CLI passes all 8 variants.

## First vertical slice (P0)

Nothing in this slice is blocked on a user decision.

`unmask check --tarball FILE.tgz --source-archive SOURCE.tgz --commit FULL_SHA --source-root ARCHIVE_ROOT [--source-dir RELATIVE_DIR] --offline --cache-dir CACHE --out OUTPUT` (the implemented local mode, per v23) runs this pipeline. `--source-root` names the archive prefix (for example `axios-<fullSHA>`). For axios, also add `--source-dir ''` to select the repository root, because the source has two manifests named axios. These are separate flags, not alternatives:

1. bounded inert parse
2. exact per-file states
3. three-way manifest comparison (registry part unavailable offline)
4. `report.json`
5. basic `report.html`

**Done means:**

- CLI-1 and CLI-2 acceptance pass on chalk (all identical) and axios (8 artifact-only `dist/` files).
- Exact rule-ID tests pass for `lifecycle-source-absent`, using an offline fixture.

## Priority order after the slice

1. **CLI-3/CLI-4 (A+B):** registry path, codeload at full SHA, monorepo resolution, offline replay.
2. **WEB-1/WEB-3 (C):** the async web flow on a local server using the shared distribution, then **WEB-2** parity on the registry references via the recorded fetcher.
3. **Model client + fixture gate (D).** The gate starts when the key arrives [B]. The client and validator can be built and tested against a stub before then.
4. **REL-1 (E).** Single build, pack once, image from the exact tarball, refusal checks and the manifest, with `registryPublished: false` until npm exists [B].
5. **EVAL-1 (D).** The held-out variants must be frozen by 02:00 at the latest.
6. **WEB-6 + REL-2:** `/version`, and deploy by digest only if authorized [B: DigitalOcean].
7. **Stretch, in order:** transform spike, then the provenance parser, then polish. Website upload has been removed.

## What each lane needs from PM docs

| Lane | Read                                                                                                                                  |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------- |
| A, B | `user-stories.md` CLI-0..7, `../fixtures/MANIFEST.json`, and the PRD principles in `prd.md` §5                                        |
| C    | `user-stories.md` WEB-1..4 and WEB-6, `user-journeys.md` journey 1, `prd.md` §5 wording rules                                         |
| D    | `demo-eval-plan.md`, `user-stories.md` CLI-5/WEB-4/EVAL-1                                                                             |
| E    | `user-stories.md` REL-1/2, `user-journeys.md` journey 4, v27 Release and deployment, `../engineering/STACK-AND-DECISIONS.internal.md` |

## Publication handoff (v27)

The no-new-PR / no-push rule governs at all times, and PR2 never lands automatically. At **05:30 IST**, present the user with the tested local candidate (commit, tests, fixture-run records) and a proposed PR split. The user publishes it, or explicitly authorizes push and PR; merge and deploy are separate. If nothing is authorized by the freeze, nothing is pushed, released or deployed, and the unmet acceptance is disclosed. An artifact release needs both the scope/name answer and push/PR authorization. Absence is never permission. `HACKATHON.md` is updated locally, and reaches the remote only with authorization.

## Rules every lane follows

- Never execute target code.
- Never say "safe".
- Unknown bytes stay visible.
- Model output lives only in `report.model`.
- No arbitrary URLs.
- Internal docs stay out of the repo.
- `HACKATHON.md` lists the known limitation: when a source tree holds more than one manifest with the package's name (e.g. axios root plus docs/), the website reports ambiguous source. The CLI needs an explicit `--source-dir`. A generic name+version tie-break was declined for this release.
- At most one single-line comment per code block (user rule).
- Plain ESM JavaScript only, by user decision. No TypeScript migration or TS tooling for this event.
- `HACKATHON.md` is updated before the freeze with the factual model status, whatever the model outcome. If no model passed, it says the meaningful-AI requirement is unmet.

## Product ambiguities

None of these blocks the first slice.

- **npm package name: ANSWERED.** It is `@xagents_in/unmask`, owned by `xagents_in`, in local config, still `"private": true` at 0.0.0 with no publication (see `decisions-log.md`). The remaining release prerequisite is the 05:30 push/PR authorization. Superseded text: the working package was private `unmask@0.0.0` with no ownership claim, so the first slice was not blocked. **The first artifact release is blocked until the user chooses the scope/name string and intended owner identity, targeted for 03:00 IST. Account creation is not needed.** Without an answer, the demo uses the exact local candidate labelled unreleased, with no release or deploy, and acceptance unmet. The CLI command `unmask` doesn't depend on the package name.
- **Gemini key and budget:** the model client is built against a stub, and the real gate waits for the key and a configured budget.
- **DigitalOcean:** run the same image locally until the project exists and deployment is authorized.
