import { parsePackageSpec } from "./acquire.mjs";
import { validateReport } from "./report.mjs";

export const GUARD_POLICY_VERSION = "guard-1";
const hardRules = new Set([
  "integrity-mismatch",
  "provenance-verification-failed",
  "identity-claim-conflict",
]);
const identifier = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9:_.-]{1,256}$/.test(value);
const samePackage = (value, expected) =>
  value?.name === expected.name && value?.version === expected.version;
const malwareId = (value) => /^MAL-\d{4}-\d+$/i.test(value);

export function evaluateGuardDecision({
  nameAtExactVersion,
  report,
  vulnerabilityCheck,
} = {}) {
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
  const validRecords = records.filter(
    (record) =>
      identifier(record?.id) &&
      Array.isArray(record.aliases) &&
      record.aliases.length <= 16 &&
      record.aliases.every(identifier) &&
      (record.withdrawn === undefined ||
        (typeof record.withdrawn === "string" &&
          Number.isFinite(Date.parse(record.withdrawn)))),
  );
  const advisoriesComplete = Boolean(
    advisoryIdentity &&
    check.complete === true &&
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
    .filter((record) => [record.id, ...record.aliases].some(malwareId))
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
  for (const record of ordinary)
    reasons.push({ code: "known-vulnerability", advisoryId: record.id });
  const modelStatus = validReport ? report.model.status : "unavailable";
  const aiReviewConcern =
    validReport &&
    modelStatus === "complete" &&
    Array.isArray(report.model.hypotheses) &&
    report.model.hypotheses.some(
      (hypothesis) => hypothesis.category === "review-concern",
    );
  if (aiReviewConcern)
    reasons.push({ code: "ai-review-concern", binding: false });
  const complete = artifactComplete && sourceComplete && advisoriesComplete;
  const decision =
    knownMalware.length ||
    findings.some((finding) => hardRules.has(finding.ruleId))
      ? "block"
      : !complete
        ? "unknown"
        : findings.length || ordinary.length || aiReviewConcern
          ? "warn"
          : "allow";
  return {
    decisionVersion: "1",
    policyVersion: GUARD_POLICY_VERSION,
    profile: "balanced",
    package: { ecosystem: "npm", ...identity },
    decision,
    permitted: ["allow", "warn"].includes(decision),
    enforcement: "enforce",
    reasons,
    knownMalware,
    policyExitCode: validReport ? report.policy.exitCode : null,
    assessment: {
      complete,
      artifactComplete,
      sourceComplete,
      advisoriesComplete,
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
