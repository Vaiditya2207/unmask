# Package dossier: staged product acceptance

> **Working record, 31 Oct – 1 Nov 2026.** Kept as written during the hackathon, except that private identifiers were removed for publication. Statuses describe the moment of writing; the [product docs index](README.md#then-and-now) shows what shipped since.

This turns the user's ask, "lets make this the last tool you need to check a package" (EM #92891), into a staged checklist without redesigning the product. It builds on `whole-package-gap.md`.

Technical frame, as stated by EM: `GET /r/<id>.details.json` is a **pure projection** of the existing stored report. There is no new analysis, no new provider call, and the old strict schema-1 report and CLI keep working unchanged.

## The one question the dossier answers

**"Can I use this release, and what needs my attention?"** The answer is a prioritized action list where every item carries evidence, plus an explicit list of what was **not assessed**. There is never a holistic safety score, an aggregate percentage or a "safe" label. **Unknown is never shown as zero or as clean.**

## Stage 1: dossier projection (now; deterministic; no new data sources)

Acceptance. Each item must be true on the live zod@4.6.7 and chalk@6.0.1 reports plus one tampered fixture via CLI:

- [ ] **Verdict line:** derived only from the existing policy and cues:
  - "Review required: N items", when any policy finding fires
  - "Review suggested: N items", when there are only cues
  - "Incomplete: \<reason\>", when exit is 2
  - "No findings in what was assessed", otherwise; it is always shown next to the not-assessed list and never on its own
- [ ] **Prioritized actions:** an ordered list of `{priority, what, why, evidenceIds, where (path and byte range)}`. Order: policy findings, then HIGH cues, then MEDIUM cues, then AI `review-concern` hypotheses (labelled "AI suggestion, advisory"), then unresolved bytes. Every item resolves to existing evidence IDs; none is generated without evidence.
- [ ] **Identity card:** name, version, integrity (match / mismatch / unavailable), provenance (`not-assessed` until cryptographically verified), and the selected source (method, repo, commit, directory) or the reason none was selected.
- [ ] **Declared:** description, license string, homepage, quoted verbatim from the manifest.
- [ ] **Entrypoints:** `main`/`module`/`exports` leaves and `bin`. For each: the resolved path, whether it exists, its correspondence state, and whether its syntax was inspected.
- [ ] **Install-time execution:** declared preinstall, install, postinstall and prepare scripts plus implicit gyp, or "No install lifecycle scripts declared in the published manifest". It describes what is declared, not what will run.
- [ ] **Direct dependencies:** counts by type, plus added and removed versus source and registry.
- [ ] **Composition and source delta:** files and bytes by category and top directory; states; artifact-only rolled up by declared-output location; the top unexplained paths by bytes; bundles and sourcemaps flagged.
- [ ] **Capabilities observed:** syntax-cue counts per capability, split into source-matched and artifact-only, with paths, and the count of files **not inspected**.
- [ ] **Coverage line:** files compared, bytes syntax-inspected, bytes unresolved, AI groups reviewed and evidence items omitted. The `coverage.modelReviewed` = 0 bug must be fixed first.
- [ ] **Not-assessed block**, always present, never collapsible to nothing:
  - known vulnerabilities (CVE/advisories), until Stage 2
  - transitive dependencies
  - dynamic or runtime behaviour (nothing is executed)
  - cryptographic provenance verification
  - licence compatibility (the licence string is quoted only)
  - code that matches its source but is itself malicious, as in keyv
- [ ] **Parity:** for the same stored report, `details.json` from the web and from the CLI is byte-identical. The projection is deterministic.
- [ ] **Backward compatibility:** the schema-1 report, the policy exit codes and the existing CLI tests are unchanged.

Out of scope for Stage 1: new acquisition, new model calls, scores and badges.

## Stage 2: the next smallest high-value real scanner integration — OSV known-vulnerability lookup

**Why OSV:** it answers the most-asked question that UNMASK can't answer today ("does this exact release have known advisories?"). It is a single public, read-only, keyless request.

- Primary doc, read 1 Nov 2026: `POST https://api.osv.dev/v1/query` with `{"package":{"name":"<name>","ecosystem":"npm"},"version":"<exact>"}`. No authentication is mentioned; results paginate via `next_page_token`. Source: https://google.github.io/osv.dev/post-v1-query/
- **To verify before claiming:** whether OSV includes malicious-package advisories (`MAL-…` IDs, from the OpenSSF malicious-packages dataset) for npm. That is general knowledge and was not confirmed from the doc page above.

**Contract:**

- The server only; the CLI hosted path gets the result via the report.
- Exact name and version only; the host is allowlisted, with a bounded timeout and response size.
- The result is cached with the report for the same 30-minute TTL.
- The output is listed as **evidence from OSV**: advisory IDs, summary, affected ranges, link, and the query timestamp.

**Honest states:**

- `osv: found(N)`
- `osv: none-reported`, worded as "OSV reports no advisories for this exact version at <time>". Never "no vulnerabilities".
- `osv: unavailable(reason)` when the call failed. This is **never** shown as none-reported.

**Policy:** OSV advisories become prioritized actions in the dossier. They do **not** change the existing deterministic exit codes in this stage; any policy change is a separate decision. It covers the direct package only, with no transitive tree.

**Acceptance:**

- a known-vulnerable public version shows found
- a current clean version shows none-reported with its timestamp
- a network failure shows unavailable
- parity is preserved
- no new secrets are needed

## Stage 3: later, not before the freeze

- Transitive dependency listing from the registry, with OSV per node.
- Cryptographic provenance verification for releases that carry attestations.
- SPDX licence parsing with compatibility notes.
- An AI "package overview" as a labelled advisory section.

Each of these moves an item out of the not-assessed list only when it is actually implemented and tested.

## Wording rules for every stage

- Use "package dossier: what is declared, what we observed, what we did not assess". Never "unmasked", "audited", "safe", "clean" or a score.
- Every "none" names its source and time ("OSV reports none at …", "no install scripts declared"). Absence of evidence is never stated as evidence of absence.
