# Evidence export example

These are small, synthetic and inert fixtures, plus the actual outputs that UNMASK produced for them. They illustrate the formats described in [docs/evidence-formats.md](../../docs/evidence-formats.md). The packages are generated locally, contain only constant `module.exports` assignments, and are never executed or installed. The `@unmask-example/*` names are placeholders; they are not published packages.

## Regenerate

Requires Node.js 24.22.2 and the repository dependencies from `npm ci --ignore-scripts`. Run from the repository root:

```sh
node examples/evidence-exports/generate.mjs
# Optional: also write SARIF and annotations with a checkout that contains the sarif/annotations commands.
node examples/evidence-exports/generate.mjs --p08 /path/to/checkout
```

The script:

1. Writes the inputs: inert tarballs (mtime 0, gzip level 9) and synthetic OSV advisory snapshots.
2. Runs the real offline CLI, `node src/cli/main.mjs check --offline ...`.
3. Serves each resulting report through `createApp` on 127.0.0.1 and downloads `/r/<id>.cdx.json` and `/r/<id>.evidence.json` over HTTP.

Two steps keep the output deterministic:

- The server clock is fixed at `2026-11-01T00:00:00.000Z`.
- The random report ID is replaced with `<report-id>` in the saved files. The report ID is not part of any hashed bytes.

Running the script twice produces byte-identical `input/` and `output/` trees with Node.js 24.22.2.

## Cases

| Case       | Input                                                                                                                  | `unmask check` exit | What it shows                                                                                                                         |
| ---------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `matching` | `matching.tgz` with source `matching-source.tgz`, `--commit 0123…4567`, claim `@unmask-example/widget@1.0.0`           | 0                   | Claim matches the artifact manifest; purl is bound; source commit recorded with method `user-full-SHA`                                |
| `conflict` | `conflict.tgz` (declares `@unmask-example/declared@2.0.0`), claim `@unmask-example/requested@1.0.0`, no source archive | 3                   | `identity-claim-conflict`; the SBOM and evidence manifest name the declared identity and assert no purl; no-source limitations appear |

Both artifacts contain a bundled `node_modules/inner` and a nested `node_modules/inner/node_modules/deep`. Only `inner` is a direct root dependency edge in the SBOM.

SARIF and annotations for `conflict` (`output/sarif/`) were generated with `--p08` pointing at commit `9c35ce730a340f10cad3cecb7f23b1c5459e45a7` (branch `feat/automation-outputs-extras`). That commit is not part of this branch. The advisory inputs are synthetic:

| File               | Contents                                                                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `osv-partial.json` | status `incomplete` (reason `page-cap`); one advisory whose only `MAL-` identifier is an alias; one withdrawn `MAL-` advisory; bound to the requested identity |
| `osv-none.json`    | status `none-reported`, bound to the requested identity                                                                                                        |

`output/commands.log` records each command's exit status, plus the HTTP status and content type of each export download.

## Not claimed

These fixtures do not represent a real package, a real advisory or a real source repository. The commit SHA is an arbitrary user-supplied value. No output here is a safety verdict.
