# Pinned registry resolution

`unmask scan package[@version-or-tag] [--json]` accepts bare names (`latest`),
exact semver versions, and named dist-tags starting with a letter. Scoped names
are supported. Semver ranges are explicitly unsupported. Mutable tags are
resolved once using bounded public npm metadata, then the exact identity is
displayed and sent to the hosted check. No package is installed or executed.
Exact version inputs go directly to the hosted check without tag resolution.
JSON output includes the requested selector, pinned identity, registry URL and
retrieval time (null for caller-supplied exact versions), plus the hosted report.
The existing report policy exit code is preserved; input/transport errors use 2.

With Node 24.22.2 and the repository's locked dependencies, from the repo root:

```sh
npm ci --ignore-scripts
npm run build
node examples/scan-resolution/run.mjs
```

The checked-in output is the actual output of this command on the feature branch
based on `0ccc70f534c2be0b2749e39ee1977935a4bfd277` (package version 0.1.2).
The input and hosted report are deliberately synthetic public fixtures. The
example invokes the built CLI with an injected HTTP boundary; it never accesses
the network or a model. AI is explicitly unavailable. The empty synthetic
inventory and no-findings result do not establish safety or live service
acceptance. Real provider/model and production routing remain runtime-unverified.

For a live user invocation after release, use `unmask scan lodash@latest`; it
requires registry and configured hosted service access and is not part of this
offline fixture verification. No default report files are created by scan.
