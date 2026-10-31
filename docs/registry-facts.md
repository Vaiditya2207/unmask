# Registry facts

`GET /api/registry/facts?package=example%401.2.3` retrieves public npm metadata for an exact version, without downloading or executing its tarball. Scoped names are URL encoded, for example `?package=%40scope%2Fexample%401.2.3`. Tags, ranges, URLs, duplicate query keys and unknown parameters are rejected.

The response separates `verifiedObservations` (the retrieved document identity matches the requested identity; the SHA-256 covers the retrieved bytes) from `unverifiedClaims` (registry-reported maintainers, publisher name, deprecation, license, engines and repository). `source` records the npm URL, retrieval time, byte count and document SHA-256. Claim pointers refer to that document. These observations do not authenticate the publisher, validate a license or repository, or establish safety. Maintainer names come from the exact-version document as returned now, not an independently verified ownership history. Email addresses and unrelated registry fields are excluded.

Claim statuses distinguish `registry-reported-unverified`, `not-recorded`, `invalid-type` and `omitted-limit`. Missing deprecation does not imply ongoing maintenance. This metadata endpoint runs no AI assessment, source comparison, artifact inspection or advisory analysis; it does not create a completed package check. Use the existing package-details endpoint for manifest inventory from an analyzed artifact.

Requests stay on `https://registry.npmjs.org`, refuse redirects, omit credentials and use a 1 MiB decoded-response limit and a 10 second deadline. Individual claims have an 8 KiB limit and maintainer lists are capped at 100 entries. Each app instance admits at most two concurrent lookups and thirty lookups per minute. These limits are separate from analysis admission. Deployments with multiple instances need their own aggregate admission policy.

Errors return JSON: 400 invalid input, 405 unsupported method, 404 registry release unavailable, 429 admission limit, 502 invalid/unavailable upstream metadata, or 504 deadline exceeded. They never become empty successful metadata. A document larger than the cap remains unavailable. The app's `registryFacts` option supports injected `fetchImpl` and smaller byte, deadline and admission limits for local tests.

See `examples/registry-facts/README.md` for a fully local reproducible fixture. Hosted deployment and live npm behavior remain unverified by these fixture checks. Temporal is not involved.
