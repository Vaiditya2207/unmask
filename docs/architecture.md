# Architecture

This page describes the implemented process boundaries and the two-service deployment recorded in the [documentation status](README.md). The [contracts](contracts.md) define observable behavior; the [stack](stack.md) records model tiers, implementation choices and limits. A live snapshot does not establish every acceptance gate.

## Purpose and trust boundaries

UNMASK inventories a package tarball, selects a disclosed source reference,
compares regular-file bytes, and renders evidence for human review. An integrity
match, a source claim, byte correspondence, syntax cues and model hypotheses are
separate facts. None establishes that the whole package is safe.
The intended dependency-review persona is a hypothesis; it has not been validated
with users.

```mermaid
flowchart LR
  Engineer[Dependency reviewer] --> CLI[CLI]
  Visitor[Website visitor] --> Web[Next.js Cloud Run service]
  CLI -->|Registry default| API[Analysis API Cloud Run service]
  Web --> API
  CLI -->|Explicit offline input| Offline[Local pipeline]
  API --> Runner[Queued hosted analysis]
  Runner --> Core[Shared analysis core]
  Offline --> Core
  Core --> Registry[Public npm registry, hosted acquisition only]
  Core --> Source[GitHub archive at full SHA, hosted acquisition only]
  Core --> Report[Versioned JSON evidence]
  Report --> Viewer[Original escaped evidence viewer]
  Report --> Model[Optional Google model route]
  Model --> Advisory[Separate advisory hypotheses]
  Advisory --> Viewer
```

Registry acquisition uses fixed approved HTTPS hosts and refuses redirects.
Offline CLI analysis reads only operator-selected local inputs. Archive contents,
filenames, manifests, source assertions and model output are untrusted data.
Target code, configuration, install hooks and build scripts are never executed.
Archive links are inventoried without following their targets. Process isolation
and resource limits reduce failure impact; they are not a security sandbox.

## User flows

An exact registry CLI check uses the hosted API by default: submit the name/version, poll its random report location, validate the returned report and deterministic policy, then write escaped HTML and JSON locally. The caller needs no local provider key. The client does not silently switch to local acquisition when the service fails.

A local tarball check requires `--offline`; an optional local source archive needs a full commit claim and explicit archive root. This path runs the shared pipeline inside the CLI process, without the hosted queue or worker. Optional model transmission requires separate `--allow-model` consent and local provider configuration. Offline disables acquisition, while that consent deliberately enables the advisory network stage.

A website visitor submits an exact `name@version` to the separate Next.js service, which proxies the API. The API returns a private report location, and subsequent GETs read status or results. The current Next frontend links schema 1 reports to the API's original viewer rather than treating its demonstration report shape as the live schema. Neither website nor API accepts tarball uploads or arbitrary source URLs.

The API's in-memory results last up to 30 minutes after completion, subject to capacity eviction or restart; reads do not extend the lifetime. Anyone holding a report's random URL can read it. There is no account or durable report service. Browser and hosted CLI submissions can lead the API to send bounded public package/source excerpts to Google; model availability is not guaranteed.

Model use is optional and cannot change deterministic findings. Hosted configuration explicitly enables provider access and enforces local admission controls while reporting upstream quota as unknown. Missing configuration or eligible evidence leaves an explicit disabled/skipped/unavailable state. Hosted CLI users do not supply `--allow-model`; that flag belongs to offline local evidence.

## Components and process boundaries

```mermaid
flowchart TB
  subgraph Website[Next.js service]
    Web[web/app routes and server components]
  end
  subgraph CLIProcess[CLI process]
    CLI[cli/main.mjs] --> Hosted[cli/hosted.mjs]
    CLI -->|Explicit offline| Local[core/pipeline.mjs]
    Local --> CLIModel[Optional consented model stage]
  end
  subgraph MainProcess[API main process]
    HTTP[server/main.mjs and app.mjs] --> Queue[queue.mjs]
    Queue --> Runner[runner.mjs]
    Runner --> ParentModel[Singleton model client after child exit]
    Queue --> Store[store.mjs]
    Store --> Render[viewer/render.mjs and shell.mjs]
  end
  subgraph ChildProcess[Hosted deterministic child]
    Worker[server/worker.mjs] --> Online[core/online.mjs]
    Online --> Pipeline[core/pipeline.mjs]
    Pipeline --> Archive[archive.mjs and source.mjs]
    Archive --> Compare[compare.mjs]
    Compare --> Inspect[syntax.mjs and manifests.mjs]
    Inspect --> Policy[policy.mjs and report.mjs]
  end
  Web --> HTTP
  Hosted --> HTTP
  Runner --> Worker
  Worker --> Result[Bounded report.json]
  Result --> Runner
  CLIModel --> Config[model/config.mjs and client.mjs]
  ParentModel --> Config
```

`core/acquire.mjs` fetches bounded registry metadata and archives;
`core/resolve.mjs` interprets source claims. Hosted registry orchestration calls the same local pipeline after capturing input bytes. Explicit offline CLI analysis can preserve digest-addressed copies in its cache directory. Hosted CLI checks do not use that local cache. API jobs disable duplicate blob persistence and keep captured inputs only in the private per-job directory.

The hosted runner creates a trusted Node child with a 512 MiB V8 old-space limit,
minimal environment and deterministic deadline. The child writes a report
exclusively. After child exit, the parent bounds and validates it, then optionally
calls its long-lived model client. Provider credentials stay in the main process;
they are not inherited by the deterministic child.

Job directories have random names and kernel-held ownership leases inherited by
the worker. Startup preserves live jobs, including a worker whose parent has
crashed, and can remove abandoned leased jobs after worker exit. Unmarked legacy
directories are preserved when ownership cannot be established. Normal cleanup
runs after child exit on success, failure, cancellation and timeout.

## Data objects

The diagram shows relationships between **plain objects**, not runtime classes or
an inheritance framework. Functions validate and transform these records.

```mermaid
classDiagram
  class InputSet {
    artifactDigests
    sourceArchiveDigests
    registryDocumentDigests
    claim
    effectiveLimits
  }
  class ArchiveInventory {
    digest
    complete
    totals
    failures
  }
  class Entry {
    path
    originalPath
    type
    size
    sha256
    inspection
  }
  class SourceSelection {
    status
    method
    commit
    directory
    alternatives
  }
  class FileComparison {
    state
    reason
    localization
  }
  class Evidence {
    id
    blobDigest
    side
    path
    range
  }
  class Report {
    schemaVersion
    coverage
    cues
    annotations
    failures
    run
  }
  class PolicyResult {
    exitCode
    findings
  }
  class ModelSection {
    status
    modelId
    promptHash
    hypotheses
  }
  InputSet --> ArchiveInventory
  ArchiveInventory "1" *-- "many" Entry
  SourceSelection --> ArchiveInventory
  Entry --> FileComparison
  FileComparison --> Evidence
  Report *-- InputSet
  Report *-- SourceSelection
  Report *-- FileComparison
  Report *-- PolicyResult
  Report *-- ModelSection
  PolicyResult --> Evidence
  ModelSection --> Evidence
```

Input hashes bind original compressed bytes. Evidence IDs bind a side, blob,
path and half-open byte range. Public report JSON contains text evidence and
metadata, not raw Buffer objects. Coverage distinguishes inventoried bytes,
source correspondence, syntax inspection and model review.

## CLI sequence

```mermaid
sequenceDiagram
  actor Reviewer
  participant CLI
  participant API
  participant Core
  participant Model
  participant Viewer
  Reviewer->>CLI: Exact registry spec or explicit offline tarball
  alt Registry spec, hosted default
    CLI->>API: POST name@version, then GET report status
    API-->>CLI: Hosted report or bounded failure
    CLI->>CLI: Validate schema, claim, evidence and policy
  else Local tarball with offline flag
    CLI->>Core: Read original local inputs
    Core->>Core: Inert inventory, comparison, syntax and policy
    Core-->>CLI: Validated deterministic report
    opt Explicit local model consent and configuration
      CLI->>Model: Bounded local evidence, no tools
      Model-->>CLI: Advisory result or unavailable status
    end
  end
  CLI->>Viewer: Escape and render the validated report
  CLI-->>Reviewer: report.json, report.html and policy exit code
```

Offline here means acquisition is disabled. Adding `--allow-model` deliberately
permits the separately configured model stage to transmit selected local excerpts;
without that consent the CLI does not construct or call a provider client.

## Hosted sequence and state

```mermaid
sequenceDiagram
  actor Visitor
  participant Web as Next.js service
  participant HTTP as Analysis API
  participant Queue
  participant Parent as Runner in main process
  participant Child as Deterministic child
  participant Model
  participant Store
  Visitor->>Web: POST exact name@version
  Web->>HTTP: Proxy form to API check route
  HTTP->>Queue: Validate, coalesce or admit
  HTTP-->>Web: 303 report location
  Web-->>Visitor: Relative report redirect
  Queue->>Parent: Start when active slot is free
  Parent->>Child: Minimal environment and JSON input
  Child->>Child: Acquire, inventory, compare and apply policy
  Child-->>Parent: Bounded report file, then exit
  Parent->>Parent: Wait for exit and validate report
  opt Model enabled with eligible evidence
    Parent->>Model: Bounded three-tier advisory route
    Model-->>Parent: Validated result or unavailable status
  end
  Parent->>Parent: Remove owned temporary directory
  Parent-->>Queue: Report within output byte cap
  Queue->>Store: Save terminal job and report
  Visitor->>Web: GET report page or JSON
  Web->>HTTP: Read API report JSON
  HTTP->>Store: Read status or stored report
  HTTP-->>Web: Job metadata or schema 1 report
  Web-->>Visitor: Status, or link to API evidence viewer and JSON
```

```mermaid
stateDiagram-v2
  [*] --> queued: Admitted POST
  queued --> running: Active slot available
  queued --> incomplete: Queue TTL exceeded
  running --> done: Report exit 0 or 3
  running --> incomplete: Report exit 2 or execution deadline
  running --> failed: Runner error or invalid result
  done --> Unavailable: TTL, eviction or restart
  incomplete --> Unavailable: TTL, eviction or restart
  failed --> Unavailable: TTL, eviction or restart
  Unavailable --> [*]
```

An incomplete job can retain deterministic findings. A generic failed job need
not have a report. Model failure cannot clear policy findings; a model section
that cannot fit the result cap is compacted or rejected within that same cap.
GET requests never start work or retry a model request. Shutdown aborts active
work, waits for child termination and cleanup, and closes the HTTP listener.

## Boundaries of the design

Source bytes at a claimed SHA do not prove that a publisher built the package
from those bytes. No rebuild or semantic-equivalence claim is made. Provenance
fields are not cryptographically verified by the reviewed acquisition path.
Syntax inspection supports bounded JavaScript, not general TS/JSX or all generated
code. Model quotations validate locations, not reasoning quality.

The current scope is npm only, without PyPI support, release monitoring or a watch service. There is no durable shared queue, distributed report store or multi-instance routing guarantee. The [live snapshot](README.md) records two responding Cloud Run services and a completed Gemini-backed zod result. Diagrams do not establish serving image digests, production load capacity, usefulness or user validation. Prompt development on that same public package is not an independent study. Gemini is not open-weight, and the configured Gemma fallback has not established hackathon compliance; see the [model disclosure](../HACKATHON.md).
