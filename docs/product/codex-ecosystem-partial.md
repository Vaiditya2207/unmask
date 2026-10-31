# UNMASK: Codex child partial memo ("UNMASK · Ecosystem + tooling feasibility")

> **Working record, 31 Oct – 1 Nov 2026.** Kept as written during the hackathon, except that private identifiers were removed for publication. Statuses describe the moment of writing; the [product docs index](README.md#then-and-now) shows what shipped since.

> Preserved verbatim by "UNMASK · Product manager" from the child's final answer (Codex gpt-6-astra high, final_answer at 2026-10-31T14:43:08.211Z UTC).
> Source: its provider transcript (a local session file, not published).
> The child's filesystem was read-only, so it could not save this itself. PARTIAL: research stopped on coordinator instruction. Claims are tagged by the child and have not been re-verified by the PM, except where pm-evidence-notes.md overlaps.

---

**VERIFIED — Partial research returned to the parent; stopped as requested.** The summary is queued for delivery. The memo below was **not saved** to `codex-ecosystem-feasibility.md`: this session permits filesystem reads only. Local Workspace logging is also unavailable. No package code was executed.

**VERIFIED — Source mapping evidence**

The following public registry records were inspected; “provenance” means metadata advertises an attestation, not that I cryptographically verified it.

| npm release                                                      | `gitHead`   | Provenance advertised | Source resolution                                                                                                                                                                    |
| ---------------------------------------------------------------- | ----------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [npm 12.2.1](https://registry.npmjs.org/npm/latest)              | `136fc5da…` | No                    | [Commit resolves](https://github.com/npm/cli/commit/136fc5dacc1a2f3d9a051dbf03a4951228144658)                                                                                        |
| [Lodash 4.18.1](https://registry.npmjs.org/lodash/latest)        | `4f0b76e2…` | No                    | [Commit resolves](https://github.com/lodash/lodash/commit/4f0b76e2eca13de1c1fe8b4305abc1f7d63f4b86)                                                                                  |
| [React 19.3.1](https://registry.npmjs.org/react/latest)          | `61aa00df…` | SLSA v1               | [Commit resolves](https://github.com/react/react/commit/61aa00df822d0eb76d0362eb8b6fdd3527693efe); package directory is `packages/react`                                             |
| [TypeScript 7.0.2](https://registry.npmjs.org/typescript/latest) | `2bd066d8…` | No                    | Declared repository returned 404 at this SHA; it [resolves in `microsoft/typescript-go`](https://github.com/microsoft/typescript-go/commit/2bd066d87f5bafd315be9f40889d0a60b9e58e0b) |

**HYPOTHESIS —** Treat `repository` plus `gitHead` as a candidate mapping. Resolve the commit, identify the package directory, and retain the mapping’s evidence level. Do not silently fall back to HEAD or interpret a missing commit as malware. This convenience sample cannot support an ecosystem-wide mapping percentage.

**VERIFIED —** npm provenance binds the artifact to source/build identity, but does not guarantee benign code. npm checks artifact identity/digest, certificate extensions, repository correspondence and signed provenance during publishing. [npm limitations](https://docs.npmjs.com/generating-provenance-statements/), [verification design](https://github.com/npm/provenance).

**VERIFIED —** PyPI’s version JSON provides distribution URLs/digests and project metadata. Metadata need not match uploaded contents. Per-file provenance is available at `/integrity/<project>/<version>/<filename>/provenance`. [JSON API](https://docs.pypi.org/api/json/), [Integrity API](https://docs.pypi.org/api/integrity/).

**VERIFIED —** Both distributions of [pypi-attestations 0.0.30](https://pypi.org/project/pypi-attestations/0.0.30/) display PyPI Publish attestations linking publishing commit `845bfac2f2912912fb2d1ab96775ac75708279c4` and `.github/workflows/release.yml`. This is PyPI-reported verification; I did not independently verify their signatures. The direct Integrity response was unavailable through the web reader’s content-type handling.

**VERIFIED —** The shared `scratch/pypi_prov.json` contains an urllib3 2.5.0 wheel publish statement with `predicate: null`. Its accompanying certificate exposes repository, commit and workflow identity. Thus a parser limited to SLSA predicate fields would miss useful publishing identity. Executed:

```sh
jq '.attestation_bundles[].attestations[].envelope.statement
    | @base64d | fromjson' scratch/pypi_prov.json
openssl x509 -inform der -in scratch/cert.der -noout -text
```

**HYPOTHESIS —** Distinguish publishing commit from proven build inputs. Compare wheel↔sdist and distributions↔repository separately; agreement between wheel and sdist alone cannot establish repository integrity.

**VERIFIED — Artifact comparison results**

Existing public-package snapshots were available under `scratch/`. I independently compared their directories and checked that saved file inventories matched current regular files.

| Local sample  | Published files | Shared, byte-identical | Artifact-only | Source-only |
| ------------- | --------------: | ---------------------: | ------------: | ----------: |
| Chalk 6.0.1   |              12 |                     12 |        0 — 0% |          23 |
| Express 5.3.0 |              10 |                     10 |        0 — 0% |         204 |
| Axios 1.21.0  |              92 |                     84 |      8 — 8.7% |         422 |
| Zod 4.6.7     |             840 |                    335 |   505 — 60.1% |           6 |

**VERIFIED —** Zod was compared against `src/packages/zod`, not the monorepo root. `diff -qr` reported no changed contents at shared paths. Counts used `jq` set differences over `art.txt` and `src.txt`, with `srcsub.txt` for Zod. Representative executed comparison:

```sh
diff -qr \
 scratch/zod/art \
 scratch/zod/src/packages/zod
```

**VERIFIED — Evidence limit:** The parent confirmed registry tarballs and codeload archives at metadata `gitHead` produced these directories. Archives were not retained and their integrity hashes were not checked. These are verified **local snapshot comparisons**, not independently authenticated upstream artifact comparisons.

**VERIFIED —** Axios’s eight added files are under `dist`; its source manifest and Rollup configuration specify those output families. Its two sourcemaps embed 57 and 58 source entries; sampled `lib/utils.js` content exactly matches the source snapshot. Zod’s source manifest declares JavaScript/declaration outputs, and `tsconfig.build.json` sets `outDir: "."`. Chalk and Express manifests restrict published files. These findings explain why raw mismatch percentages vary substantially.

**HYPOTHESIS — Generic classification pipeline:**

1. Preserve exact bytes/hashes; normalize archive prefixes and resolve monorepo package roots.
2. Classify identical, changed, artifact-only and source-only files.
3. Read source-side `files`, entry points, exports, build configuration and sourcemaps as explanatory evidence.
4. Flag artifact-only lifecycle hooks, dependency changes and new executable behavior for review.
5. Treat generated-file classification as an explanation, never a blanket exemption. Sourcemaps can remain unchanged while a bundle is tampered with.
6. Reserve “reproduced” for an isolated rebuild or verified third-party equivalence attestation.

**VERIFIED — Tools UNMASK can reuse**

| Tool                     | Verified capability and integration limit                                                                                                                                                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OSS Rebuild**          | Supports npm, PyPI and crates.io; coverage focuses on popular packages. Public attestations include rebuild instructions and artifact equivalence. [Overview](https://docs.oss-rebuild.dev/), [storage](https://docs.oss-rebuild.dev/storage/) |
| **diffoscope**           | Recursively compares archives and transforms binary formats for inspection. It supplies differences, not a maliciousness verdict. [Project](https://diffoscope.org/)                                                                           |
| **npm audit signatures** | Checks registry signatures and provenance for installed dependencies; documented setup requires installation, so it was not run. [npm documentation](https://docs.npmjs.com/viewing-package-provenance/)                                       |
| **sigstore-js**          | Reusable bundle verification; enforce expected identity/issuer and separately bind the statement subject to inspected bytes. [CLI contract](https://github.com/sigstore/sigstore-js/blob/main/packages/cli/README.md)                          |
| **pypi-attestations**    | Verifies distribution bytes and repository identity against provenance. [Consumption guide](https://docs.pypi.org/attestations/consuming-attestations/)                                                                                        |
| **deps.dev**             | Version API exposes attestation type, verification status and source mappings. [API](https://docs.deps.dev/api/v3/)                                                                                                                            |
| **Socket**               | CLI/API dependency analysis and GitHub PR feedback; many commands require API credentials. [CLI](https://docs.socket.dev/docs/socket-cli), [GitHub App](https://docs.socket.dev/docs/socket-for-github-installation)                           |
| **StepSecurity**         | Offers package analysis, compromised-version controls and registry enforcement. A reusable public source-equivalence API was not verified. [Product](https://www.stepsecurity.io/secure-registry)                                              |

**VERIFIED —** Current OSS Rebuild CLI source uses anonymous GCS access and embedded verification keys by default, despite an older README describing ADC requirements. Equivalence can normalize archive metadata; it is not necessarily compressed-byte identity. [Current CLI source](https://raw.githubusercontent.com/google/oss-rebuild/main/cmd/oss-rebuild/main.go), [equivalence semantics](https://docs.oss-rebuild.dev/builds/ArtifactEquivalence@v0.1/).

**HYPOTHESIS —** Reuse these documented commands after separately authorizing/installing the tooling; neither was executed:

```sh
oss-rebuild get npm lodash 4.17.21 --output=bundle
oss-rebuild get pypi absl-py 2.0.0 --output=bundle
```

**HYPOTHESIS — 12-hour delivery:** Build one CLI analysis core producing JSON, then a local report UI. Support registry releases and organizer-supplied archives through the same pipeline. Show artifact digest, source mapping confidence, classified differences, evidence citations and unresolved checks. Add lockfile-bump analysis as a thin Action wrapper; defer hosted infrastructure.

**VERIFIED —** Dependabot-triggered workflows normally receive restricted tokens and secrets, complicating PR comments. [GitHub documentation](https://docs.github.com/en/code-security/reference/supply-chain-security/troubleshoot-dependabot/dependabot-on-actions).

**HYPOTHESIS —** Start with Action job summaries/artifacts. For monitoring, poll a bounded watchlist, deduplicate package/version/artifact digests, and rerun when new distributions appear—not only when the latest version changes.

**VERIFIED — Open-weight model fit:** Ollama lists Qwen2.5-Coder 7B Q4_K_M at **4.7 GB** and Qwen3-Coder 30B at **19 GB**. Model download size is not total runtime memory. Ollama supports local structured outputs; Together documents an OpenAI-compatible endpoint. [7B model](https://ollama.com/library/qwen2.5-coder:7b), [30B model](https://ollama.com/library/qwen3-coder), [structured outputs](https://docs.ollama.com/capabilities/structured-outputs), [Together compatibility](https://docs.together.ai/docs/inference/openai-compatibility).

**HYPOTHESIS —** Use Qwen2.5-Coder 7B locally for bounded diff explanation and secondary triage. Supply numbered evidence snippets and require structured classifications with evidence IDs and abstention. Validate citations mechanically. Keep deterministic integrity failures authoritative; model output must not erase them. Benchmark actual hardware before promising latency; no inference benchmark was run.

**HYPOTHESIS — Top three engineering risks:** wrong source mapping; misclassifying generated output; model hallucination or latency. Keep **unknown**, **suspicious**, **integrity mismatch**, and **verified equivalence** distinct.
