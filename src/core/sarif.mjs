import { createHash } from "node:crypto";
import { LocalInputError } from "./pipeline.mjs";
import { validateReport } from "./report.mjs";

export const SARIF_VERSION = "2.1.0";
export const SARIF_SCHEMA =
  "https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json";
const MAX_RESULTS = 1000;
const MAX_LOCATIONS = 10;
const MAX_TEXT = 1024;
const advisoryStatuses = [
  "found",
  "none-reported",
  "incomplete",
  "unavailable",
  "not-assessed",
];
const RULES = {
  "policy/integrity-mismatch": [
    "error",
    "Artifact digest differs from the expected registry integrity.",
  ],
  "policy/provenance-verification-failed": [
    "error",
    "Artifact provenance verification failed.",
  ],
  "policy/identity-claim-conflict": [
    "error",
    "Artifact manifest identity differs from the claimed package identity.",
  ],
  "policy/lifecycle-source-absent": [
    "error",
    "Artifact install lifecycle script is absent from or differs in the complete selected source.",
  ],
  "policy/lifecycle-implicit-gyp": [
    "error",
    "Artifact-only binding.gyp enables an implicit npm install build step.",
  ],
  "advisory/known-malware": [
    "error",
    "OSV reports a malicious-package advisory for this exact package version.",
  ],
  "advisory/known-vulnerability": [
    "warning",
    "OSV reports a vulnerability advisory for this exact package version.",
  ],
  "advisory/withdrawn": [
    "note",
    "OSV lists a withdrawn advisory for this exact package version.",
  ],
};
const failure = (code, message) => new LocalInputError(code, message);
const text = (value, limit = MAX_TEXT) =>
  typeof value === "string"
    ? value.length > limit
      ? `${value.slice(0, limit)}…`
      : value
    : "";
const token = (value) =>
  typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value)
    ? value
    : "unrecognized";
const sha256 = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const usableManifest = (manifest) =>
  manifest?.status === "usable" &&
  typeof manifest.value?.name === "string" &&
  typeof manifest.value?.version === "string";

export function reportIdentity(report) {
  const claim = report.inputs.claim;
  const requested = claim ? { name: claim.name, version: claim.version } : null;
  const declared = usableManifest(report.manifests.artifact)
    ? {
        name: report.manifests.artifact.value.name,
        version: report.manifests.artifact.value.version,
      }
    : null;
  const status =
    requested && declared
      ? requested.name === declared.name &&
        requested.version === declared.version
        ? "claim-matches-manifest"
        : "claim-conflicts-with-manifest"
      : requested
        ? "claimed-manifest-unavailable"
        : declared
          ? "manifest-declared-unclaimed"
          : "unknown";
  const bound = requested ?? declared;
  return bound
    ? {
        ...bound,
        source: requested ? "claim" : "artifact-manifest",
        identityStatus: status,
        requested,
        declared,
      }
    : null;
}

function advisoryId(value) {
  return typeof value === "string" && /^[A-Za-z0-9:_.-]{1,256}$/.test(value);
}

export function advisorySnapshot(details, identity) {
  if (details === undefined) return undefined;
  const snapshot =
    details && typeof details === "object" && !Array.isArray(details)
      ? details.source === "OSV"
        ? details
        : details.vulnerabilityCheck
      : undefined;
  const invalid = () =>
    failure(
      "details-invalid",
      "Details must be an UNMASK package details document or OSV vulnerability check",
    );
  if (
    !snapshot ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot) ||
    snapshot.source !== "OSV" ||
    !advisoryStatuses.includes(snapshot.status) ||
    !Array.isArray(snapshot.advisories) ||
    !Array.isArray(snapshot.reasons ?? []) ||
    snapshot.advisories.length > 1000 ||
    snapshot.advisories.some(
      (item) =>
        !item ||
        typeof item !== "object" ||
        Array.isArray(item) ||
        !advisoryId(item.id),
    ) ||
    (snapshot.status === "found" && snapshot.advisories.length === 0) ||
    (snapshot.status === "none-reported" && snapshot.advisories.length > 0) ||
    snapshot.complete !== ["found", "none-reported"].includes(snapshot.status)
  )
    throw invalid();
  const pkg = snapshot.package;
  if (pkg !== undefined && pkg !== null) {
    if (
      !identity ||
      pkg.ecosystem !== "npm" ||
      pkg.name !== identity.name ||
      pkg.version !== identity.version
    )
      throw failure(
        "details-identity-mismatch",
        "Advisory package identity does not match the report identity",
      );
  } else if (snapshot.advisories.length > 0)
    throw failure(
      "details-identity-mismatch",
      "Advisory findings without a package identity cannot be bound to the report",
    );
  return {
    status: snapshot.status,
    complete: snapshot.complete,
    queriedAt:
      typeof snapshot.queriedAt === "string" ? snapshot.queriedAt : null,
    reasons: (snapshot.reasons ?? []).map(token).slice(0, 32),
    boundTo: identity?.source ?? null,
    advisories: snapshot.advisories.map((item) => ({
      id: item.id,
      aliases: Array.isArray(item.aliases)
        ? item.aliases.filter(advisoryId).slice(0, 16)
        : [],
      summary: text(item.summary),
      withdrawn: typeof item.withdrawn === "string",
      severity: severityOf(item),
    })),
  };
}

function severityOf(item) {
  const affected = Array.isArray(item.affected) ? item.affected : [];
  const scores = [
    ...(Array.isArray(item.severity) ? item.severity : []),
    ...affected.flatMap((entry) =>
      Array.isArray(entry?.severity) ? entry.severity : [],
    ),
  ]
    .filter(
      (entry) =>
        typeof entry?.type === "string" && typeof entry?.score === "string",
    )
    .slice(0, 8)
    .map((entry) => ({
      type: text(entry.type, 32),
      score: text(entry.score, 512),
    }));
  const labels = [
    ...new Set(
      [
        item.databaseSeverity,
        ...affected.map((entry) => entry?.ecosystemSeverity),
      ]
        .filter((value) => typeof value === "string" && value)
        .map((value) => text(value, 64)),
    ),
  ].slice(0, 8);
  return scores.length || labels.length
    ? { status: "recorded", scores, labels, levelBasis: "fixed-rule-mapping" }
    : { status: "not-recorded", levelBasis: "fixed-rule-mapping" };
}

function malwareIdentifier(advisory) {
  return (
    [advisory.id, ...advisory.aliases].find((id) => /^MAL-/.test(id)) ?? null
  );
}

function policyMessage(finding) {
  switch (finding.ruleId) {
    case "integrity-mismatch":
      return `Expected ${finding.algorithm} ${finding.expected} but the artifact digest is ${finding.actual}.`;
    case "identity-claim-conflict":
      return `Artifact manifest differs from the claimed identity in: ${finding.fields.join(", ")}.`;
    case "lifecycle-source-absent":
      return `Install hook "${finding.script}" in the artifact is absent from or differs in the complete selected source; it was not executed.`;
    default:
      return RULES[`policy/${finding.ruleId}`]?.[1] ?? "Policy finding.";
  }
}

function locate(report, evidenceIds) {
  const byId = new Map(report.evidence.map((item) => [item.id, item]));
  const physical = [];
  const unmapped = [];
  for (const id of evidenceIds) {
    const item = byId.get(id);
    if (!item) continue;
    if (item.path === null) {
      unmapped.push({ side: item.side, originalPath: text(item.originalPath) });
      continue;
    }
    if (physical.length < MAX_LOCATIONS)
      physical.push({
        side: item.side,
        path: item.path,
        byteOffset: item.range[0],
        byteLength: item.range[1] - item.range[0],
      });
  }
  return { physical, unmapped };
}

export function collectFindings(input, details) {
  let report;
  try {
    report = validateReport(input);
  } catch {
    throw failure(
      "report-invalid",
      "Report failed schema, evidence or deterministic policy validation",
    );
  }
  const identity = reportIdentity(report);
  const advisories = advisorySnapshot(details, identity);
  const results = [];
  const limitations = [];
  function add(ruleId, level, message, evidenceIds, discriminator, extra = {}) {
    const { physical, unmapped } = locate(report, evidenceIds);
    results.push({
      ruleId,
      level,
      message: text(message, 2048),
      locations: physical,
      evidenceIds,
      fingerprint: sha256([
        ruleId,
        report.inputs.artifact.sha256,
        evidenceIds,
        discriminator,
      ]),
      ...(unmapped.length ? { unmappedEvidence: unmapped } : {}),
      ...extra,
    });
  }
  for (const finding of report.policy.findings)
    add(
      `policy/${finding.ruleId}`,
      "error",
      policyMessage(finding),
      finding.evidenceIds,
      finding.script ?? finding.fields ?? finding.algorithm ?? null,
    );
  for (const advisory of advisories?.advisories ?? []) {
    const malware = malwareIdentifier(advisory);
    const ruleId = advisory.withdrawn
      ? "advisory/withdrawn"
      : malware
        ? "advisory/known-malware"
        : "advisory/known-vulnerability";
    add(
      ruleId,
      RULES[ruleId][0],
      `${advisory.id}${malware && malware !== advisory.id ? ` (alias ${malware})` : ""}: ${advisory.summary || RULES[ruleId][1]} (OSV exact-version query for ${identity.name}@${identity.version}).`,
      [],
      advisory.id,
      {
        advisoryId: advisory.id,
        aliases: advisory.aliases,
        malwareIdentifier: malware,
        severity: advisory.severity,
        package: identity,
      },
    );
  }
  for (const cue of report.cues) {
    const evidenceIds = Array.isArray(cue.evidenceIds) ? cue.evidenceIds : [];
    const parts = [
      typeof cue.field === "string" ? `field ${text(cue.field, 256)}` : "",
      typeof cue.literalStatus === "string"
        ? `literal ${token(cue.literalStatus)}`
        : "",
    ].filter(Boolean);
    add(
      `cue/${token(cue.ruleId)}`,
      "note",
      `${text(cue.summary) || "Review cue recorded by the analyzer; behavior is not proven."}${parts.length ? ` (${parts.join("; ")})` : ""}`,
      evidenceIds,
      cue.field ?? null,
    );
  }
  const coverage = report.coverage;
  const note = (id, level, message) => limitations.push({ id, level, message });
  if (!coverage.inventory.complete)
    note(
      "coverage/inventory-lower-bound",
      "warning",
      "Artifact inventory reached a limit; file and byte counts are lower bounds.",
    );
  if (!coverage.sourceAvailable)
    note(
      "coverage/source-unavailable",
      "warning",
      "No source archive was compared; artifact files have no source correspondence.",
    );
  else if (!coverage.sourceComplete)
    note(
      "coverage/source-incomplete",
      "warning",
      "Source archive coverage is incomplete; source absence is not established.",
    );
  if (coverage.unresolved.files > 0)
    note(
      "coverage/unresolved-files",
      "note",
      `${coverage.unresolved.files} of ${coverage.inventory.files} artifact files are not byte-identical to selected source (${coverage.states["not-compared"].files} not compared).`,
    );
  const skipped = report.annotations.filter(
    (item) =>
      item?.type === "syntax-not-inspected" &&
      item.side === "artifact" &&
      item.reason !== "unsupported-syntax",
  ).length;
  if (skipped > 0)
    note(
      "coverage/syntax-not-inspected",
      "note",
      `${skipped} artifact JavaScript files were not syntax-inspected.`,
    );
  for (const item of report.failures.slice(0, 20))
    note(
      "analysis/failure",
      "error",
      `${text(item.code, 128)}: ${text(item.message)}`,
    );
  if (!advisories)
    note(
      "advisory/not-supplied",
      "note",
      "No advisory snapshot was supplied; known malware and vulnerability advisories are not assessed in this export.",
    );
  else if (!advisories.complete)
    note(
      "advisory/incomplete",
      "warning",
      `OSV advisory check is ${advisories.status}${advisories.reasons.length ? ` (${advisories.reasons.join(", ")})` : ""}; missing advisories do not mean none exist.`,
    );
  if (advisories && identity.identityStatus === "claim-conflicts-with-manifest")
    note(
      "advisory/identity-conflict",
      "warning",
      `Advisories were queried for the requested identity ${identity.requested.name}@${identity.requested.version}, which conflicts with the artifact manifest ${text(identity.declared.name, 214)}@${text(identity.declared.version, 256)}; the declared identity was not screened.`,
    );
  else if (
    advisories &&
    identity.identityStatus === "claimed-manifest-unavailable"
  )
    note(
      "advisory/identity-unverified",
      "note",
      `Advisories were queried for the requested identity ${identity.requested.name}@${identity.requested.version}; the artifact manifest is unavailable, so the binding to the analyzed bytes is unverified.`,
    );
  if (results.length > MAX_RESULTS)
    note(
      "export/results-truncated",
      "warning",
      `Only the first ${MAX_RESULTS} of ${results.length} results are exported.`,
    );
  note(
    "limitation/absence-not-safety",
    "note",
    "Absence of results does not establish that the package is safe; only recorded evidence, deterministic policy rules and the supplied advisory snapshot are reported.",
  );
  return {
    report,
    identity,
    advisories,
    results: results.slice(0, MAX_RESULTS),
    limitations,
  };
}

function ruleDescriptor(ruleId, level) {
  const known = RULES[ruleId];
  return {
    id: ruleId,
    name: ruleId.replace(/[^A-Za-z0-9]+(.)?/g, (_, next = "") =>
      next.toUpperCase(),
    ),
    shortDescription: {
      text: known?.[1] ?? "Analyzer review cue; behavior is not proven.",
    },
    defaultConfiguration: { level: known?.[0] ?? level },
    properties: { tags: ["security", "supply-chain", ruleId.split("/")[0]] },
  };
}

export function toSarif(input, details) {
  const collected = collectFindings(input, details);
  const { report, identity, advisories, results, limitations } = collected;
  const ruleIds = [...new Set(results.map((item) => item.ruleId))].sort();
  const rules = ruleIds.map((id) =>
    ruleDescriptor(id, results.find((item) => item.ruleId === id).level),
  );
  const index = new Map(ruleIds.map((id, position) => [id, position]));
  return {
    $schema: SARIF_SCHEMA,
    version: SARIF_VERSION,
    runs: [
      {
        tool: {
          driver: {
            name: "unmask",
            version: text(report.analyzerVersion, 64),
            informationUri: "https://github.com/Vaiditya2207/unmask",
            rules,
          },
        },
        originalUriBaseIds: {
          ARTIFACT_ROOT: {
            description: {
              text: "Root of the analyzed npm artifact after removing its archive prefix.",
            },
          },
          SOURCE_ROOT: {
            description: {
              text: "Root of the selected source archive after removing its archive prefix.",
            },
          },
        },
        invocations: [
          {
            executionSuccessful: report.failures.length === 0,
            toolExecutionNotifications: limitations.map((item) => ({
              descriptor: { id: item.id },
              level: item.level,
              message: { text: item.message },
            })),
          },
        ],
        results: results.map((item) => ({
          ruleId: item.ruleId,
          ruleIndex: index.get(item.ruleId),
          level: item.level,
          message: { text: item.message },
          ...(item.locations.length
            ? {
                locations: item.locations.map((location) => ({
                  physicalLocation: {
                    artifactLocation: {
                      uri: location.path
                        .split("/")
                        .map(encodeURIComponent)
                        .join("/"),
                      uriBaseId:
                        location.side === "artifact"
                          ? "ARTIFACT_ROOT"
                          : "SOURCE_ROOT",
                    },
                    region: {
                      byteOffset: location.byteOffset,
                      byteLength: location.byteLength,
                    },
                  },
                })),
              }
            : item.package
              ? {
                  locations: [
                    {
                      logicalLocations: [
                        {
                          fullyQualifiedName: `npm:${item.package.name}@${item.package.version}`,
                          kind: "module",
                        },
                      ],
                    },
                  ],
                }
              : {}),
          partialFingerprints: { "unmaskFinding/v1": item.fingerprint },
          properties: {
            evidenceIds: item.evidenceIds,
            ...(item.advisoryId
              ? {
                  advisoryId: item.advisoryId,
                  aliases: item.aliases,
                  malwareIdentifier: item.malwareIdentifier,
                  severity: item.severity,
                }
              : {}),
            ...(item.unmappedEvidence
              ? { unmappedEvidence: item.unmappedEvidence }
              : {}),
          },
        })),
        properties: {
          unmask: {
            reportSchemaVersion: report.schemaVersion,
            policyVersion: report.policyVersion,
            policyExitCode: report.policy.exitCode,
            package: identity,
            artifactSha256: report.inputs.artifact.sha256,
            coverageComplete: report.coverage.complete,
            sourceStatus: report.source.status,
            modelStatus: text(report.model.status, 64),
            advisories: advisories
              ? {
                  status: advisories.status,
                  complete: advisories.complete,
                  queriedAt: advisories.queriedAt,
                  count: advisories.advisories.length,
                  boundTo: advisories.boundTo,
                }
              : { status: "not-supplied", complete: false },
          },
        },
      },
    ],
  };
}
