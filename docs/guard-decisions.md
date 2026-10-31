# Install decision contract

Guard decisions are additive. Existing schema-1 reports, deterministic policy
findings and exit codes are unchanged. No findings never means safe.

Start a check with the existing `POST /check` form (`package=name@exact-version`),
then read `GET /r/<32-hex-report-id>.decision.json`. The fixed policy is strict. GET reads the stored result;
it never starts analysis, advisory lookups or model calls. Pending checks return
202 and `Retry-After: 3`; terminal results return 200, including failed checks.
Expired, unknown or evicted reports return 404 JSON. Other methods return 405.

The equivalent pure JavaScript entrypoint is:

```js
import { evaluateGuardDecision } from "../src/core/guard-policy.mjs";
const decision = evaluateGuardDecision({
  nameAtExactVersion: "example@1.2.3",
  report,
  vulnerabilityCheck,
});
```

`nameAtExactVersion` is required and must be an exact npm identity. `report` is an
optional validated schema-1 report and `vulnerabilityCheck` is the normalized
OSV exact-version lookup. Identity mismatches, malformed inputs, missing source
comparison, failed analysis, disabled advisory checks and partial lookups cannot
produce `allow`. Invalid package identities throw `TypeError`.

The JSON object contains:

| Field                                   | Contract                                                                                                                                     |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `decisionVersion`                       | `"1"`                                                                                                                                        |
| `policyVersion`                         | `"guard-1"`; independent of the existing report policy version                                                                               |
| `profile`                               | `strict` (fixed)                                                                                                                             |
| `package`                               | `{ecosystem:"npm",name,version}` matching the requested exact identity                                                                       |
| `decision`                              | `allow`, `warn`, `block`, or `unknown`                                                                                                       |
| `permitted`                             | True for allow/warn; false for block/unknown                                                                                                 |
| `enforcement`                           | `enforce`                                                                                                                                    |
| `reasons`                               | Array with machine-readable `code`; deterministic findings include `ruleId` and bounded `evidenceIds`; advisory reasons include `advisoryId` |
| `knownMalware`                          | Active advisory identities `{id,aliases}` with a MAL ID/alias or the sourced historical table match; withdrawn records excluded              |
| `policyExitCode`                        | Original report exit code, or null when report is absent/invalid/mismatched                                                                  |
| `assessment`                            | `complete`, `artifactComplete`, `sourceComplete`, `advisoriesComplete`, `modelStatus`, `modelComplete`                                       |
| `limitations`                           | Explicit assessment boundaries; never a safety guarantee                                                                                     |
| `reportId`, `checkStatus`, `assessedAt` | HTTP-only stored job identity, status and completion timestamp (null while pending)                                                          |

Precedence: known malware or any deterministic report policy finding
blocks, even if another check is incomplete. Otherwise incomplete required
assessment blocks. Medium/moderate, high and critical advisory severity block. Active vulnerabilities below the threshold or an
AI review concern produce warn; remaining complete assessments allow.

`assessment.complete` covers the artifact inventory, source comparison and
exact-version advisory lookup only. Model availability is separately visible;
AI hypotheses cannot permit or block installation, cannot override deterministic
findings, and cannot manufacture malware identity from prose. No model was added
by this API. It consumes the existing check's model status/output. Missing AI is
never represented as a completed model assessment.

The API uses already stored bounded evidence. Consumers must bind this exact
package/version and artifact identity to their eventual install plan. The API
does not install, execute, monitor, or screen transitive dependencies. It does
not promise fresh data beyond the underlying stored check's lifetime. A consumer
must handle 202/404 explicitly and never treat transport or parsing failure as
permission.

See [synthetic example](../examples/guard-decision/README.md). Hosted runtime and
release integration remain unverified until the final candidate is exercised
through the normal deployed service route.

## Fixed strict policy

This API uses a single fixed strict policy. Policy profile selection is a separate
feature and is not available on this branch. Unknown required evidence, unrated
active advisories and medium/moderate or higher severity deny installation. All
deterministic report policy findings block. AI review concerns alone may warn.

Severity is the highest supported OSV-declared label from `databaseSeverity`
or an affected npm package entry matching the requested package name. Supported
labels are low, medium/moderate, high and critical, case insensitive. Missing or
unsupported labels remain unknown; strict denies installation with an
`advisory-severity-unknown` reason. CVSS
vectors are not parsed or turned into invented numeric scores. A critical label
on an unrelated affected package does not elevate the requested package.
Profile severity blockers survive incomplete artifact/source checks. Withdrawn
advisories never become active blockers. Unknown severity differs from an
incomplete lookup: the latter fails closed under the fixed strict policy.

## Historical malware identity table

Some OSV-normalized GitHub advisories have no MAL alias. The following curated
exact-ID and package/version pairs are also classified as known malware. Each
classification was checked against the linked GitHub Advisory Database record
on 2026-10-31; descriptions are evidence for this reviewed table, never runtime
summary matching. A table entry on an unrelated package or version is ignored.

| Advisory                                                                 | Package versions                  | Source finding                                |
| ------------------------------------------------------------------------ | --------------------------------- | --------------------------------------------- |
| [GHSA-pjwm-rvh2-c87w](https://github.com/advisories/GHSA-pjwm-rvh2-c87w) | ua-parser-js 0.7.29, 0.8.0, 1.0.0 | Malicious code in published versions          |
| [GHSA-mh6f-8j2x-4483](https://github.com/advisories/GHSA-mh6f-8j2x-4483) | event-stream 3.3.6                | Added the malicious flatmap-stream dependency |
| [GHSA-97m3-w2cp-4xx6](https://github.com/advisories/GHSA-97m3-w2cp-4xx6) | node-ipc 10.1.1, 10.1.2           | Embedded code intended to overwrite files     |

Only active matching advisory identities qualify. Registry removal, lookup
failure, a malicious-looking summary, AI text or an unrelated behavior-change
advisory is insufficient. This small table is not an exhaustive malware feed.
The normal exact-version OSV lookup remains required; table membership alone
without a returned active advisory does not claim a finding.

## Reusable advisory-only classification

`classifyGuardAdvisory(record, {ecosystem:"npm",name,version})` shares the same
classifier without requiring or inventing an artifact report. It returns
`{id,status,knownMalware,severity}`, where status is active, withdrawn or invalid.
The input is a normalized OSV record (including an aliases array); invalid
records must remain unknown in the consumer, never be dropped into clean output.
The identity must be exact. A bad identity throws TypeError.

This function intentionally supplies no install permission or completeness
claim. The caller must bind the record to a trusted exact-version query, prove
lookup completeness, report advisory-only scope, and separately bind the install
plan and its artifacts. Neither active ordinary vulnerability nor an empty
advisory list proves that an artifact is safe. The full decision endpoint still
requires honest artifact/source coverage and fails closed when those are absent.

The `artifact` field carries the validated report's lowercase hexadecimal sha256
and sha512 digests in the same decision response, or null when the report is
absent, invalid or bound to a different identity. Convert to the appropriate SRI
encoding before comparing with a lockfile; never compare hexadecimal text to a
base64 SRI digest directly. The field identifies assessed bytes, not permission
to accept a different artifact or future registry response.

`assessment.advisorySeverityComplete` independently indicates whether every
active ordinary advisory has a supported declared severity. This can be false
while the exact-version advisory lookup itself is complete. Strict denies this
unknown severity; it does not silently treat an unrated advisory as low severity.
All deterministic report findings, including lifecycle-source-absent and
lifecycle-implicit-gyp, produce block decisions with permitted:false. Original deterministic report
exit values remain untouched.
