# Architecture

This is the design and pending implementation described in the
[documentation status](README.md). It is not a description of a deployed service.
The [contracts](contracts.md) define observable behavior; the
[stack](stack.md) records implementation choices and limits.

## Purpose and trust boundaries

UNMASK inventories a package tarball, selects a disclosed source reference,
compares regular-file bytes, and renders evidence for human review. An integrity
match, a source claim, byte correspondence, syntax cues and model hypotheses are
separate facts. None establishes that the whole package is safe.

```mermaid
flowchart LR
  Engineer[Dependency reviewer] --> CLI[Local CLI]
  Visitor[Website visitor] --> HTTP[Hosted HTTP application]
  CLI --> Core[Shared analysis core]
  HTTP --> Runner[Queued hosted analysis]
  Runner --> Core
  Core --> Registry[Public npm registry]
  Core --> Source[GitHub archive at full commit SHA]
  Core --> Report[Versioned JSON evidence]
  Report --> Viewer[Shared escaped HTML viewer]
  Report --> Model[Optional hosted model]
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

A CLI user chooses either an exact registry release or a local tarball. The
current local mode requires `--offline`; an optional local source archive needs a
full commit claim and explicit archive root. The CLI writes JSON and HTML to an
explicit output directory and returns the deterministic policy exit code. It runs
the pipeline **inside the CLI process**, without the hosted queue or child runner.

A website visitor submits an exact `name@version`. POST admission returns a
private report location, and subsequent GETs read its status or result. The
website accepts neither tarball uploads nor arbitrary source URLs. Reports are
in-memory, temporary and accessible to anyone holding their random URL; there is
no account or durable report service.

Model use is optional. The CLI additionally requires `--allow-model`, including
for registry input. Hosted configuration must explicitly enable the provider and
supply verified quota limits. Missing configuration leaves deterministic analysis
available. No eligible evidence means no provider request.

## Components and process boundaries

```mermaid
flowchart TB
  subgraph CLIProcess[CLI process]
    CLI[cli/main.mjs] --> Local[core/pipeline.mjs]
    CLI --> OnlineCLI[core/online.mjs]
    OnlineCLI --> Local
    CLI --> CLIModel[Optional model stage]
  end
  subgraph MainProcess[Hosted main process]
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
  Runner --> Worker
  Worker --> Result[Bounded report.json]
  Result --> Runner
  CLIModel --> Config[model/config.mjs and client.mjs]
  ParentModel --> Config
```

`core/acquire.mjs` fetches bounded registry metadata and archives;
`core/resolve.mjs` interprets source claims. Registry orchestration calls the same
local pipeline after capturing input bytes. The CLI preserves digest-addressed
input copies in its explicit cache directory. Hosted jobs disable that duplicate
cache and keep captured inputs in their private per-job directory.

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
  participant Core
  participant Model
  participant Viewer
  Reviewer->>CLI: Explicit registry or offline local input
  CLI->>Core: Capture original bytes and resolve source
  Core->>Core: Inert inventory, comparison, syntax and policy
  Core-->>CLI: Validated deterministic report
  opt Explicit model consent and verified configuration
    CLI->>Model: Bounded evidence, no tools
    Model-->>CLI: Validated advisory section or unavailable status
  end
  CLI->>Viewer: Escape and render the same report
  CLI-->>Reviewer: report.json, report.html and policy exit code
```

Offline here means acquisition is disabled. Adding `--allow-model` deliberately
permits the separately configured model stage to transmit selected local excerpts;
without that consent the CLI does not construct or call a provider client.

## Hosted sequence and state

```mermaid
sequenceDiagram
  actor Visitor
  participant HTTP
  participant Queue
  participant Parent as Runner in main process
  participant Child as Deterministic child
  participant Model
  participant Store
  Visitor->>HTTP: POST exact name@version
  HTTP->>Queue: Validate, coalesce or admit
  HTTP-->>Visitor: 303 report location
  Queue->>Parent: Start job when active slot is free
  Parent->>Child: Minimal environment and JSON input
  Child->>Child: Acquire, inventory, compare and apply policy
  Child-->>Parent: Bounded report file, then exit
  Parent->>Parent: Wait for exit and validate report
  opt Model enabled with eligible evidence
    Parent->>Model: Explain bounded evidence
    Model-->>Parent: Advisory result or unavailable status
  end
  Parent->>Parent: Remove owned temporary directory
  Parent-->>Queue: Report within output byte cap
  Queue->>Store: Save terminal job and report
  Visitor->>HTTP: GET report location
  HTTP->>Store: Read status or stored report
  HTTP-->>Visitor: Status, escaped evidence or JSON
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

The current scope is npm only, without PyPI support, release monitoring or a
watch service. There is no durable shared queue, distributed report store or
multi-instance routing guarantee. No deployed image, successful hosted generation,
production load result or user validation is established by these diagrams.
The latest minimal provider diagnostic reached metadata and token counting, but
generation is blocked by the configured project's unavailable free tier. See the
[model status](../HACKATHON.md) for the acceptance boundary.
