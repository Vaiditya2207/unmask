# Website shell

The website shell uses plain ESM JavaScript functions to render forms, status pages and report actions. Backend behavior, hosted availability and model readiness require verification separately from HTML rendering.

## Screens

- `renderHome({value?, error?, retryAfter?})` renders a registry package name and exact version form, associated validation feedback, and an outline of release evidence. URLs, uploads, tags and version ranges are outside the intended input contract.
- `renderStatus(job)` renders queued, running, incomplete and failed screens. Active screens refresh every three seconds; terminal screens give an explicit next step. The caller supplies a validated report ID, package identity and UTC millisecond timestamps.
- `renderError({title?, message?})` renders request errors with a route back to the form.
- `renderCompleted(trustedReportHtml, job)` adds report actions and an analysis timestamp to HTML from a trusted report renderer. The caller supplies trusted report HTML and validated job metadata. Never pass raw package HTML to this helper.

The form and report links use `POST /check`, `GET /r/<id>` and `GET /r/<id>.json`. Admission, queueing and cache retention are server responsibilities.

## Submission and temporary results

The disclosure beside the submit button explains that a check sends the package name and version to our server. The server may send bounded public package and source excerpts to Google for advisory explanations. No API key is needed in the browser. This disclosure adds no upload or consent mechanism.

Eligible completed results may be reused for up to **30 minutes after completion**, subject to capacity eviction or restart. Reads do not extend that lifetime. Identical in-flight checks share work; unavailable model explanations and other retryable failures need a new attempt. A GET reads the stored result rather than starting a retry.

The existing page layout links to the [public source on GitHub](https://github.com/Vaiditya2207/unmask), licensed under MIT.

## Evidence and accessibility

The shell presents evidence for review and never declares a package safe. Model explanations, when available, remain separate from deterministic findings. The shell makes no model availability or quality claim.

Standalone pages include a language, viewport, skip link, labelled input, associated error text, status announcements and visible keyboard-focus styles. The layout adapts to narrow screens and includes a reduced-motion rule. These are source-level accessibility checks; browser and assistive-technology acceptance remain pending.

Dynamic shell text and attributes are HTML-escaped. Standalone pages include a restrictive meta CSP that permits their exact hashed style asset, permits same-origin form submission, and loads no scripts or remote assets. HTTP response headers and browser enforcement require separate verification. Completed action chrome inherits the trusted report document's policy.

## Verification

Use the pinned Node.js 24.22.2 toolchain:

```sh
npm ci --ignore-scripts
npm test
npm run check
npm run check:package
```

The test command includes both tooling and product tests. Shell tests cover hostile input escaping, exact style hashes, error associations, skip targets, refresh behavior and completed action chrome. These tests do not establish backend, analyzer, deployment or visual readiness.
