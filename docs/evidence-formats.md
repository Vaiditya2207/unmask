# Evidence formats

UNMASK can present one completed check in several machine-readable forms. All of them are derived from the same schema-1 report and add no new analysis. This page compares what each one contains, shows the exact commands and requests that produce them, and explains how to read identity conflicts and partial advisory results. None of these formats is a safety verdict.

The examples come from the inert fixtures in [examples/evidence-exports](../examples/evidence-exports/README.md), and every output quoted below was produced by running that example. The SBOM and evidence-manifest routes are local source behavior on this branch. Their availability on a hosted origin requires deployment and a representative request against that exact candidate.

## Scopes at a glance

| Format                             | How to get it                                                                                               | Contains                                                                                                                                                                                                                                                                     | Does not claim                                                                                                                               |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Report JSON (schema 1)             | `GET /r/<id>.json`; CLI `unmask check … --out DIR` writes `DIR/report.json`                                 | The full recorded evidence: inputs and digests, source selection, per-file correspondence, evidence spans, manifests, cues, failures, model result and policy result                                                                                                         | That unread or rejected entries are absent; safety                                                                                           |
| Package details                    | `GET /r/<id>.details.json` ([reference](package-details.md))                                                | A bounded projection of the report plus the advisory result stored with the hosted job                                                                                                                                                                                       | Transitive dependencies, license compliance, runtime behavior                                                                                |
| CycloneDX 1.6 SBOM                 | `GET /r/<id>.cdx.json`                                                                                      | The analyzed tarball as `metadata.component` with SHA-256/SHA-512; publisher-declared direct dependency entries; bundled `node_modules` paths observed in the tarball                                                                                                        | Dependency versions or resolution, a transitive graph, vulnerabilities, a signature. Every dependency carries `unmask:resolution=unresolved` |
| Evidence manifest                  | `GET /r/<id>.evidence.json`                                                                                 | Report ID and completion time; digests of the served report and SBOM bytes; analyzer and service identity; requested vs declared identity; tarball, source-archive and registry-document digests; source selection; inventory digest; policy findings; coverage; limitations | A cryptographic signature (`signature.status: "unsigned"`), a safety verdict (`assessment.safetyVerdict: "not-provided"`), advisory results  |
| SARIF 2.1.0 and GitHub annotations | `unmask sarif` / `unmask annotations` (see [Automation outputs](#automation-outputs-sarif-and-annotations)) | Policy findings, review cues and supplied advisories as results with byte-offset regions; coverage and advisory limitations as tool notifications                                                                                                                            | Line/column locations, absence of issues ("Absence of results does not establish that the package is safe")                                  |

The SBOM, evidence manifest and SARIF are generated on request from the stored report. Neither reading them nor downloading them fetches, executes or re-analyzes the package.

## Requests and commands

### Hosted API

```sh
# Start a check and keep the Location header (/r/<id>).
curl -i -X POST "$UNMASK_ORIGIN/check" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'package=example@1.2.3'

curl -o report.json   "$UNMASK_ORIGIN/r/$REPORT_ID.json"
curl -o details.json  "$UNMASK_ORIGIN/r/$REPORT_ID.details.json"
curl -o sbom.cdx.json "$UNMASK_ORIGIN/r/$REPORT_ID.cdx.json"
curl -o evidence.json "$UNMASK_ORIGIN/r/$REPORT_ID.evidence.json"
```

| Situation                                      | `.cdx.json` / `.evidence.json` response                                                                                                      |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Completed report                               | 200. SBOM: `application/vnd.cyclonedx+json`, file `unmask-sbom.cdx.json`. Manifest: `application/json`, file `unmask-evidence-manifest.json` |
| Queued or running                              | 202 `{"status": …}` with `Retry-After: 3`                                                                                                    |
| Unknown, expired, evicted or restarted-away ID | 404 `{"error": "report-unavailable"}`                                                                                                        |
| Terminal job without a report                  | 409 `{"error": "report-not-produced", "status": …}`                                                                                          |
| Stored report fails validation                 | 422 `{"error": "report-not-exportable"}`                                                                                                     |

All export responses keep `Cache-Control: no-store`. They share the report's 30-minute completion-based expiry, and reading them does not extend it. The completed-report page links both downloads next to the report JSON.

### Offline CLI

```sh
unmask check --tarball PACKAGE.tgz --offline --cache-dir CACHE --out OUTPUT \
  --claim name@1.2.3 \
  [--source-archive SOURCE.tgz --commit FULL_SHA --source-root DIR]
```

This writes `OUTPUT/report.json`. The SBOM and evidence manifest are served by the HTTP routes above; this branch has no separate CLI command for them.

### Automation outputs (SARIF and annotations)

These commands are delivered separately on `feat/automation-outputs` (SARIF) and `feat/automation-outputs-extras` (annotations). They are documented here as of commits `d7e344e9c799184f031675391f7e699f96ac07b0` (SARIF) and `ff1afb0b15e4408889b3f2474f3a832f6f907bd0` (annotations), and are not part of this branch until those changes are integrated.

```sh
unmask sarif --report report.json [--details details.json] [--out results.sarif]
unmask annotations --report report.json [--details details.json] [--summary "$GITHUB_STEP_SUMMARY"]
```

`--details` accepts either a hosted `/r/<id>.details.json` document, from which the commands read `vulnerabilityCheck`, or a bare OSV vulnerability-check snapshot.

Exit codes:

- `unmask sarif` exits 0 when it writes output and 2 on rejected input.
- `unmask annotations` exits with the report's policy exit code, with two adjustments when that code is 0:
  - it exits 3 if a known advisory is present;
  - it exits 2 if a supplied advisory check is incomplete or unavailable.

## Verifying the links between formats

The evidence manifest records digests of the exact bytes the API serves, so each one can be checked independently:

```sh
curl -s "$UNMASK_ORIGIN/r/$REPORT_ID.json"     | shasum -a 256  # equals report.servedJsonSha256
curl -s "$UNMASK_ORIGIN/r/$REPORT_ID.cdx.json" | shasum -a 256  # equals exports.sbomServedSha256
```

Other digests in the manifest:

| Field                    | Meaning                                                                                                                                                                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `report.canonicalSha256` | SHA-256 of the canonical report: sorted-key JSON excluding `run` and `model`, newline terminated (`canonicalReport`). It is stable across reruns that differ only in timing or model output    |
| `inventory.digestSha256` | SHA-256 of the JSON array of `[originalPath, artifactSha256, size]`, sorted by `originalPath`                                                                                                  |
| `artifacts[]`            | The tarball's SHA-256/SHA-512 and, when recorded, the source archive and registry document. The tarball's `expectedIntegrity.status` is `matches`, `mismatch`, `unavailable` or `not-recorded` |

These digests support comparing bytes. They do not prove who produced the package or where it came from.

## Identity

Every report records the identity that was requested (`inputs.claim`) separately from the identity declared by the analyzed tarball's own `package.json`. The SBOM and evidence manifest bind a package URL only when the two agree:

| Identity status                 | SBOM `metadata.component`            | Manifest `package.purl` | Notes                                            |
| ------------------------------- | ------------------------------------ | ----------------------- | ------------------------------------------------ |
| `claim-matches-manifest`        | name/version and `purl`              | purl                    | Normal case                                      |
| `manifest-declared-unclaimed`   | declared name/version and `purl`     | purl                    | No claim was recorded                            |
| `claim-conflicts-with-manifest` | declared name/version, **no purl**   | `null`                  | Policy finding `identity-claim-conflict`, exit 3 |
| `claimed-manifest-unavailable`  | `unidentified-npm-artifact`, no purl | `null`                  | Manifest missing or invalid                      |
| `unknown`                       | `unidentified-npm-artifact`, no purl | `null`                  |                                                  |

The root also carries the properties `unmask:requested-identity` and `unmask:declared-identity`, and the manifest carries `package.requested` and `package.declared`. SARIF uses the same status names in `runs[0].properties.unmask.package.identityStatus`, alongside `requested` and `declared`. The declared identity is a publisher declaration and is not verified.

### Reading the identity-conflict example

In the `conflict` example, the tarball declares `@unmask-example/declared@2.0.0` but the check requested `@unmask-example/requested@1.0.0`, with no source archive:

- **Report:** policy finding `identity-claim-conflict`, exit code 3.
- **SBOM:** `metadata.component` is `@unmask-example/declared` `2.0.0` with no `purl`, plus `unmask:identity-status=claim-conflicts-with-manifest` and both identities as properties. The tarball hashes are those of the analyzed bytes.
- **Evidence manifest:**
  - `package.status` is `claim-conflicts-with-manifest` and `package.purl` is `null`;
  - the limitations include "Requested identity conflicts with the artifact manifest." and "No source archive was compared with the published artifact.";
  - `source.method` is `unresolved`.
- **SARIF** (commit ff1afb0):
  - an error result `policy/identity-claim-conflict` located at the artifact `package.json` byte region;
  - `runs[0].properties.unmask.package` names the **requested** identity (`source: "claim"`) with `identityStatus: "claim-conflicts-with-manifest"` and both `requested` and `declared`;
  - `runs[0].properties.unmask.advisories.boundTo` is `"claim"`, and advisory results use the logical location `npm:@unmask-example/requested@1.0.0`;
  - the warning notification `advisory/identity-conflict` states that the declared identity was not screened.
- **Annotations step summary:** the heading reads `@unmask-example/requested@1.0.0 (claimed; artifact declares @unmask-example/declared@2.0.0)`, an `Identity` row shows the status, and the advisory status is suffixed `(for requested identity)`.

Advisory snapshots are queried for the requested identity. When the identity conflicts, an advisory status in SARIF or annotations, including `none-reported`, describes the requested name and version only. It says nothing about the identity the tarball declares, which was not queried. Resolve the identity conflict before relying on any advisory status. The `conflict-none` example shows this case: the SARIF advisory block reads `status: none-reported, complete: true, boundTo: "claim"`, and the `advisory/identity-conflict` warning carries the caveat. When the manifest is unavailable, SARIF instead emits the note `advisory/identity-unverified`.

## Partial advisory results

An OSV snapshot has a `status`: `found`, `none-reported`, `incomplete`, `unavailable` or `not-assessed`. Only `found` and `none-reported` are complete. An `incomplete` snapshot can still carry the advisories it did retrieve, for example after a page cap. In the `conflict-partial` SARIF example (commit ff1afb0):

- `GHSA-0000-0000-0001`, whose only `MAL-` identifier is an alias, is reported as `advisory/known-malware` (error) with `properties.malwareIdentifier: "MAL-0000-0001"`.
- The withdrawn `MAL-0000-0002` is reported as `advisory/withdrawn` (note), and annotations do not raise the exit code for it.
- The notification `advisory/incomplete` states that missing advisories do not mean none exist.
- When an advisory records no severity, `properties.severity.status` is `not-recorded`. SARIF levels follow a fixed rule mapping (`levelBasis: "fixed-rule-mapping"`), not a recorded score.

The SBOM and evidence manifest do not include advisories. Use the package details document, or SARIF with `--details`, for advisory results.

## Limitations

- Dependency entries come from the tarball's `package.json` and from bundled paths. They are not resolved, installed or verified.
- A recorded source commit is reported with its selection method. Unless the method is `provenance-verified`, the export does not verify it cryptographically.
- No current finding, empty advisory result or complete coverage establishes that a package is safe.
- Hosted exports are available only while the report is cached.
