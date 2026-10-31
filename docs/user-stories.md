# User stories

What each kind of user can do with UNMASK, the acceptance criteria for it, and
whether it works today. The [user journeys](user-journeys.md) show the same
stories as diagrams.

**Status on 1 November 2026:** ✅ shipped · 🟡 partly shipped · 🔲 planned ·
⛔ removed from scope

**Priority:** **P0** is the protected core. **P1** is core work that may only be
cut with an explicit disclosure. **S** is a stretch goal.

## At a glance

| ID     | Story                                        | Priority | Status |
| ------ | -------------------------------------------- | -------- | ------ |
| CLI-1  | Check a local tarball against a known source | P0       | ✅     |
| CLI-0  | Clear failure before any input is accepted   | P0       | ✅     |
| CLI-2  | Exit codes that mean exactly one thing       | P0       | ✅     |
| CLI-3  | Check a release by name from the CLI         | P0       | ✅     |
| CLI-4  | Replay offline with no network               | P0       | ✅     |
| CLI-6  | A plain review summary                       | P0       | 🟡     |
| CLI-7  | Flag strings that are not in the source      | P0       | ✅     |
| CLI-5  | AI explanations that cannot decide           | P1       | 🟡     |
| WEB-1  | Check a release on the website               | P0       | ✅     |
| WEB-2  | Same report from website and CLI             | P0       | ✅     |
| WEB-3  | A hosted service that stays within limits    | P0       | ✅     |
| WEB-4  | Hosted AI with a disclosed configuration     | P1       | ✅     |
| WEB-6  | Prove which build is serving                 | P1       | ✅     |
| WEB-5  | Upload a tarball on the website              | —        | ⛔     |
| REL-1  | One version bump makes one immutable release | P0       | ✅     |
| REL-2  | Deploy exactly that release                  | P1       | ✅     |
| EVAL-1 | Planted changes are found and scored         | P0       | 🟡     |

## CLI

### CLI-1: check a local tarball against a known source ✅

_As a reviewer, I can check a local copy of a package against a source archive
at a full commit, offline, and get a report._

```bash
unmask check --tarball FILE.tgz --source-archive SOURCE.tgz \
  --commit FULL_SHA --source-root ARCHIVE_PREFIX [--source-dir RELATIVE_DIR] \
  [--claim name@version] --offline --cache-dir CACHE --out OUTPUT
```

- The report records the SHA-256 and SHA-512 of the exact input bytes. A registry
  download never replaces the local input.
- Inputs are read artifact first, then source, in archive order, so the result
  never depends on network timing. Path depth, path length and path-count limits
  apply.
- Every regular file in the package has exactly one state: byte-identical,
  changed, artifact-only or not-compared, with a reason.
- If `--claim` disagrees with the package's own `package.json`, the report shows
  the conflict and the rule `identity-claim-conflict` exits 3.
- The command writes `report.json` and an escaped `report.html` that loads nothing
  from the network.
- Nothing from the package runs. A fixture with an install script proves no hook
  executes.

### CLI-0: clear failure before any input is accepted ✅

A missing, unreadable or oversized file exits 2 with a short message. No report
and no made-up hashes are produced. Once the package is accepted, later failures
still produce a partial report.

### CLI-2: exit codes that mean exactly one thing ✅

| Exit | Meaning                                                 |
| ---- | ------------------------------------------------------- |
| 0    | Analysis completed and no review rule fired. Not "safe" |
| 3    | A review rule fired                                     |
| 2    | Input or acquisition failed, or analysis is incomplete  |
| 1    | Internal error                                          |

- An exit-2 report still lists every finding in its JSON.
- Tests assert the exact rule IDs: `integrity-mismatch`,
  `identity-claim-conflict`, `lifecycle-source-absent` and
  `lifecycle-implicit-gyp`.
- A dependency change on its own does not exit 3.

### CLI-3: check a release by name from the CLI ✅

_As a developer, I run `unmask check name@exact-version --out OUTPUT` and get the
same report as the website, with no model key of my own._

- The CLI sends only the package spec to the hosted service, then polls
  `/r/<id>.json`. `UNMASK_SERVER_URL` selects another service; it must be HTTPS,
  or HTTP on localhost for testing.
- No local files, environment values or keys are sent.
- There is no silent local fallback. A hosted failure exits 2 with a clear message.
- The returned report is validated as untrusted input before it is written.

On the service, acquisition follows these rules:

- Only `registry.npmjs.org` and `codeload.github.com` at a full commit are
  fetched, and redirects are refused.
- If the source is missing or conflicting, the report is artifact-only and says
  source comparison is unavailable. A branch or tag is never used instead.
- In a monorepo, the package directory is chosen only by `repository.directory`
  or one unambiguous name match. Otherwise nothing is chosen.

### CLI-4: replay offline with no network ✅

With `--offline` and a supplied source archive, no network request is made.
Registry integrity shows as unavailable, and the same inputs always produce the
same report.

### CLI-6: a plain review summary 🟡

_As a developer, I want one line that tells me where to look first._

- Shipped: the report shows its completion state, the policy findings with their
  rule IDs, file counts and byte coverage. It never grades the package or says
  "safe".
- Planned: a single summary line ("Review required: N items", "Review suggested",
  "Incomplete: reason") and a package profile with entry points, install-time
  scripts and capabilities.

### CLI-7: flag strings that are not in the source ✅

In changed and artifact-only JavaScript, the parser collects string literals with
exact byte ranges. A literal with no exact match in the inspected source is
marked novel.

- Only a direct literal passed as the first argument of a recognized call counts.
- A novel network address used in a network call, or a novel shell command used
  in a process call, raises a "review suggested" cue.
- Novelty is "not assessed" when the source has no JavaScript or the index is
  truncated. A cue never causes exit 3 on its own.

### CLI-5: AI explanations that cannot decide 🟡

_As a reviewer, I want each difference explained, without the AI changing the
result._

- For each changed or artifact-only hunk, the model returns `review-concern`,
  `possible-transformation` or `unknown`, with a quoted, located reason.
- Every quotation must match the cited bytes exactly, or the hypothesis is dropped.
- Model output never changes file states, findings or the exit code. With the
  model on or off, the deterministic fields are byte-identical.
- At most 3 generation attempts, 45 seconds each and 135 seconds in total.
- Offline, excerpts are sent only with `--allow-model`. Without it the report says
  the model was not sent.
- Status: the route works on the hosted service; the live `zod@4.6.7` report
  produced three validated hypotheses. The pre-registered five-fixture model test
  has not been run, and no human has graded usefulness.

## Website

### WEB-1: check a release on the website ✅

_As a developer, I enter `name@version` and get a report without installing
anything._

- `POST /check` answers 303 to `/r/<id>`. The status page shows queued, running,
  incomplete or failed, and refreshes every 3 seconds.
- A page view never starts a check or retries a model call.
- A check identical to one already queued, running or done is reused without
  using an admission slot. Failed, timed-out and model-unavailable results are
  never reused.
- Input must be a valid npm name and an exact version. URLs, tags and ranges are
  rejected.
- The words "safe", "clean" and "verified safe" never appear as a verdict.

### WEB-2: same report from website and CLI ✅

For the same inputs, analyzer, policy and limits, the website and the CLI produce
byte-identical canonical reports. Time, cache, host and surface details are kept
in a separate `run` section that is left out of the comparison. Verified on
`chalk@6.0.1`: the installed CLI and server gave the same canonical hash.

### WEB-3: a hosted service that stays within limits ✅

| Limit              | Value                                            |
| ------------------ | ------------------------------------------------ |
| New checks         | 6 per 10 minutes, shared by everyone             |
| Queue              | 1 running and 1 waiting; a wait expires at 300 s |
| Execution deadline | 240 s per check                                  |
| Analysis worker    | Separate process, 512 MiB heap, 120 s            |
| Report reuse       | 30 minutes after completion                      |
| Report store       | 200 reports, 64 MiB in total, in memory          |
| Package size       | 50 MiB compressed, 250 MiB expanded              |

- A full queue returns 429 with Retry-After.
- Each check gets a private temporary folder, removed after the worker exits.
- With the model turned off, the deterministic results are unchanged.

### WEB-4: hosted AI with a disclosed configuration ✅

- The route is Gemini 3.5 Flash, then Gemini 3 Flash preview, then Gemma 4 26B.
  A request moves on only after a rate limit, a server error or a timeout.
- Each report names the provider, model, prompt hash and configuration hash.
- When the operator's cap is used up, the model status is `unavailable`.
- The API key never appears in responses, logs, the image or the repository.

### WEB-6: prove which build is serving ✅

`GET /version` returns the version, commit and tarball SHA-256. It is also the
liveness check on Cloud Run.

### WEB-5: upload a tarball on the website ⛔

Removed on 31 October to keep the hosted service free of user files. Local copies
use CLI-1.

## Release and operation

### REL-1: one version bump makes one immutable release ✅

- Merging a version bump to main runs the tests, builds once and packs once,
  recording the tarball hashes.
- The release is refused if the version, tag or image already exists, or if the
  version does not increase.
- The image installs that exact tarball with `npm ci --omit=dev --ignore-scripts`.
- npm publication counts only after the public registry bytes are re-downloaded
  and match.
- A manifest binds the version, commit, tarball hashes and image digest to an
  immutable GitHub release.
- Shipped: `@xagents_in/unmask@0.1.0` is on npm.

### REL-2: deploy exactly that release ✅

- After a release, CI creates a Cloud Run revision with no traffic, waits for it
  to be ready, runs a smoke test that includes the model path, then moves all
  traffic to it.
- The website is deployed the same way, after the API.
- `/version` must match the release's version, commit and tarball hash.
- A failed check after promotion rolls back to the previous verified revision
  when it is safe to do so.

## Evaluation

### EVAL-1: planted changes are found and scored 🟡

- Shipped: eight planted variants on chalk and axios (install-script injection,
  logic edits, bundle edits, added files and benign controls). With the network
  off, the installed CLI passed all 11 cases of the deterministic matrix on path,
  state and policy.
- Not yet run: the two sealed held-out variants and the pre-registered model
  test. Every miss will be reported, and no detection-rate or false-positive
  claim is made for the wider ecosystem.

## Planned next

| Story            | What it adds                                                                          |
| ---------------- | ------------------------------------------------------------------------------------- |
| Package summary  | One card: identity, entry points, install-time scripts, capabilities, coverage        |
| Known advisories | An OSV lookup for the exact release, shown as evidence, never as "no vulnerabilities" |
| More ecosystems  | PyPI wheels and source distributions, then release monitoring                         |
