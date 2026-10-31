# UNMASK product grill (PM, independent)

> **Working record, 31 Oct – 1 Nov 2026.** Kept as written during the hackathon, except that private identifiers were removed for publication. Statuses describe the moment of writing; the [product docs index](README.md#then-and-now) shows what shipped since.

Started 31 Oct 2026, about 22:10 IST, by UNMASK PM, using the grilling skill. The interviewee is UNMASK EM, through tracked questions. No interviews with real users have taken place; demand remains a hypothesis.

Tags: **[E]** evidence (linked), **[H]** hypothesis.

## Ranked objections (before EM answers)

1. **The AI risks looking decorative.**
   - The deterministic engine makes every decision. The model only writes side-panel notes and may not change anything.
   - Judges scoring "meaningful open-weight AI" may see little that the AI _does_.
   - The ablation currently measures "usefulness", which is a subjective grade. [H]
2. **The hardest variant gets weak localization.** In "bundle mutation with the sourcemap left unchanged":
   - The mutated file is artifact-only. It gets whole-file localization plus a MEDIUM capability cue.
   - That cue sits among many benign capability cues in bundles; axios `dist/` is 72.5% of the package's bytes [E].
   - This is exactly where a judge's tampered copy is most likely to hide. [H]
3. **Our tamper demo is self-authored.**
   - A skeptical judge may assume we tuned the rules to our own variants.
   - The 2-variant holdout helps, but it is small. [H]
4. **The website may starve the core.**
   - The async web shell, release pipeline and DigitalOcean deploy are a large share of the remaining ~8 h.
   - Judges' tampered copies are local files, which the website cannot accept. [E: v13 scope]
5. **Named problem objectives are unmet.** "Monitor releases" and PyPI/extensible adapters both appear in the Problem 04 objective; both are cut to stretch or unmet. [E: handoff objective list]
6. **"Risk assessment" is asked for, but we only emit exit codes and per-cue priorities.** There is no package-level summary a judge can read at a glance. [E: problem statement via handoff]
7. **The differentiation claim needs care.**
   - Socket already flags "manifest confusion": the registry manifest differs from the tarball's `package.json` [E: socket.dev/blog/manifest-confusion].
   - OSS Rebuild rebuilds about 2,048 popular npm packages, with a yes/no answer [E: launch figures via secondary coverage; axios coverage unconfirmed].
   - So our three-way manifest comparison is not novel. Only source-to-artifact per-file evidence on local copies is. [H]
8. **The persona is unvalidated.** "Developer reviewing a bump" would rarely run a separate tool without CI integration, and CI integration is cut. That's acceptable for the hackathon if stated honestly. [H]

## Round 1 questions to EM

These were sent as tracked questions. Each is worded so that "yes" accepts the recommended answer.

❓ **Q1 — Give the model one concrete, scored job.**
The proposed job is triage of capability-bearing hunks in artifact-only JS. For each hunk, the model states whether a counterpart exists in the sourcemap `sourcesContent` or in the source tree, and cites both sides, or says "no counterpart found". The model never changes states or cues. The ablation scores how many injected hunks the model correctly marks "no counterpart" versus benign hunks wrongly marked, across the 8 variants and 2 holdout variants. Those counts can be disproved; a subjective "usefulness" grade can't.
➡️ Yes: adopt this task and metric as the meaningful-AI claim.

❓ **Q2 — Add a deterministic literal-novelty cue.**
For artifact-only JS files, take the string literals (URLs, IPs, module specifiers such as `child_process`, shell commands). Flag each literal that appears nowhere in the selected source tree or the sourcemap `sourcesContent`. Each flag is a MEDIUM cue with an exact span. It is generic, involves no allowlist, and targets objection 2.

- Gate: measure the noise on the 4 references first. Enable the cue only if it stays reviewable (proposal: at most 20 novel literals per reference).
- It never triggers exit 3.
  ➡️ Yes: add it as P0-lite, behind the noise gate.

❓ **Q3 — A judge-chosen live tamper as the main demo beat.**
A judge names a file and an edit in a real tarball. We apply it with an inert repack script, then run the CLI offline. Pass condition: the edited file is reported as changed or artifact-only, at the right path, within 60 s, and all edited bytes stay visible. The pre-built axios tamper is the backup beat.
➡️ Yes: adopt this as beat 2, keeping the pre-built tamper as fallback.

❓ **Q4 — Sequence the website behind the CLI.**
WEB-1..3 start only after the CLI passes localization on all 8 variants plus the exact policy rule IDs. If the CLI isn't green by 02:00, the website shrinks to a local demo shell over the same core, with no release or deploy work. This changes sequencing, not the user's scope.
➡️ Yes: adopt the gate.

❓ **Q5 — Cover the named objectives cheaply.**

- Promote a bounded `unmask watch` to P1: a watchlist of at most 10 packages, polling the packument `time` with ETag, running the same `check` on each new version and writing reports. It reuses the core and is about 1 h of work.
- PyPI stays unmet, but we add an `Adapter` interface plus a document. The acceptance gap is disclosed in `HACKATHON.md`.
  ➡️ Yes. The user decides whether the PyPI gap is acceptable.

❓ **Q6 — Add a package-level review summary.**
The CLI and web header show "Review priority: HIGH / MEDIUM / LOW / none found", with counts per priority and byte coverage. It is explicitly labelled "not a safety rating". This answers "risk assessment" without a score.
➡️ Yes: add it.

❓ **Q7 — Honest differentiation wording.**
The pitch says: "UNMASK compares the published tarball with the claimed source commit file by file, with evidence. It works on local copies and on packages outside OSS Rebuild's coverage." Registry-manifest mismatch is table stakes (Socket has it) and is not claimed as novel.
➡️ Yes: adopt this wording.

❓ **Q8 — Persona honesty.**
The README and pitch state that the dependency-review persona is a hypothesis with no interviews, and that the judged use case is tamper analysis of local copies.
➡️ Yes: adopt this.

## Decisions only the user can make

These are surfaced, not decided.

1. **PyPI and monitoring.** If either stays unmet, the user must accept the gap against the Problem 04 objectives (Q5).
2. **Scope/name string and owner identity**, due by 03:00 IST (v13).
3. **Gemini key and budget, or choosing another open-weight model** such as Kimi or a 70B-class model. One of these is needed before the AI acceptance can be met.

## Round 1 answers from EM (accepted by PM)

- **Q1, edited.** The model gets a concrete counterpart-retrieval job with a fixed ablation. It may say only "no counterpart found **within provided evidence**", never that something is absent from the whole tree. Scoring covers: paired citations, recall of planted hunks, and benign false alarms. The meaningful-AI gate stays unmet until real runs exist.
- **Q2, edited.** The literal-novelty cue is bounded and extracted from the AST. Before any threshold is set, collect the measured distribution on the references. The threshold of 20 is arbitrary, so it is not proof of quality. The pairs get priority:
  - a new network destination with a network call
  - a shell command with a process call

  No exit 3. Constrained to JS, no TS. Roughly 1 h, built in an independent lane.

- **Q3, yes, with an honest contract.** We localize changed or artifact-only bytes. We don't claim that every edit class is malicious or that it triggers policy. The whole edited file stays reviewable; excerpts may truncate, visibly. The pre-built tamper remains the fallback.
- **Q4, no.** The website shell is already committed locally with HTTP tests. The gate applies to **deploy and release effort** instead: those wait until the packaged CLI passes all 8 variants.
- **Status.** The 8 variants and 2 holdout cases are not built yet. Local CLI tests confirm:
  - byte-identical → exit 0
  - lifecycle injection → exit 3
  - malformed archive → exit 2
  - missing selected source → exit 2
  - shared-budget unknowns
  - no execution and no network
- **Q5, no.** Do not promote the watch command. npm-only, no monitoring and no PyPI are documented as unmet named objectives. Whether to change the judged scope is the user's decision. No empty adapter abstraction.
- **Q6, edited.** Labels are "Review required" for deterministic policy findings, "Review suggested" for evidence cues, and "Incomplete", which takes precedence over both when coverage is missing. Counts and coverage are shown, with no HIGH/MEDIUM/LOW package grade.
- **Q7, yes.** Cite the primary competitor pages. Don't put the unverified current figure of 2,048 rebuilt packages in a public claim.
- **Q8, yes.** The persona disclosure must be prominent, not buried.

## Fixture QA child

"UNMASK · Fixture QA (inert 8+2 matrix)" is a Codex gpt-6-astra child, medium effort, launched by PM at EM's request.

- It works only in `../fixtures/`, never touching the repo.
- It builds an inert repack tool, V1–V8 on chalk and axios, and a sealed holdout of 2 cases on other packages.
- Its MANIFEST derives expected outcomes from the v13 spec.
- Deadline 00:30 IST.

## Round 2 (sent as question #92282)

- **Q9.** Deterministic evidence retrieval for the model: a sourcemap window plus the selected source tree, or the top 3 files by rare tokens. The answer is either a paired citation or "no counterpart within provided evidence".
- **Q10.** Six falsifiable demo acceptance criteria. Failures are shown as failed.
- Path defaults confirmed: depth 64, path length 4,096, and 40,000 aggregate path nodes.

## Round 2 answers from EM (#92287, accepted by PM)

- **Q9, edited.** Retrieval is deterministic, but the initial gate uses exact static literal matches from the bounded Acorn AST in the selected source JS, with paired digest-bound excerpts.
  - No VLQ sourcemap joining and no rare-identifier ranking yet. Source maps are optional untrusted hints, if time allows.
  - "No match" means only "not found within the inspected/supplied evidence".
- **Q10, accepted with caveats.**
  - Live-edit bytes may exceed the 512-byte excerpt. Review then goes through the digest-bound tarball and file extraction; full-byte HTML display is not claimed.
  - V5 is artifact-only and is never called "changed".
  - Every failure is logged.
- **Path defaults** confirmed.

## Fixture QA result (#92290)

Fixtures are built and verified in `../fixtures/`; `SELF_CHECK.json` passed. QA flagged a spec contradiction about dependency-cue priority: the prose said "high", the fixed table said MEDIUM. v14 reconciles it: the table governs, so an added runtime dependency is MEDIUM.

## Q11, post-fixture: name+version tie-break (#92317, answered #92343)

**Declined for this release.** EM's reasoning: the tie-break changes source selection and its evaluation while the candidate is stabilizing. It is a reasonable later feature. No package-specific exception will be added.

For this release:

- The CLI takes an explicit source root, and all 11 cases pass with that declared input.
- The website demo uses chalk.
- The axios ambiguity must be visible on the web and listed as a limitation in `HACKATHON.md`.

This is not a user blocker. PM accepts it, since the limitation is disclosed rather than hidden.

## Status

**Frontier empty on both sides.** The changes are consolidated into `../engineering-proposal-v14.md`.

Decisions only the user can make:

1. Accept the unmet named objectives: no PyPI, no monitoring.
2. Choose the scope/name string and owner by 03:00 IST.
3. Provide a Gemini key and budget, or choose another open-weight model.
