# User journeys

How people use UNMASK, from a first check to a production release. Each journey
has a diagram and the facts that matter to the person taking it. Behavior is
described as it works on 1 November 2026; [user stories](user-stories.md) give
the acceptance criteria and status of each step.

## Who uses UNMASK

```mermaid
flowchart LR
  D([Developer reviewing a dependency update])
  J([Judge or security reviewer])
  O([Operator on the team])
  subgraph UNMASK
    W1(Check a release on the website)
    C1(Check a release with the CLI)
    C2(Check a local tarball offline)
    R(Read the report or download its JSON)
    REL(Release a new version)
    DEP(Deploy that exact release)
  end
  D --- W1
  D --- C1
  J --- C2
  J --- R
  D --- R
  O --- REL
  O --- DEP
```

| Person    | What they want to know                                                    | Where they start              |
| --------- | ------------------------------------------------------------------------- | ----------------------------- |
| Developer | "What is in this published package that is not in its source, and where?" | Website or `unmask check`     |
| Reviewer  | "Is the planted change in this tampered copy found and localized?"        | `unmask check --offline`      |
| Operator  | "Is the deployed service exactly the released, tested build?"             | A version bump merged to main |

No journey ends in a verdict of "safe". Every journey ends with evidence that a
person reviews.

## 1. Check a release on the website

A developer enters an exact `name@version`. The website hands the check to the
analysis API, which fetches both sides, compares them without running anything,
and stores a temporary report.

```mermaid
flowchart TD
  A[Open the website] --> B["Enter name@exact-version"]
  B --> V{Valid npm name and exact version?}
  V -- no --> E1["Explain the problem: tag, range, URL or bad name"]
  V -- yes --> K{Same check already queued, running or done?}
  K -- yes --> J1[Reuse that report, no new admission]
  K -- no --> Q{Admission free? 6 new checks per 10 minutes, 1 running + 1 waiting}
  Q -- no --> E2["Busy: 429 with Retry-After"]
  Q -- yes --> J0["Queued, then running; the page refreshes every 3 seconds"]
  J0 --> F["Fetch the tarball from the npm registry and the source at the claimed full commit"]
  F --> S{Source found and unambiguous?}
  S -- no --> P[Artifact-only report: source comparison unavailable]
  S -- yes --> C[Compare every file, read manifests and syntax cues]
  P --> M
  C --> M{Anything differs and the model is enabled?}
  M -- yes --> G[Advisory model notes with checked quotations]
  M -- no --> N[Model stage skipped and labelled]
  G --> R[Report: identity, coverage, findings, files, evidence, model panel]
  N --> R
  R --> X[The developer reviews the evidence and decides]
```

```mermaid
sequenceDiagram
  actor Dev as Developer
  participant Web as Website
  participant API as Analysis API
  participant Npm as registry.npmjs.org
  participant Gh as codeload.github.com
  participant AI as Google model route
  Dev->>Web: POST /check zod@4.6.7
  Web->>API: POST /check
  API-->>Web: 303 to /r/id
  Web-->>Dev: Status page, queued
  API->>Npm: Version document and tarball
  Npm-->>API: Bytes, integrity, gitHead
  API->>Gh: Source archive at the full commit
  Gh-->>API: Source bytes
  API->>API: Inert parse, compare, cues and policy
  API->>AI: Bounded public excerpts, only if something differs
  AI-->>API: JSON hypotheses with quotations
  API->>API: Keep only hypotheses whose quotations match the bytes
  Dev->>Web: GET /r/id, every 3 seconds
  Web->>API: GET /r/id.json
  API-->>Web: Job status, then the finished report
  Web-->>Dev: Report links: evidence viewer and JSON
```

What the developer should know:

- Only the package name and version are submitted. No upload exists.
- Nothing from the package is installed, built or run.
- A finished report is reused for up to **30 minutes**. It can disappear sooner
  after a restart, so download the JSON to keep it.
- The website shows queued, running, incomplete and failed states. A finished
  check opens in the analyzer's evidence viewer; the website's own viewer shows
  the clearly labelled sample report.

## 2. Check a release with the CLI

The CLI sends the same exact spec to the hosted service, so a developer gets the
same report without any local model key.

```mermaid
flowchart TD
  A["unmask check zod@4.6.7 --out ./report"] --> V{Valid spec and a new output folder?}
  V -- no --> E[Exit 2 with a clear message]
  V -- yes --> P["POST /check to the service; UNMASK_SERVER_URL can override it"]
  P --> W["Poll /r/id.json every 3 seconds, 600 seconds at most"]
  W --> F{Service answered with a completed report?}
  F -- no --> E2[Exit 2. There is no silent local fallback]
  F -- yes --> C[Check the report matches the requested name, version and policy]
  C --> O[Write report.json and escaped report.html]
  O --> X{Exit code}
  X -- 0 --> X0[Completed. Not a claim of safety]
  X -- 3 --> X3[A review rule fired, for example lifecycle-source-absent]
  X -- 2 --> X2[Incomplete. Findings stay in the JSON]
```

- Sent: the package spec only. Not sent: local files, environment values or keys.
- Existing report files are never overwritten.
- `--allow-model` is rejected in hosted mode, because the service owns the model
  policy.

## 3. Check a local tarball offline

A reviewer checks a copy that may have been tampered with. Nothing is fetched;
every input is a local file chosen by the reviewer.

```mermaid
flowchart TD
  A["unmask check --tarball copy.tgz --source-archive source.tgz --commit FULL_SHA --source-root PREFIX --offline --cache-dir CACHE --out OUT"] --> H[Hash the exact input bytes and keep them]
  H --> S{Source package selected?}
  S -- "explicit --source-dir, or one matching manifest" --> C[Compare every file and read cues]
  S -- "ambiguous, e.g. two manifests named axios" --> I[Incomplete: ask for --source-dir]
  C --> M{"--allow-model given and a provider configured?"}
  M -- yes --> G[Send bounded excerpts; keep only checked quotations]
  M -- no --> N[Model not sent, and labelled so]
  G --> R[report.json and report.html]
  N --> R
  I --> R
  R --> X{Exit code}
  X -- 3 --> X3["Review rule fired, e.g. an install script with no source"]
  X -- 2 --> X2[Incomplete, with findings kept]
  X -- 0 --> X0[Completed]
```

- `--offline` makes no network request. Registry integrity shows as unavailable.
- The same inputs always give the same deterministic report.
- Excerpts leave the machine only with `--allow-model`.

## 4. Release and deploy

An operator bumps the version and merges. CI turns that one commit into one
tarball, one image and one running service, and checks they match.

```mermaid
sequenceDiagram
  actor Op as Operator
  participant GH as GitHub Actions
  participant NPM as npm registry
  participant GHCR as Container registry
  participant Run as Google Cloud Run
  Op->>GH: Merge a PR that bumps package.json
  GH->>GH: Refuse if this version or tag already exists
  GH->>GH: Test, build once, npm pack once, record hashes
  GH->>GHCR: Image from that exact tarball, record its digest
  GH->>NPM: Publish the tarball, then re-download and compare bytes
  GH->>GH: Immutable GitHub release with the tarball and manifest
  GH->>Run: New API revision with no traffic
  Run-->>GH: Ready revision and resolved digest
  GH->>Run: Smoke test zod@4.6.7, including the model path
  GH->>Run: Move all traffic to the verified revision
  GH->>Run: Deploy the website the same way
  Op->>Run: GET /version
  Run-->>Op: Version, commit and tarball hash match the release
```

- A failed smoke test after promotion rolls traffic back to the previous verified
  revision when it is safe to do so.
- `/version` is the liveness check, because Cloud Run reserves some paths that end
  in `z`, such as `/healthz`.

## 5. What happens to a check over time

```mermaid
stateDiagram-v2
  [*] --> queued: Admitted
  queued --> running: A slot is free
  queued --> incomplete: Waited more than 300 s
  running --> done: Exit 0 or 3
  running --> incomplete: Exit 2 or the 240 s deadline
  running --> failed: Runner error
  done --> expired: 30 min after completion, eviction or restart
  incomplete --> expired
  failed --> expired
  expired --> [*]
```

A page view never starts or retries a check. Failed and model-unavailable results
are not reused; submitting again starts a new check.

## Removed from scope

**Website upload.** Uploading a tarball to the website was cut on 31 October to
keep the hosted service free of user files. Local copies are checked with the CLI
(journey 3).
