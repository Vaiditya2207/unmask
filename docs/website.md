# Website foundation

This initial slice contains plain ESM JavaScript functions that render the website shell. Backend and analyzer integration are pending. The form and report links describe the intended HTTP contract; this change does not start a server, validate registry input, run a check or generate analysis results.

## Screens

- `renderHome({value?, error?, retryAfter?})` renders a registry package name and exact version form, associated validation feedback, and an outline of release evidence. URLs, uploads, tags and version ranges are outside the intended input contract.
- `renderStatus(job)` renders queued, running, incomplete and failed screens. Active screens refresh every three seconds; terminal screens give an explicit next step. The caller supplies a validated report ID, package identity and UTC millisecond timestamps.
- `renderError({title?, message?})` renders request errors with a route back to the form.
- `renderCompleted(trustedReportHtml, job)` adds report actions and an analysis timestamp to HTML from a trusted report renderer. The report renderer and generated JSON are pending integration. Never pass raw package HTML to this helper.

The intended routes are `POST /check`, `GET /r/<id>` and `GET /r/<id>.json`. No route handlers are included here. Shared admission and temporary report-retention notices are copy for the planned backend behavior; enforcement belongs to the later server integration.

## Evidence and accessibility

The shell presents evidence for review and never declares a package safe. Model explanations remain a separate planned section; this slice uses no models and contains no fabricated analysis.

Standalone pages include a language, viewport, skip link, labelled input, associated error text, status announcements and visible keyboard-focus styles. The layout adapts to narrow screens and includes a reduced-motion rule. These are source-level accessibility checks; browser and assistive-technology acceptance remain pending.

Dynamic shell text and attributes are HTML-escaped. Standalone pages include a restrictive meta CSP that permits their exact hashed style asset, permits same-origin form submission, and loads no scripts or remote assets. HTTP response headers and browser enforcement checks belong to the pending server integration. Completed action chrome inherits the trusted report document's policy.

## Verification

Use the pinned Node.js 24.22.2 toolchain:

```sh
npm ci --ignore-scripts
npm test
npm run check
npm run check:package
```

The test command includes both tooling and product tests. Shell tests cover hostile input escaping, exact style hashes, error associations, skip targets, refresh behavior and completed action chrome. These tests do not establish backend, analyzer, deployment or visual readiness.
