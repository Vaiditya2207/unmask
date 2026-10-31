# Bounded batch checks

```sh
unmask batch lodash@4.17.21 express@5.1.0 --json
printf '%s\n' lodash@4.17.21 express@5.1.0 | unmask batch --stdin
```

Batch accepts up to 25 explicit exact package specs, counting duplicates. Stdin
is read only with `--stdin`, accepts whitespace-separated specs, and is bounded
to 16 KiB and five seconds to EOF. Args and stdin may be combined; each spec is
bounded to 512 characters. Duplicate identities are checked once, preserving
occurrence counts and zero-based input indexes. Ranges, tags, URLs and invalid
names produce visible item errors without a network request for that item.

Checks run serially through the existing hosted client, with a ten-minute total
batch deadline. A rejected submission or report-poll response (including HTTP 429) pauses all remaining submissions without retry, fallback or ignoring the
limit. Completed checks, errors and unsubmitted items remain distinct. A
malformed or identity-mismatched individual report remains an item error and
does not prevent later exact identities from being checked. Cancellation leaves
remaining items explicitly not checked. No target packages are installed or
executed.

JSON contains bounded per-item summaries: status, exact spec, input indexes,
policy exit code, finding count and hosted AI status, or an error. It does not
accumulate full report bodies. Terminal text escapes user input. Any item error
or unsubmitted item makes the aggregate exit 2; otherwise a completed finding
result makes it 3, an incomplete report makes it 2, and all policy-zero reports
make it 0. These are existing deterministic policy outcomes, never safety claims.
No default report files are created.

Reproduce the deliberately synthetic offline example with Node 24.22.2 and the
locked dependencies, from the repository root:

```sh
npm ci --ignore-scripts
npm run build
node examples/batch-checks/run.mjs
node examples/batch-checks/run.mjs --json
```

Both example invocations intentionally exit 2. The checked-in outputs were
produced by the built CLI on this branch, based on
`0ccc70f534c2be0b2749e39ee1977935a4bfd277` (package 0.1.2).
Fixtures contain an empty synthetic inventory, a missing report and an invalid
dist-tag input. The injected HTTP boundary sends no network requests and calls
no model; AI is explicitly unavailable. Production/model runtime acceptance is
unverified. The regression tests additionally exercise a real CLI subprocess
with piped stdin against a loopback HTTP server.
