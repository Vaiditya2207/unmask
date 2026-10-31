# UNMASK user journeys and diagrams

> **Working record, 31 Oct – 1 Nov 2026.** Kept as written during the hackathon, except that private identifiers were removed for publication. Statuses describe the moment of writing; the [product docs index](README.md#then-and-now) shows what shipped since.

All flows are **proposed [P]**; nothing here was implemented when they were drawn.

## Use cases

```mermaid
flowchart LR
  J([Organizer / judge])
  D([Developer])
  O([Operator])
  subgraph UNMASK
    W1(Check package by name - website)
    C1(Check package by name - CLI)
    C2(Check local .tgz - CLI)
    R(Read report / download JSON)
    REL(Release a version via CI)
    DEP(Deploy exact image digest)
  end
  D --- W1
  D --- C1
  J --- C2
  J --- R
  D --- R
  O --- REL
  O --- DEP
```

## Journey 1: developer checks an update on the website (core)

```mermaid
flowchart TD
  A[Open website] --> B[Enter name@version]
  B --> V{Valid npm name and exact version?}
  V -- no --> E1[Show input error]
  V -- yes --> K{Same key cached or in flight?}
  K -- yes --> J1[303 to existing /r/id - no admission used]
  K -- no --> Q{Global admission 6 per 10 min and a free slot, 1 active + 1 waiting?}
  Q -- no --> E2[429 - shared global limit, Retry-After]
  Q -- yes --> J0[303 to /r/id - status queued, then running]
  J0 --> F[Fetch tarball from registry + source from codeload at full SHA]
  F --> S{Source resolved?}
  S -- no --> P[Artifact-only analysis, source comparison unavailable]
  S -- yes --> C[Compare every file + three-way manifest + cues]
  P --> M
  C --> M[Hosted Gemma notes, at most 2 attempts of 45 s, only if model enabled]
  M --> R[Status done - report page: identity, byte-first coverage, rule IDs, files, evidence, model panel]
  R --> X[Developer reviews flagged items and decides]
```

```mermaid
sequenceDiagram
  actor Dev as Developer
  participant Web as Website (shared core)
  participant Npm as registry.npmjs.org
  participant Gh as codeload.github.com
  participant AI as Gemma via Gemini API
  Dev->>Web: POST /check axios@1.21.0
  Web-->>Dev: 303 to /r/id (queued)
  Web->>Npm: version doc + tarball
  Npm-->>Web: bytes, dist.integrity, gitHead
  Web->>Gh: archive at full SHA
  Gh-->>Web: source archive
  Web->>Web: inert parse, compare, cues (no execution)
  Web->>AI: bounded evidence excerpts (public data)
  AI-->>Web: JSON hypotheses with quotes
  Web->>Web: validate quotes, attach to report.model only
  Dev->>Web: GET /r/id (meta-refresh until done)
  Web-->>Dev: report HTML + JSON link
```

## Journey 2: judge checks a tampered local copy with the CLI (core, mandatory)

```mermaid
flowchart TD
  A[unmask check --tarball t.tgz --claim axios@1.21.0 --allow-model] --> H[Hash exact bytes, keep local input]
  H --> I{Online?}
  I -- yes --> L[Registry lookup: digest match/mismatch]
  I -- "no / --offline" --> U[Integrity unavailable]
  L --> S
  U --> S[Select source: user pin, else agreeing gitHead/provenance, else unresolved]
  S --> C[Compare + cues]
  C --> M{Model configured and --allow-model given?}
  M -- yes --> G[Gemma notes]
  M -- no --> N[model: disabled or not-sent - local-input, AI acceptance unmet for this run]
  G --> R[report.json + report.html]
  N --> R
  R --> X{Exit code}
  X -- 2 --> X2[Incomplete, findings still in JSON]
  X -- 3 --> X3[Review required: rule IDs e.g. integrity-mismatch, lifecycle-source-absent]
  X -- 0 --> X0[Report completed, which is not 'safe']
```

## Journey 3: website upload

Removed from scope in v10 (21:30 cut trigger). Local tarballs are checked with the CLI only (Journey 2).

## Journey 4: operator releases and deploys (artifact release core; npm and deploy blocked)

```mermaid
sequenceDiagram
  actor Op as Operator
  participant GH as GitHub (PR + Actions)
  participant GHCR as ghcr.io
  participant NPM as npm registry
  participant DO as DO App Platform dashboard
  Op->>GH: merge PR that bumps package.json version
  GH->>GH: refuse if tag/npm/GHCR version exists or scaffold incomplete
  GH->>GH: tests, build dist once, npm pack once (sha512, sha256)
  GH->>GHCR: image from that exact tarball (npm ci --omit=dev --ignore-scripts), record digest
  GH->>GH: release-manifest.json (registryPublished false) + tag vX.Y.Z + GitHub Release with tarball
  Op-->>NPM: later - owner publishes exact attached tarball with 2FA, then OIDC for next versions
  Op->>DO: when authorized - App Spec editor sets image.digest from manifest, no tag
  DO-->>Op: deployed digest shown
  Op->>DO: open /version
  DO-->>Op: version + commit + tarball sha256 match manifest
```
