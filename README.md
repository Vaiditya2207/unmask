# UNMASK

See what actually shipped.

UNMASK compares an npm package's published bytes with a selected source archive.
It produces a JSON report and an HTML evidence viewer: matching files, changed
bytes, artifact-only files, uninspected content, and observations to review.
A completed report is not a safety verdict.

Built for **Problem 04: Published Package vs Source Code Integrity Analyzer** at
Hacktoberfest 2026, Hack Day Sonipat. See [HACKATHON.md](HACKATHON.md).

## Status

The local candidate includes an npm CLI, a shared analyzer, a website with a
bounded job queue, and an optional hosted Gemma adapter. It uses plain ESM
JavaScript on Node.js 24.22.2. The intended npm name is `@xagents_in/unmask`;
version `0.1.0` is configured for public npm publication. The default service is
`https://unmask-386156642190.asia-south1.run.app`. Publication, public access and final
model/runtime acceptance must still be verified; this configuration is not a
released-artifact claim.

The analyzer reads package contents as data. It does not install the inspected
package, run its scripts, follow archive links, or reproduce its build.
Source selection is a claim about correspondence, not proof of publisher trust.

## Run locally

Use Node.js 24.22.2, pinned in `.nvmrc`:

```bash
npm ci --ignore-scripts
npm run build
npm test
npm run check
npm run check:package
```

Check an exact public npm version through your configured UNMASK service:

```bash
node dist/cli/main.mjs check chalk@6.0.1 --out /tmp/unmask-chalk-report
```

Choose a fresh output directory for each check. The command writes `report.json`
and `report.html` and refuses to replace existing report files. Public-package
checks send only the exact package spec to the hosted service; the service owns
acquisition and model policy. `UNMASK_SERVER_URL` overrides the default service.
It must be an HTTPS origin, or a loopback HTTP origin for local testing. Hosted
failure never falls back to local acquisition.
See [CLI configuration and data flow](docs/cli.md).

To analyze local archives without network acquisition:

```bash
node dist/cli/main.mjs check --offline --tarball /path/to/package.tgz --source-archive /path/to/source.tar.gz --commit FULL_40_CHARACTER_LOWERCASE_COMMIT_SHA --source-root ARCHIVE_TOP_LEVEL_DIRECTORY --source-dir '' --cache-dir /tmp/unmask-local-cache --out /tmp/unmask-local-report
```

`--source-dir ''` explicitly selects the repository root. For a monorepo, supply
the package's directory relative to that root. Omit all source options for an
artifact-only report. An optional `--claim name@version` checks an explicit
identity claim against the artifact manifest.

Exit codes: `0` means analysis completed; `2` means analysis was incomplete or
input acquisition failed; `3` means a default review-policy finding; `1` means an
internal error. Findings remain visible when incomplete analysis takes priority.
Exit `0` never means a package is safe.

Start the website locally:

```bash
UNMASK_MODEL=off HOST=127.0.0.1 PORT=3000 node dist/server/main.mjs
```

Visit `http://127.0.0.1:3000`. The website accepts exact public npm versions,
queues analysis, and serves the same report format as the CLI. It accepts no
uploads. Its development worker limits and temporary-file cleanup do not
constitute an operating-system security sandbox.

The Next.js frontend in [`web/`](web/README.md) can sit in front of that server.
Start it with `UNMASK_API_URL=http://127.0.0.1:3000`; see its README.

## Inspection limits

- File correspondence uses hashes and bounded byte comparisons. Transpilation,
  minification, sourcemaps and declared output locations do not prove equivalence.
- Syntax cues use a bounded JavaScript parser. TypeScript, JSX, unsupported syntax,
  dynamic behavior and unretained content remain uninspected.
- Literal novelty means only "not found in inspected source". Missing or
  insufficient source cannot establish full-source absence.
- Ambiguous source-package selection is incomplete. For example, multiple
  same-name manifests in Axios source require an explicit local source directory;
  the website currently has no such override.
- This candidate covers npm only. PyPI and continuous release monitoring are
  not implemented.

## Models and releases

Model output is advisory and cannot change deterministic policy findings. The
adapter has recorded-transport tests, but real endpoint availability, account
quotas and usefulness still require validation. Hosted CLI checks follow the
service's published model/data disclosure and never read a local provider key.
Only offline local checks use `--allow-model`; without that flag no local model
client is constructed. The flag alone does not configure an offline provider.
See [HACKATHON.md](HACKATHON.md) for the exact candidate and remaining AI gate.

`npm test` runs product and release-tooling tests, including a packed tarball
installed into a temporary directory and invoked through its real CLI binary.
`npm run check` checks formatting; it is not static type checking. Product tests
and local HTTP checks do not establish deployment readiness.

Release publication is enabled for the `0.1.0` candidate, subject to CI and runtime
release gates. The flow builds an immutable
versioned artifact in CI, then a deployer selects that release separately.
See [release prerequisites](docs/releases.md). npm access is not required for
local builds or testing.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for review, test and comment conventions.
Every remote change after the initial event commit goes through a PR. Repository
permissions and code-owner enforcement must be verified on GitHub; the
CODEOWNERS file alone does not enforce them.

## License

[MIT](LICENSE).
