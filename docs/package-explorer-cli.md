# Package explorer CLI

Run `unmask info example@1.2.3` to submit an exact hosted check and display its
recorded package details. Scoped identities such as `@scope/name@1.2.3` work;
ranges and tags require an exact version first. No output directory is needed.
Set `UNMASK_SERVER_URL` to an HTTPS service origin, or loopback HTTP for tests.
The configured deployment must support the package details endpoint.

The terminal displays artifact manifest metadata, scripts, dependency declarations,
recorded provenance, OSV status/advisories and AI status. Script text is data and
is never executed locally. Publisher declarations do not verify runtime behavior.
The OSV result concerns only the requested package/version at its recorded query
time. Unavailable, incomplete, disabled and missing assessments remain explicit;
no findings never means safe. Upstream projection omissions and terminal row/value
caps are displayed. Terminal control characters and directional controls are
escaped, including untrusted package descriptions, scripts and advisory summaries.

`info` exits 0 after displaying details, 2 for invalid arguments or unavailable or
invalid hosted data, and 1 for unexpected internal errors. This informational
command's successful exit is not an install policy verdict. Use `check` for the
report's deterministic policy exit code. The report URL identifies the underlying
strict report. Reading details itself starts no additional model or OSV query;
the initial hosted check follows the configured server's analysis policy.

The reusable `getHostedDetails(spec, options)` export from `src/cli/hosted.mjs`
accepts the same injected fetch/signal/server/limits options as `checkHosted` and
returns `{ report, details, reportUrl, detailsUrl }`. It submits once, validates the
strict report identity, and fetches the same job's details with the existing
same-origin, redirect, timeout and body bounds. Details add a 4 MiB response cap,
version/identity/digest and basic projection-shape checks. `checkHosted` retains
its existing report-only result contract.

For a reproducible local fixture demonstration, run:

```sh
node --test tests/product/package-info.test.mjs
```

The test starts the real hosted HTTP app with an injected inert report, invokes
the real CLI subprocess and observes its terminal output. It uses no live model,
OSV or registry calls. This validates local source behavior; deployment support
and production model/provider availability remain unverified.

## File inventory

```sh
unmask files example@1.2.3 --path .js --state changed --limit 50 --offset 0
```

`files` uses the same exact hosted flow and exit behavior as `info`. It prints
accepted artifact regular-file paths, byte sizes, comparison states and full
recorded SHA-256 digests. Source digests absent from the report are displayed as
`unavailable`. It never opens or executes a displayed path. Source-only files,
symlinks and other nonregular entries are outside this inventory.

`--path TEXT` is a case-sensitive literal substring, at most 1,024 characters;
it is never a regex or glob. `--state` is `all` (default), `byte-identical`,
`changed`, `artifact-only` or `not-compared`. `--limit` defaults to 50, accepts
1–200, and `--offset` defaults to zero and accepts nonnegative safe integers.
Flags may each appear once. Rows sort by UTF-16 path order, then original path,
and pagination applies after filtering. Pagination is over one job's returned
projection; a later invocation can reflect a newer hosted job.

The terminal shows upstream total/omitted records separately from matching rows
and the current page. Filtering cannot recover upstream omitted records, and zero
matching rows never establishes absence from the complete package. The next offset
is printed when another returned page exists. Each path/value has a 2,048-character
terminal cap with an explicit truncation marker; hashes remain full length. AI
status is retained even for byte-identical output, without inventing an assessment
when the server records it as unavailable or not sent.

Run the local fixtures with:

```sh
node --test tests/product/package-info.test.mjs tests/product/package-files.test.mjs
npm run build
UNMASK_TEST_BUILT=1 node --test tests/product/package-info.test.mjs tests/product/package-files.test.mjs
```

The last command exercises the generated CLI artifact against local HTTP fixtures.
It does not verify the public deployment, model provider or OSV availability.
