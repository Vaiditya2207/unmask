# Stack and engineering decisions

This page records the pending implementation inspected at the revision in the
[documentation index](README.md). The main baseline is still a tooling scaffold.
The [architecture](architecture.md) and [contracts](contracts.md) describe how the
components fit together and what callers can rely on once those changes land.

## Selected stack

| Layer                  | Pending implementation choice                                        | Boundary                                                                               |
| ---------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Runtime                | Node.js `24.22.2`, pinned by package engines and `.nvmrc`            | Exact runtime matters for process and descriptor behavior                              |
| Language               | Plain ESM JavaScript, `.mjs`                                         | No TypeScript migration, transpiler or bundler                                         |
| Archive parsing        | `tar-stream` `3.2.2` plus Node gunzip                                | Parser only; application code owns path checks, budgets and inert inventory            |
| Syntax parsing         | `acorn` `8.19.0`                                                     | Bounded supported JavaScript; unsupported syntax remains unknown                       |
| HTTP                   | Built-in `node:http`                                                 | Form submission, status polling and reports; no uploads or account system              |
| Process control        | Built-in child processes and Unix-domain leases                      | Hosted child only; pinned Node listening-descriptor access fails closed if unavailable |
| Report and policy      | Explicit plain-object validation and deterministic functions         | No external schema or semantic-equivalence engine                                      |
| Viewer                 | Shared escaped HTML and trusted static assets                        | Target strings never become executable page markup                                     |
| Model                  | Hosted Google Gemma adapter                                          | Fixed endpoint host; provider access and quality need separate evidence                |
| Tests and formatting   | `node:test`, strict assertions, Prettier `3.9.10`                    | Tooling checks and product checks are different evidence                               |
| Distribution           | One npm tarball containing `dist`                                    | Selected identity `@xagents_in/unmask`; private `0.0.0` remains unpublished            |
| Release/hosting design | GitHub Actions, GHCR and manual DigitalOcean App Platform deployment | Guarded tooling exists; no built image or deployed service is established here         |

The production dependency list in the inspected package contains only Acorn and
tar-stream. Exact-version parsing is implemented locally; there is no `semver`
dependency. Citation validation lives in `model/client.mjs`; configuration is
shared through `model/config.mjs`, without a separate citations module.

## Resource defaults

These are source-level budgets, not measured production capacity or an OS memory
limit. Effective analysis limits are recorded in reports; accepted overrides may
lower supported limits.

| Area                          | Default                                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------------------- |
| Each compressed archive       | 50 MiB                                                                                        |
| Each expanded archive         | 250 MiB; ratio at most 100                                                                    |
| Each archive inventory        | 20,000 entries; 64 path components; 4,096 path bytes; 40,000 path nodes                       |
| Archive metadata record       | 64 KiB                                                                                        |
| Retained regular-file content | 10 MiB per file; one shared 128 MiB budget across artifact and source                         |
| Archive parse deadline        | 30 seconds                                                                                    |
| Registry metadata capture     | 1 MiB                                                                                         |
| Acquisition request deadline  | 30 seconds; redirects refused                                                                 |
| JavaScript inspection         | 2 MiB per file; 8 MiB per side; 200,000 tokens; bounded cues and literals                     |
| Hosted worker                 | 512 MiB V8 old-space cap; 120-second deterministic deadline                                   |
| Hosted queue                  | One active and one waiting; 300-second queue TTL; 240-second execution deadline               |
| Hosted admission              | Six new checks per ten minutes in one server process                                          |
| Report output/store           | 64 MiB result cap; 64 MiB total store, 200 entries, 24-hour TTL                               |
| HTTP form body                | 4,096 bytes; 10-second body deadline                                                          |
| Model                         | At most two 45-second attempts within 90 seconds; at most 4,000 input and 1,000 output tokens |

The V8 cap excludes native allocations, compressed buffers and other process
memory. Overall resident memory and near-limit latency require measurement on
the actual candidate and host. CLI parsing runs in its own process and does not
inherit the hosted runner's child deadline or heap setting.

## Model configuration and privacy

The reviewed adapter supports `gemma-4-26b-a4b-it` and `gemma-4-31b-it` on the fixed
Google endpoint, defaulting to the former. A supported identifier is not proof
of current account availability. There is no selected alternate provider path.
Generation is explicit: temperature zero, one candidate, bounded output, and
minimal thinking configuration. Actual provider behavior remains to be verified.

The shared factory is disabled unless `UNMASK_MODEL=on` and
`UNMASK_MODEL_QUOTA_VERIFIED=true`. Positive integer request-per-minute,
input-tokens-per-minute and daily request limits are mandatory. The preferred
configured key is `GEMINI_API_KEY`; `UNMASK_MODEL_KEY` is an optional compatible
alias, and conflicting values are rejected. Configuration values are private
server/CLI inputs, never browser assets or report fields.

The CLI separately requires `--allow-model`. Hosted explanation runs in the main
process after deterministic child exit. The singleton retains local rate counters
across jobs; those counters reset on process restart and cannot guarantee billing
or replace upstream quotas. Responses disclose model identity, configuration,
prompt hash, attempt counts and omissions when available. Evidence eligibility,
token counting, output validation, failures and skips are visible model states.
Citation checks establish exact supplied text, not the truth of a hypothesis.

## Decisions and remaining limits

- Original tarball bytes remain authoritative. No registry copy silently replaces
  a local input, and source claims never become build-origin proof.
- File correspondence is byte based. Syntax/literal/capability observations can
  prioritize review but cannot clear changes or certify semantic equivalence.
- Model explanation is advisory and failure tolerant. Deterministic policy remains
  separate, with bounded output on every terminal runner branch.
- Hosted work has explicit process lifetime and directory ownership. Live leased
  jobs survive competing startup; unmarked directories are preserved conservatively.
- Build once and package one distribution. The image and deployed routing must
  later be checked against that exact artifact and configuration.
- npm is the implemented ecosystem scope. PyPI, release monitoring, rebuilds,
  general deobfuscation and durable distributed service state are not implemented.

Local source and tests do not establish provider-backed model usefulness,
cryptographic provenance verification, customer validation, registry publication,
container portability, deployed routing, uptime or production capacity. Those
claims require separate, explicit evidence. This documentation adds none of
those runtime or publication claims.
