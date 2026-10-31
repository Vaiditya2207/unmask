# Engineering documentation

UNMASK compares the bytes in an npm package with a selected source archive and presents differences as reviewable evidence. It does not certify package safety.

## Implementation and deployment snapshot

The backend is implemented in plain ESM JavaScript on Node.js 24.22.2. The separately merged `web/` frontend uses Next.js and TypeScript; this does not migrate the backend to TypeScript. These pages were checked against source revision `28403be5149b04b5f90fb738b4915786c5f9d2bf`. That source review is distinct from the serving revisions below.

Two separate Cloud Run services were reachable when checked on 1 November 2026 IST:

| Surface                                   | Public origin                                         | Observed `/version`                                        |
| ----------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------- |
| Analysis API and original evidence viewer | <https://unmask-386156642190.asia-south1.run.app>     | `0.1.0`, commit `13f5504e1f6142fcd9a87020b2c3bd02fa7b0f6c` |
| Next.js website                           | <https://unmask-web-386156642190.asia-south1.run.app> | `0.1.0`, commit `4de9ec1194ac144823102be36de0350633a7c27e` |

Both version endpoints returned HTTP 200. The API reported tarball SHA-256 `ed5ff6406947aeb3d17c1883093579d97e33b7fa5333b3b883e28f8efa565a33`. The website's schema-1 handoff links to the API's original report viewer; its sample viewer is a separate presentation. These observations establish this serving snapshot, not future uptime, load capacity or independent image-digest verification.

The public [npm registry metadata](https://registry.npmjs.org/@xagents_in%2Funmask) now lists `@xagents_in/unmask@0.1.0` as `latest`, published at `2026-10-31T20:23:57.900Z` (1 November IST). This supersedes the earlier unpublished snapshot. This documentation check did not install the package or independently match its tarball to a release commit.

## Model evidence and acceptance

The existing public [`zod@4.6.7` report](https://unmask-386156642190.asia-south1.run.app/r/5480c4e9a8231edcb0a4b544c56f3255) returned schema 1 JSON with `model.status: complete`, `gemini-3.5-flash`, high thinking, and three mechanically validated hypotheses. The report recorded one generation attempt and 16,610 ms model latency. Its report-bound hashes are:

```text
promptHash: 82d2862a7e1130aeeb6232c7b10a392b973a8704f5e1d4265773cc5b6330edba
configHash: 169f8b2bccaf95fd8f9ae71ba42f93495299e96fa7f907841e14ea6e1bdae4cb
```

Prompt instructions were revised twice while inspecting non-fixture zod outputs. This is development evidence, not an untouched holdout, usefulness study or completed model-acceptance gate. A valid quotation establishes its location; it does not establish the correctness of the explanation. The Gemini-backed result also does not establish meaningful open-weight use or hackathon compliance; that requires separate acceptance. See [the model disclosure](../HACKATHON.md).

Report URLs are temporary and may expire after 30 minutes, capacity eviction or restart. The identifiers above record the observed run, not a promise that a saved link will remain available.

## Read the implementation

| Page                                              | Contents                                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [Architecture](architecture.md)                   | Hosted CLI and website flows, separate services, process boundaries and job states    |
| [Contracts](contracts.md)                         | Inputs, reports, exit policy, HTTP behavior and distribution boundaries               |
| [Stack and decisions](stack.md)                   | Pinned dependencies, model tiers, budgets and remaining acceptance limits             |
| [CI, releases and manual deployment](releases.md) | Release tooling and artifact/deployment checks; each candidate needs its own evidence |

For setup and contribution rules, see the [project overview](../README.md) and [contribution guide](../CONTRIBUTING.md). These pages document observed behavior and source contracts; documentation checks do not rerun provider evaluation or deployment acceptance.
