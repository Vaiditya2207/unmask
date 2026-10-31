# Install decision contract

Guard decisions are additive. Existing schema-1 reports, deterministic policy
findings and exit codes are unchanged. No findings never means safe.

Start a check with the existing `POST /check` form (`package=name@exact-version`),
then read `GET /r/<32-hex-report-id>.decision.json`. GET reads the stored result;
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
| `profile`                               | `"balanced"`                                                                                                                                 |
| `package`                               | `{ecosystem:"npm",name,version}` matching the requested exact identity                                                                       |
| `decision`                              | `allow`, `warn`, `block`, or `unknown`                                                                                                       |
| `permitted`                             | True for allow/warn; false for block/unknown                                                                                                 |
| `enforcement`                           | `"enforce"`                                                                                                                                  |
| `reasons`                               | Array with machine-readable `code`; deterministic findings include `ruleId` and bounded `evidenceIds`; advisory reasons include `advisoryId` |
| `knownMalware`                          | Active advisory identities `{id,aliases}` with a `MAL-<year>-<number>` ID or alias; withdrawn records excluded                               |
| `policyExitCode`                        | Original report exit code, or null when report is absent/invalid/mismatched                                                                  |
| `assessment`                            | `complete`, `artifactComplete`, `sourceComplete`, `advisoriesComplete`, `modelStatus`, `modelComplete`                                       |
| `limitations`                           | Explicit assessment boundaries; never a safety guarantee                                                                                     |
| `reportId`, `checkStatus`, `assessedAt` | HTTP-only stored job identity, status and completion timestamp (null while pending)                                                          |

Precedence: known malware or deterministic identity/integrity/provenance failure
blocks, even if another check is incomplete. Otherwise incomplete required
assessment gives unknown. Other deterministic findings, active vulnerabilities,
or an AI review concern produce warn; remaining complete assessments allow.

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
