# "Unmask the whole package": PM gap assessment

> **Working record, 31 Oct – 1 Nov 2026.** Kept as written during the hackathon, except that private identifiers were removed for publication. Statuses describe the moment of writing; the [product docs index](README.md#then-and-now) shows what shipped since.

Requested in EM #92881 after the user asked for "more info in the apis, like it should unmask the whole package". Read-only basis: the live hosted report for zod@4.6.7 (`/r/5480c4e9…`, commit 13f5504). No model calls, no network writes and no code changes were made.

## What the report has today

The report is complete as a raw evidence dump: 840 files, about 1,170 evidence items, 1,290 annotations and 24 cues. What it lacks is a **package-level summary** a person can read in under a minute.

| Area               | Present today                                                                                                                                   | Gap                                                                                                                                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity           | `inputs.claim` and the integrity result (match), `provenance: not-assessed`, source method `publisher-gitHead`, with repo, commit and directory | These are scattered across sections. There is no single identity card.                                                                                                                                                       |
| Purpose            | The raw manifest `description`, `keywords` and `homepage`                                                                                       | Not surfaced anywhere. No summary of what the package declares about itself.                                                                                                                                                 |
| Entrypoints        | The raw `main`/`module`/`types`/`exports`/`bin`, plus 355 `declared-output-location` annotations                                                | No resolved list of the files that actually load on `require`/`import`, or of those files' states (identical, changed, artifact-only). This is the highest-value missing view.                                               |
| Dependencies       | The raw dependency maps in three manifests (zod has none); registry-divergence cues                                                             | No direct-dependency summary: no counts, and nothing showing deps added versus source or registry.                                                                                                                           |
| Install hooks      | Raw `scripts`; the lifecycle policy rules and cues                                                                                              | No explicit install-time execution statement. For zod, every script is build or publish time (`prepublishOnly`, `build`…), and none runs at install. The report should say that plainly.                                     |
| File composition   | Per-file states; extension mix (456 ts, 124 each of cjs/cts/js)                                                                                 | No rollup by kind (runtime code, type declarations, docs, binary), by directory or by size. Minified bundles and sourcemaps aren't flagged.                                                                                  |
| Source delta       | Coverage state counts: 335 identical, 505 artifact-only                                                                                         | No grouped explanation, such as "505 artifact-only, of which 355 sit at declared output locations (likely build output, unverified)", and no ranked list of where the unexplained bytes are.                                 |
| Behaviour evidence | Syntax cues for the inspected JS only (248 files / 2.3 MB)                                                                                      | No capability inventory (process, network, env, dynamic eval, filesystem) with counts and locations, split into source-matched and artifact-only. 933 files are syntax-not-inspected (mostly TS), and that isn't summarised. |
| Coverage           | Detailed counters                                                                                                                               | **Bug: `coverage.modelReviewed` is 0 files** even though the model returned 3 hypotheses. There is also no one-line coverage statement.                                                                                      |
| AI                 | 3 hypotheses, 4 evidence groups, 1,171 omitted evidence IDs                                                                                     | The report should say "AI reviewed 4 of N groups; 1,171 evidence items omitted for budget".                                                                                                                                  |

## Recommended first increment (bounded, deterministic, no new model calls)

Add a versioned, deterministic **`report.profile`**, part of the canonical report (so analyzer and schema versions bump), rendered at the top of the viewer and returned by the API and CLI JSON:

1. **identity:** name, version, integrity status, provenance status, selected source (method, repo, commit, directory) or the reason it is unavailable.
2. **declared:** description, license, homepage and keywords, quoted from the manifest as declared, not inferred.
3. **entrypoints:** each `main`/`module`/`exports` leaf and each `bin` entry. For each: the resolved path, whether it exists in the tarball, its correspondence state, and whether its syntax was inspected.
4. **installTimeExecution:** preinstall, install, postinstall and prepare scripts as declared, plus the implicit-gyp check. Alternatively the statement "No install lifecycle scripts are declared in the published manifest".
5. **dependencies:** direct dependency counts by type, and additions or removals versus source and registry. Labelled "direct dependencies only; transitive dependencies not analyzed".
6. **composition:** bytes and files by category (runtime JS, type declarations, docs and metadata, binary, other) and by top-level directory; the largest files; detected minified bundles and sourcemaps.
7. **sourceDelta:** state counts, artifact-only rolled up by directory and by whether the location is declared as output, and the top unexplained paths by bytes.
8. **capabilities:** counts of syntax-cue rules per capability and per state (source-matched or artifact-only), with paths.
9. **coverageStatement:** for example "Compared 840/840 files; 2.3 MB syntax-inspected; 3.0 MB unresolved; AI reviewed 4 groups, 1,171 items omitted". The model-reviewed counters are fixed as part of this.

Everything above is computed from data the pipeline already has, so it fits the time left before the freeze. An AI-written "package overview" can come later as a labelled advisory hypothesis. It is not part of this increment.

## Honest language

- Use "Package profile, built from declared metadata and the observed bytes." Never say "unmasked", "audited" or "safe".
- Say "direct dependencies only; transitive dependencies are not analyzed."
- Say "behaviour evidence comes from static syntax observation of the inspected files; nothing is executed. N files were not inspected."
- Entrypoint and install sections report **what is declared and observed**, not what will happen at runtime.
