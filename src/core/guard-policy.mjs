import { parsePackageSpec } from "./acquire.mjs";
import { validateReport } from "./report.mjs";

export const GUARD_POLICY_VERSION = "guard-2";
export const GUARD_PROFILES = Object.freeze({
  strict: Object.freeze({
    unknownDecision: "block",
    blockSeverity: "medium",
    enforcement: "enforce",
  }),
  balanced: Object.freeze({
    unknownDecision: "unknown",
    blockSeverity: "high",
    enforcement: "enforce",
  }),
  audit: Object.freeze({
    unknownDecision: "unknown",
    blockSeverity: "critical",
    enforcement: "audit",
  }),
});
export function getGuardProfile(profile = "strict") {
  if (typeof profile !== "string" || !Object.hasOwn(GUARD_PROFILES, profile))
    throw new TypeError("Unknown guard profile; use strict, balanced or audit");
  return GUARD_PROFILES[profile];
}
const severityOrder = ["unknown", "low", "medium", "high", "critical"];
function advisorySeverity(record, identity) {
  const values = [record.databaseSeverity];
  if (Array.isArray(record.affected)) {
    for (const affected of record.affected.slice(0, 8)) {
      if (
        affected?.package?.ecosystem === "npm" &&
        affected.package.name === identity.name
      )
        values.push(affected.ecosystemSeverity);
    }
  }
  let rank = 0;
  for (const value of values) {
    if (typeof value !== "string" || value.length > 64) continue;
    const normalized =
      value.toLowerCase() === "moderate" ? "medium" : value.toLowerCase();
    rank = Math.max(rank, severityOrder.indexOf(normalized));
  }
  return severityOrder[rank];
}
const identifier = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9:_.-]{1,256}$/.test(value);
const samePackage = (value, expected) =>
  value?.name === expected.name && value?.version === expected.version;
const historicalMalware = new Map([
  [
    "GHSA-pjwm-rvh2-c87w",
    { name: "ua-parser-js", versions: ["0.7.29", "0.8.0", "1.0.0"] },
  ],
  ["GHSA-mh6f-8j2x-4483", { name: "event-stream", versions: ["3.3.6"] }],
  ["GHSA-97m3-w2cp-4xx6", { name: "node-ipc", versions: ["10.1.1", "10.1.2"] }],
]);
function malwareId(value, identity) {
  if (/^MAL-\d{4}-\d+$/i.test(value)) return true;
  const incident = historicalMalware.get(value);
  return (
    incident?.name === identity.name &&
    incident.versions.includes(identity.version)
  );
}

function validAdvisoryRecord(record) {
  return (
    identifier(record?.id) &&
    Array.isArray(record.aliases) &&
    record.aliases.length <= 16 &&
    record.aliases.every(identifier) &&
    (record.withdrawn === undefined ||
      (typeof record.withdrawn === "string" &&
        Number.isFinite(Date.parse(record.withdrawn))))
  );
}

export function classifyGuardAdvisory(record, packageIdentity) {
  let identity;
  try {
    if (packageIdentity?.ecosystem !== "npm")
      throw new TypeError("Invalid ecosystem");
    identity = parsePackageSpec(
      `${packageIdentity.name}@${packageIdentity.version}`,
    );
  } catch {
    throw new TypeError(
      "Advisory classification requires an exact npm package identity",
    );
  }
  if (!validAdvisoryRecord(record))
    return {
      id: identifier(record?.id) ? record.id : null,
      status: "invalid",
      knownMalware: false,
      severity: "unknown",
    };
  const active = record.withdrawn === undefined;
  return {
    id: record.id,
    status: active ? "active" : "withdrawn",
    knownMalware:
      active &&
      [record.id, ...record.aliases].some((id) => malwareId(id, identity)),
    severity: active ? advisorySeverity(record, identity) : "unknown",
  };
}

export function evaluateGuardDecision(
  { nameAtExactVersion, report, vulnerabilityCheck } = {},
  { profile = "strict" } = {},
) {
  const policy = getGuardProfile(profile);
  let identity;
  try {
    identity = parsePackageSpec(nameAtExactVersion);
  } catch {
    throw new TypeError("Guard requires an exact npm package identity");
  }
  const reasons = [];
  let validReport = false;
  if (report) {
    try {
      validateReport(report);
      validReport = samePackage(report.inputs.claim, identity);
      if (!validReport) reasons.push({ code: "report-identity-mismatch" });
    } catch {
      reasons.push({ code: "invalid-report" });
    }
  } else reasons.push({ code: "report-unavailable" });
  const artifactComplete =
    validReport &&
    report.coverage.inventory.complete === true &&
    report.coverage.complete === true &&
    report.failures.length === 0;
  const sourceComplete =
    validReport &&
    report.coverage.sourceAvailable === true &&
    report.coverage.sourceComplete === true &&
    report.source.complete === true &&
    ["selected", "resolved"].includes(report.source.status) &&
    !["unresolved", "conflicting"].includes(report.source.method);
  if (!artifactComplete)
    reasons.push({ code: "artifact-assessment-incomplete" });
  if (!sourceComplete) reasons.push({ code: "source-assessment-incomplete" });
  const check = vulnerabilityCheck;
  const advisoryIdentity =
    check?.source === "OSV" &&
    check.schemaVersion === "1" &&
    check.package?.ecosystem === "npm" &&
    samePackage(check.package, identity);
  const records =
    advisoryIdentity &&
    Array.isArray(check.advisories) &&
    check.advisories.length <= 100
      ? check.advisories
      : [];
  const validRecords = records.filter(validAdvisoryRecord);
  const advisoriesComplete = Boolean(
    advisoryIdentity &&
    check.complete === true &&
    typeof check.queriedAt === "string" &&
    Number.isFinite(Date.parse(check.queriedAt)) &&
    Number.isSafeInteger(check.pagesFetched) &&
    check.pagesFetched > 0 &&
    check.limits !== null &&
    typeof check.limits === "object" &&
    !Array.isArray(check.limits) &&
    ["found", "none-reported"].includes(check.status) &&
    Array.isArray(check.reasons) &&
    check.reasons.length === 0 &&
    Array.isArray(check.advisories) &&
    records.length === check.advisories.length &&
    validRecords.length === records.length &&
    (check.status === "found" ? records.length > 0 : records.length === 0),
  );
  if (!advisoriesComplete)
    reasons.push({ code: "advisory-assessment-incomplete" });
  const active = validRecords.filter(
    (record) => record.withdrawn === undefined,
  );
  const knownMalware = active
    .filter(
      (record) =>
        classifyGuardAdvisory(record, { ecosystem: "npm", ...identity })
          .knownMalware,
    )
    .map((record) => ({ id: record.id, aliases: [...record.aliases] }));
  for (const record of knownMalware)
    reasons.push({
      code: "known-malware",
      advisoryId: record.id,
      aliases: record.aliases,
    });
  const findings = validReport ? report.policy.findings : [];
  for (const finding of findings.slice(0, 100))
    reasons.push({
      code: "deterministic-finding",
      ruleId: finding.ruleId,
      evidenceIds: finding.evidenceIds.slice(0, 16),
    });
  const ordinary = active.filter(
    (record) => !knownMalware.some((item) => item.id === record.id),
  );
  const severities = ordinary.map((record) => ({
    id: record.id,
    severity: advisorySeverity(record, identity),
  }));
  for (const record of severities)
    reasons.push({
      code: "known-vulnerability",
      advisoryId: record.id,
      severity: record.severity,
      severitySource: "OSV-declaration",
    });
  const advisorySeverityComplete = severities.every(
    (record) => record.severity !== "unknown",
  );
  const unknownSeverityBlock =
    profile === "strict" && !advisorySeverityComplete;
  if (unknownSeverityBlock) reasons.push({ code: "advisory-severity-unknown" });
  const severityBlock = severities.some(
    (record) =>
      severityOrder.indexOf(record.severity) >=
      severityOrder.indexOf(policy.blockSeverity),
  );
  const model = validReport ? report.model : null;
  const invalidModel =
    model?.status === "complete" &&
    (!Array.isArray(model.hypotheses) ||
      model.hypotheses.some(
        (item) =>
          !item ||
          !["possible-transformation", "review-concern", "unknown"].includes(
            item.category,
          ),
      ));
  const modelStatus = invalidModel
    ? "invalid-output"
    : (model?.status ?? "unavailable");
  const aiReviewConcern =
    validReport &&
    modelStatus === "complete" &&
    Array.isArray(report.model.hypotheses) &&
    report.model.hypotheses.some(
      (hypothesis) => hypothesis?.category === "review-concern",
    );
  if (aiReviewConcern)
    reasons.push({ code: "ai-review-concern", binding: false });
  const complete = artifactComplete && sourceComplete && advisoriesComplete;
  const decision =
    knownMalware.length ||
    findings.length ||
    severityBlock ||
    unknownSeverityBlock
      ? "block"
      : !complete
        ? policy.unknownDecision
        : ordinary.length || aiReviewConcern
          ? "warn"
          : "allow";
  if (!complete && policy.unknownDecision === "block")
    reasons.push({ code: "profile-unknown-blocked" });
  if (severityBlock)
    reasons.push({
      code: "profile-severity-blocked",
      threshold: policy.blockSeverity,
    });
  if (policy.enforcement === "audit")
    reasons.push({ code: "audit-no-enforcement" });
  return {
    decisionVersion: "1",
    policyVersion: GUARD_POLICY_VERSION,
    profile,
    appliedPolicy: { ...policy },
    package: { ecosystem: "npm", ...identity },
    artifact: validReport
      ? {
          sha256: report.inputs.artifact.sha256,
          sha512: report.inputs.artifact.sha512,
        }
      : null,
    decision,
    permitted:
      policy.enforcement === "audit" || ["allow", "warn"].includes(decision),
    enforcement: policy.enforcement,
    reasons,
    knownMalware,
    policyExitCode: validReport ? report.policy.exitCode : null,
    assessment: {
      complete,
      artifactComplete,
      sourceComplete,
      advisoriesComplete,
      advisorySeverityComplete,
      modelStatus,
      modelComplete: modelStatus === "complete",
    },
    limitations: [
      "Allow means this bounded static assessment found no policy blocker; it is not a safety guarantee.",
      "Assessment completeness covers the recorded artifact, source comparison and exact-version OSV lookup; model availability is reported separately and AI signals cannot permit or block installation.",
      "Package execution, transitive dependencies, freshness after this check and future registry changes are not assessed.",
    ],
  };
}
