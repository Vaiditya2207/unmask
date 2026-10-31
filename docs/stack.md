# Stack and engineering decisions

This page records source contracts and the live snapshot in the [documentation index](README.md). The [architecture](architecture.md) and [contracts](contracts.md) describe the components and observable behavior. Source configuration, a deployed revision and model usefulness are separate evidence.

## Selected stack

| Layer                | Implementation                                                 | Boundary                                                                                           |
| -------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Runtime              | Node.js `24.22.2`, pinned by package engines and `.nvmrc`      | Process and descriptor behavior depend on the exact runtime                                        |
| Backend language     | Plain ESM JavaScript, `.mjs`                                   | No backend TypeScript migration                                                                    |
| Separate website     | Next.js `16.4.2`, React `19.3.1`, TypeScript `6.0.3` in `web/` | Already merged frontend; independent build and service                                             |
| Archive parsing      | `tar-stream` `3.2.2` plus Node gunzip                          | Inert inventory, path checks and application budgets; no extraction or target execution            |
| Syntax parsing       | `acorn` `8.19.0`                                               | Bounded supported JavaScript; unsupported syntax remains unknown                                   |
| API HTTP             | Built-in `node:http`                                           | Registry form, job polling and reports; no uploads or account system                               |
| Process control      | Built-in child processes and Unix-domain leases                | Hosted child lifetime and ownership checks; not a security sandbox                                 |
| Report and policy    | Plain-object validation and deterministic functions            | No general semantic-equivalence engine                                                             |
| Evidence viewer      | Shared escaped HTML plus the separate Next.js interface        | Live schema 1 reports currently link to the original API viewer                                    |
| Advisory model       | Ordered Google Gemini/Gemma route                              | Fixed provider host, bounded evidence, no tools; quality and compliance need separate acceptance   |
| Tests and formatting | `node:test`, strict assertions, Prettier `3.9.10`              | Local checks, live observations and user acceptance are different evidence                         |
| Backend distribution | npm tarball containing `dist`                                  | Public registry metadata lists `@xagents_in/unmask@0.1.0`; install/artifact checks remain separate |
| Hosting              | Separate Cloud Run API and Next.js services                    | Current public origins and serving revisions are recorded in the index                             |

Backend production dependencies are Acorn and tar-stream. Exact-version parsing is implemented locally. Model configuration is shared through `model/config.mjs`, with evidence bundling and citation validation in `model/client.mjs`.

The API image consumes a packed backend artifact and matching lockfile. The deployed Next.js candidate uses its own standalone build and container. This replaces the earlier single-service DigitalOcean proposal; the two surfaces have independent serving identities. Release source, artifact hashes, image digests and routing still need checking for each rollout.

## Resource defaults

These are source-level budgets, not measured production capacity or an OS memory limit. Effective analysis limits are recorded in reports; supported overrides can lower limits.

| Area                           | Default                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Each compressed archive        | 50 MiB                                                                                                  |
| Each expanded archive          | 250 MiB; ratio at most 100                                                                              |
| Each archive inventory         | 20,000 entries; 64 path components; 4,096 path bytes; 40,000 path nodes                                 |
| Archive metadata record        | 64 KiB                                                                                                  |
| Retained regular-file content  | 10 MiB per file; one shared 128 MiB artifact/source budget                                              |
| Archive parse deadline         | 30 seconds                                                                                              |
| Registry metadata capture      | 1 MiB                                                                                                   |
| Acquisition request            | 30 seconds; redirects refused                                                                           |
| JavaScript inspection          | 2 MiB per file; 8 MiB per side; 200,000 tokens; bounded cues and literals                               |
| Hosted worker                  | 512 MiB V8 old-space cap; 120-second deterministic deadline                                             |
| Hosted queue                   | One active and one waiting; 300-second queue TTL; 240-second outer execution deadline                   |
| Hosted admission               | Six new checks per ten minutes in one API process                                                       |
| Result/store                   | 64 MiB result cap; 64 MiB total, 200 entries; up to 30 minutes after completion, without read extension |
| HTTP form body                 | 4,096 bytes; 10-second body deadline                                                                    |
| Model route                    | At most three generation attempts, 45 seconds each, within 135 seconds total                            |
| Model tokens                   | At most 4,000 input tokens; default output cap 4,096 for Gemini and 1,000 for Gemma                     |
| Local model admission defaults | Three generations/minute, 12,000 input tokens/minute, 100 generations/day                               |

The 240-second outer job deadline still applies when the deterministic and model stages share the same job; sub-budgets are not additive guarantees. V8 old-space excludes native allocations, compressed buffers and other process memory. Resident memory and near-limit latency need measurements on the actual host. Explicit offline CLI parsing runs in the CLI process and does not inherit the hosted child settings.

## Model routing, configuration and privacy

The default ordered route on `generativelanguage.googleapis.com` is:

1. `gemini-3.5-flash`, high thinking.
2. `gemini-3-flash-preview`, minimal thinking.
3. `gemma-4-26b-a4b-it`, minimal thinking.

Three is the total generation-attempt budget, not three attempts per tier. Invalid output can retry the same tier. Eligible model-scoped rate limits, transient server errors and timeouts can advance to the next tier; authentication, input and global/daily/unknown quota failures do not authorize blind model shopping. Generation uses temperature zero and one candidate. Each attempt includes bounded tokenizer preflight; preflight is not another generation attempt.

Model use requires explicit `UNMASK_MODEL=on` and configured provider access. The preferred server/offline-consented key is `GEMINI_API_KEY`; `UNMASK_MODEL_KEY` is a compatible alias, and conflicting values are rejected. No API key is needed in a browser or the default hosted CLI path.

Upstream project quota remains **unknown**. The current default local controls are three generations/minute, 12,000 input tokens/minute and 100 generations/day. Local reservations and the singleton persist across jobs but reset on process restart; they are not provider quota verification, a billing guarantee or distributed admission. The factory also supports a separately validated legacy quota configuration. Model output records provider-quota uncertainty, local limits, tier/attempt information, prompt/configuration hashes and omissions.

Registry CLI checks use the hosted API by default without reading a local provider key. Explicit offline local checks require `--allow-model` before the separate provider stage can send selected local excerpts. `--offline` disables acquisition; adding model consent deliberately permits that network stage. Hosted explanation runs in the API main process after deterministic child exit; credentials are not inherited by the child.

## Observed model result and remaining acceptance

The [recorded live zod run](README.md#model-evidence-and-acceptance) completed with three validated Gemini 3.5 Flash hypotheses. Prompt instructions were revised twice on non-fixture zod outputs; this is development evidence. Earlier Gemma generation returned permission denial in the configured project. Successful Gemini generation does not establish successful Gemma generation, useful reasoning, a study result or an independent holdout gate.

Gemini is not open-weight. A configured Gemma fallback does not by itself demonstrate meaningful open-weight use. Hackathon compliance requires separate acceptance with this distinction disclosed.

Original tarball bytes remain authoritative; source claims are not build-origin proof. Correspondence is byte based, and syntax/model observations cannot certify equivalence or package safety. PyPI, release monitoring, general rebuild equivalence and durable distributed state remain outside the implemented scope. The live service observations do not establish capacity, uptime, user validation or cryptographic provenance verification. Public npm metadata is observed separately; an installed release and its artifact identity need their own checks.
