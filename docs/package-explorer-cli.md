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
