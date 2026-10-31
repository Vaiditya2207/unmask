# UNMASK — Hacktoberfest 2026

## Team

- **Team name:** Cappybara
- **Members:**
  - Pranay Vishwakarma — Team Leader
  - Vaiditya Tanwar
  - Vishesh Rao
  - Sayan Bhattacharya

## Selected Problem Statement

**Problem 04: Published Package vs Source Code Integrity Analyzer**

UNMASK will compare published packages with their corresponding source
repositories, explain expected packaging differences, and highlight suspicious
modifications with supporting evidence. The initial implementation will target
npm JavaScript packages and report uncertainty when differences cannot be
reliably explained.

## Product AI Model

- **Candidate model:** `gemma-4-26b-a4b-it`. The adapter also recognizes
  `gemma-4-31b-it`; that alternate has not been tested with the configured project.
- **Runtime:** Hosted Google API. Local Ollama execution is not the current plan.
- **Role:** Explain bounded source-to-package evidence as advisory hypotheses,
  with exact quotations, uncertainty and alternative explanations. Model output
  cannot clear deterministic differences or change policy findings.
- **Justification:** Gemma is an open-weight candidate for evidence-based
  explanation. Validating a quotation establishes its location, not the truth of
  the reasoning or whether a package is safe or malicious.
- **Diagnostic status:** A minimal metadata lookup and token-counting request
  succeeded for `gemma-4-26b-a4b-it`. Hosted generation returned HTTP `403`
  `PERMISSION_DENIED` because the configured Google project's free tier is
  unavailable. No generated output was obtained. This diagnostic did not send
  package evidence and is not a product-path or model-quality acceptance test.
- **Acceptance status:** Hosted generation remains blocked and unvalidated.
  Generation configuration, quota behavior, latency and useful reasoning on
  package evidence still require validation. No billing change or alternate-model
  request was made. The meaningful AI objective remains unmet; deterministic
  cues and citation checks alone do not satisfy it.

## Implementation and limitations

The pending implementation uses plain ESM JavaScript on Node.js 24.22.2, with a
shared analysis core, CLI, HTTP website and escaped HTML viewer. The selected
package identity is `@xagents_in/unmask`, still private and unreleased in the
reviewed implementation. Main remains the tooling scaffold at the baseline
specified in the [engineering documentation](docs/README.md); documentation is
not evidence that the product code has landed or been deployed.

The current ecosystem scope is npm. PyPI analysis and continuous release
monitoring are not implemented. Source correspondence is byte based, without a
claim of general build/transpilation equivalence, maliciousness classification
or whole-package safety. Model usefulness has not been validated.

The selected hosting design is one DigitalOcean App Platform service for the
frontend and API together. No deployment has been applied. Public package
publication, a serving image and end-to-end deployment acceptance remain separate
steps.

## Event

- **Event:** Hacktoberfest 2026 — Hack Day Sonipat
- **Venue:** Newton School of Technology, Rishihood University, Sonipat
- **Start:** 31 October 2026, 6:30 PM IST
- **Final repository freeze:** 1 November 2026, 6:30 AM IST

The initial commit contained only `HACKATHON.md`. Subsequent changes follow the
repository pull-request and CI workflow, following the event guidelines.
