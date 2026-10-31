# Local package explorer demonstration

The synthetic public fixture in `tests/fixtures/package-explorer.mjs` contains
inert manifest/script/file text, including deliberate terminal control sequences.
It is not a finding about a real npm package. The script starts the real local
HTTP app with that report, then invokes the real CLI for `info` and two `files`
pages bound to the same stored report. It asserts only one submission/analysis
occurred and that both pages retained the report ID.

```sh
npm ci --ignore-scripts
node examples/package-explorer/demo.mjs
```

`sample.txt` is actual captured output from that command; the loopback port and
report ID vary per run. No package code executes, and there are no model, registry
or OSV calls. AI `disabled` and OSV `not-assessed` describe the injected fixture,
not the public deployment. The comparison uses a synthetic source identity and
preserves the report's selected/unverified provenance distinction.

Build and set `UNMASK_TEST_BUILT=1` to run the demonstration against `dist`.

To browse the same stored report instead of requesting another check, copy its
printed report ID and use it on every page:

```sh
unmask files example@1.2.3 --report REPORT_ID --limit 2 --offset 0
unmask files example@1.2.3 --report REPORT_ID --limit 2 --offset 2
```

Keep the same configured service origin, exact version, filters and limit.
Expired/unavailable reports fail explicitly and do not silently submit again.

`file-api-sample.json` is actual output captured from S10's committed
report-exploration contract (`9d3a764`) using the same inert synthetic report and
its real local HTTP handler. It shows the inventory's report-scoped opaque file
ID and recorded evidence returned through `file.json?fileId=...`, with zero POSTs.
It is an API fixture example and does not assert public deployment availability.
