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
and pagination applies after filtering. For later pages, reuse the printed report
ID so pagination stays bound to the same hosted job:

```sh
unmask files example@1.2.3 --report <32-character-report-id> --path .js --state changed --limit 50 --offset 50
```

`--report ID` accepts only the recorded 32-character lowercase hexadecimal ID.
It reads that existing job's strict report and details using GET, retaining exact
package identity and artifact-digest validation, without submitting a check or
starting analysis/provider work. The configured origin must be the origin where
the report was created. Expired, missing or invalid reports fail explicitly and
never trigger a new check. Omitting `--report` submits the normal hosted check;
use the printed ID when browsing later pages, particularly when AI is unavailable
or a prior check is incomplete.

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

`getHostedDetailsForReport(spec, reportId, options)` exposes the same read-only
report-bound flow to CLI consumers. It reuses the bounded hosted transport with
an `existingReportId` option; integrations must preserve P01's independent
`optionalDetails` option as well. `info` and `files` continue to require details
by default. Advisory unavailability is never converted to `none-reported`.
Recorded nonempty AI summaries are displayed only for `model.status=complete`;
other statuses remain explicit without a fabricated summary. Zero-width
U+200B–U+200D, U+2060 and U+FEFF are escaped alongside terminal/bidi controls.

## Reuse one analysis while exploring

1. Set `UNMASK_SERVER_URL` to the same hosted origin for the whole session.
2. Run `unmask info NAME@EXACT_VERSION` once. Keep the printed report link; its
   32-character ID is the part after `/r/` and before `.json`.
3. Browse `unmask files NAME@EXACT_VERSION --report REPORT_ID --limit 50`.
4. Use the printed next offset with that same `--report REPORT_ID`, exact spec,
   filters and limit. Page reads use the stored job and start no new analysis.

A report belongs to its original service origin and may expire, be evicted or be
lost after a restart. An unavailable report produces an explicit error. Decide
whether to start a new `info`/`files` check yourself; read-only paging does not
silently do that for you. A successful explorer command means the recorded data
was displayed, and does not authorize installation or imply a safety verdict.

The equivalent existing-report API reads are:

```sh
# Set these from your actual chosen origin and returned report link.
UNMASK_ORIGIN=https://your-unmask-service.example
REPORT_ID=replace_with_the_32_character_report_id
curl --fail-with-body "$UNMASK_ORIGIN/r/$REPORT_ID.json"
curl --fail-with-body "$UNMASK_ORIGIN/r/$REPORT_ID.details.json"
```

These GET requests read an existing job. They do not submit the `/check` form,
perform another model assessment or refresh an OSV lookup. Keep the original
package/version identity and query time when interpreting the returned facts.

## Read recorded file evidence by opaque ID

The report-exploration API identifies files using an opaque `fileId` scoped to
one report. Obtain it from that report's inventory instead of encoding a package
path into a URL. This keeps long or multibyte paths out of the drilldown request.
The existing `files` CLI uses the package-details inventory; its displayed paths
are not file IDs. Use the report-exploration API inventory for opaque IDs:

```sh
curl --fail-with-body --get "$UNMASK_ORIGIN/r/$REPORT_ID/files.json" \
  --data-urlencode 'limit=50' --data-urlencode 'offset=0'

# Copy a returned files[].fileId from the same report.
FILE_ID=replace_with_the_returned_file_id
curl --fail-with-body --get "$UNMASK_ORIGIN/r/$REPORT_ID/file.json" \
  --data-urlencode "fileId=$FILE_ID"
```

The inventory response supplies `nextOffset` for its own subsequent pages; its
server-side page limit and prefix/state filters are a separate API contract from
the package-details CLI's substring filters. File IDs are scoped to their report
and must not be reused with a different report. Unknown or expired reports/files
fail explicitly, pending reports return a pending response, and a terminal job
without a stored report cannot provide file evidence.

Drilldown returns previously recorded evidence only: hashes, comparison state,
byte ranges and bounded excerpts when recorded. It does not read files from the
user's disk, reconstruct omitted text, rerun analysis or establish execution.
Missing excerpts, partial/omitted evidence and incomplete coverage remain explicit.
Package text and excerpts are untrusted data and must be rendered as text.
The endpoint requires the matching report-exploration server deployment; source
and local fixture support alone do not verify a public hosted instance.

With the returned report ID and opaque file ID, use the CLI drilldown:

```sh
unmask file example@1.2.3 --report "$REPORT_ID" --file-id "$FILE_ID"
```

`file` requires an exact package/version and both IDs. It validates the existing
report's package identity with the shared read-only helper, then performs a
same-origin GET to S10's recorded-evidence endpoint. It submits no check, follows
no redirect and sends no provider credentials. The file response is capped at
128 KiB and 32 evidence records; the additional GET has a maximum 15-second
request deadline and honors cancellation. Report/file IDs, metadata hashes and
evidence IDs/digests/ranges are bound to the existing validated report before
anything is displayed. The terminal escapes control, directional and zero-width
characters in paths and excerpts and visibly truncates long text.

Missing, expired or mismatched identities, malformed responses, server errors and
unsupported endpoint deployments fail explicitly with exit 2 and never submit a
replacement check. Success exits 0 as an informational display, matching `info`
and `files`; it is not a guard decision. The report helper may wait for an
existing pending job within its configured timeout, and cannot create a new job.
No package file is opened or executed locally. Source-only/prefixless records
retain their available metadata; missing hashes or excerpts remain unavailable.

Reproduce the recorded S10 contract fixture and failure-boundary checks with:

```sh
node --test tests/product/package-file.test.mjs
npm run build
UNMASK_TEST_BUILT=1 node --test tests/product/package-file.test.mjs
```

These tests use S10's captured inert fixture contract, not a live hosted provider.
A deployable combined candidate must include S10's opaque-ID server routes and
receive its own normal-route runtime verification after integration.
