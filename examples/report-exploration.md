# Stored report file inventory

Run `node examples/report-exploration.mjs` to reproduce the synthetic public
fixture output in `report-exploration.json`. The example makes no network or
model calls. Run `node --test tests/product/report-exploration.test.mjs` for
local HTTP coverage through the normal report submission and retrieval routes.

After submitting an exact package with the hosted form, request
`GET /r/<report-id>/files.json`. The report ID is the existing private 32-character
lowercase hexadecimal ID. Missing or expired reports return 404; queued/running
reports return 202 with Retry-After, and terminal jobs without reports return 409.

Query parameters are `state` (all, changed, added, removed, identical,
not-compared), literal `prefix`, nonnegative integer `offset`, and `limit` (1–100,
default 50). Duplicate/unknown query keys and malformed values return 400.
Follow `nextOffset` until null; output is capped at 128 KiB even when long paths
require extra escaping. Paths outside the strict API identity boundary are
counted in `omittedUnsafePaths`; the original report download remains available.

Added means artifact-only; removed means a recorded source-only path. These are
artifact/source observations, not changes between package releases. Source-only
paths may include nonregular entries; unknown hashes and sizes remain null.
Incomplete coverage does not prove absence or safety. Excerpts are not returned
by the inventory endpoint. Filenames remain data in JSON with HTML-sensitive
characters escaped, attachment disposition, and nosniff.
