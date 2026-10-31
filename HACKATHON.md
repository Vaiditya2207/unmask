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

UNMASK compares published npm package bytes with a selected source archive and presents differences with supporting evidence. Advisory explanations and inspection limits remain visible; the product does not establish whole-package safety or general build equivalence.

## Product AI Model

- **Provider and ordered tiers:** hosted Google API: `gemini-3.5-flash` with high thinking, then `gemini-3-flash-preview` with minimal thinking, then `gemma-4-26b-a4b-it` with minimal thinking. The adapter name does not imply that every run uses Gemma.
- **Bounds:** at most three generation attempts across the route, 45 seconds per attempt and 135 seconds total; at most 4,000 input tokens, with default output caps of 4,096 for Gemini and 1,000 for Gemma. Retries share that budget.
- **Quota status:** upstream quota is unknown. Local defaults are three generations/minute, 12,000 input tokens/minute and 100 generations/day; these are process-local controls, not a provider quota or billing guarantee.
- **Role:** explain bounded package/source evidence as advisory hypotheses, with exact quotations, uncertainty and alternatives. Model output cannot clear differences or change deterministic policy.
- **Observed product result:** the live API at commit `13f5504e1f6142fcd9a87020b2c3bd02fa7b0f6c` returned a complete model section with three validated `gemini-3.5-flash` hypotheses for the public [`zod@4.6.7` report](https://unmask-386156642190.asia-south1.run.app/r/5480c4e9a8231edcb0a4b544c56f3255). The captured run used high thinking, one generation attempt and 16,610 ms model latency. See the [report-bound prompt/configuration hashes](docs/README.md#model-evidence-and-acceptance).
- **Development history and acceptance:** prompt instructions were revised twice after inspecting non-fixture zod outputs. This successful generation is development evidence, not an untouched holdout, human usefulness study or completed meaningful-model gate. Citation validation proves the quoted location, not the reasoning. Earlier Gemma generation was permission-denied; the Gemini result does not establish successful Gemma generation.
- **Open-weight disclosure:** Gemini is not open-weight. A configured Gemma fallback does not by itself establish meaningful open-weight use. Compliance with the hackathon's model requirement needs separate acceptance; the current Gemini-backed result must not be represented as open-weight acceptance.

## Implementation and limitations

The backend uses plain ESM JavaScript on Node.js 24.22.2, with a shared analysis core, CLI, HTTP API and escaped evidence viewer. A separately merged Next.js 16.4.2 / React 19.3.1 frontend uses TypeScript; there was no backend TypeScript migration.

Two separate Cloud Run services are live: the [analysis API](https://unmask-386156642190.asia-south1.run.app) and the [Next.js website](https://unmask-web-386156642190.asia-south1.run.app). The [engineering snapshot](docs/README.md) records the independently observed version endpoints, serving commits and model run. This replaces the earlier combined DigitalOcean hosting proposal. These observations do not establish future uptime, load capacity or acceptance of every code change.

Exact registry CLI checks use the hosted API by default, without a local provider key. Local tarball analysis requires explicit `--offline`; optional model transmission of local evidence additionally requires `--allow-model` consent. The public npm registry now lists `@xagents_in/unmask@0.1.0`; this documentation check observed publication metadata, not an installed CLI release test.

The ecosystem scope is npm. PyPI and continuous release monitoring are not implemented. Source correspondence is byte based, without a claim of general build/transpilation equivalence, maliciousness classification or whole-package safety. Independent usefulness/study and hackathon compliance acceptance remain pending.

## Event

- **Event:** Hacktoberfest 2026 — Hack Day Sonipat
- **Venue:** Newton School of Technology, Rishihood University, Sonipat
- **Start:** 31 October 2026, 6:30 PM IST
- **Final repository freeze:** 1 November 2026, 6:30 AM IST

The initial commit contained only `HACKATHON.md`. Subsequent changes follow the
repository pull-request and CI workflow, following the event guidelines.
