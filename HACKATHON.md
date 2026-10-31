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

- **Planned model:** `gemma4:e4b`
- **Planned runtime:** Ollama, running locally.
- **Role:** Analyze source-to-package differences, propose explanations for
  transformed code, and identify potentially suspicious behavior with references
  to the relevant code.
- **Justification:** Gemma is an open-weight model that can support local
  analysis and perform meaningful reasoning in the product. Programmatic checks
  will validate cited evidence; model explanations alone will not establish that
  a package is safe or malicious.
- **Integration status:** Planned; not yet implemented or validated.

## Event

- **Event:** Hacktoberfest 2026 — Hack Day Sonipat
- **Venue:** Newton School of Technology, Rishihood University, Sonipat
- **Start:** 31 October 2026, 6:30 PM IST
- **Final repository freeze:** 1 November 2026, 6:30 AM IST

This initial commit contains only `HACKATHON.md`. Subsequent changes will be
submitted through pull requests with CI checks, following the event guidelines.
