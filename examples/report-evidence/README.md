# Recorded file evidence drilldown

This deliberately modified public-domain fixture compares synthetic JavaScript
text without executing it. No real npm package, archive acquisition, model call,
or artifact verification is claimed. Archive digests identify synthetic labels;
file hashes and evidence spans come from the actual comparison engine.

Prerequisites: Node.js 24.22.2 and dependencies from `npm ci --ignore-scripts`. Package version: 0.1.2. Base source revision:
0ccc70f534c2be0b2749e39ee1977935a4bfd277 plus the report-exploration feature stack.
No model/runtime configuration changes are made by this feature.

From the repository root, reproduce the committed output with:

```sh
node examples/report-evidence/run.mjs | ./node_modules/.bin/prettier --parser json > examples/report-evidence/output/result.json
node --test tests/product/report-exploration.test.mjs
```

The reachable hosted route is `GET /r/<report-id>/file.json?path=index.js`.
Encode the path once with URLSearchParams or encodeURIComponent. A prefixless
artifact is selected with `originalPath` instead of `path`; exactly one key is
required, and originalPath selects prefixless artifacts only. Unknown files
return 404, invalid or ambiguous query identities return 400. The route shares
inventory report lifecycle statuses (202, 404, 409) and never starts analysis.

Results include comparison state, recorded hashes and only evidence bound to the
selected path, file digest and report input digest. Invalid evidence is counted
and omitted; invalid excerpt ranges withhold the text. Missing excerpts remain
unavailable, including most source-only paths. No arbitrary filesystem reads or
content reconstruction occur. At most 32 evidence records and 2 KiB of UTF-8 text
per excerpt are returned within a 128 KiB serialized response. Range fields
identify both returned and originally recorded excerpts. Omission counts expose
truncation. Render parsed excerpt strings as plain text. The HTTP JSON response
escapes HTML-sensitive characters and uses attachment disposition and nosniff.

## Short selectors for hosted inventory rows

Hosted inventory rows expose an opaque `fileId`, bound to the stored report ID
and exact recorded file identity. Prefer
`GET /r/<report-id>/file.json?fileId=<fileId>` after selecting an inventory row.
IDs have the form `f-` followed by 43 base64url characters. They are stable within
the stored report, are not portable to another report, and confer no new access
outside that report's existing route. Unknown or cross-report IDs return 404.
Malformed IDs return 400. Supply exactly one of `fileId`, `path`, or
`originalPath`; mixed/duplicate selectors and unknown query keys return 400.

The ID route returns the same stored evidence and never starts analysis. It
handles long escaped filenames whose path-based URL would exceed the unchanged
HTTP header limit. The standalone example omits hosted report context and keeps
its existing path-only output. Pure core callers may supply a third context
argument `{ reportId: "<32 lowercase hex characters>" }` to inventory or evidence
helpers to generate/resolve the hosted IDs. Never derive an ID from a displayed
path in a client: use the inventory's opaque value for that report.
