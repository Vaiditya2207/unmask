# Local package explorer demonstration

The synthetic public fixture in `tests/fixtures/package-explorer.mjs` contains
inert manifest/script/file text, including deliberate terminal control sequences.
It is not a finding about a real npm package. The script starts the real local
HTTP app with that report, then invokes the real CLI for `info` and `files`.

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
