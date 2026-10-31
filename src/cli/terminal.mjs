const states = ["byte-identical", "changed", "artifact-only", "not-compared"];
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const list = (value) => (Array.isArray(value) ? value : []);
const count = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? value : 0;

export function safeText(value, max = 160) {
  const text = String(value ?? "").replace(
    /[\u0000-\u001f\u007f-\u009f\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return text.length > max ? text.slice(0, max - 1) + "..." : text;
}

export function formatBytes(bytes) {
  const value = count(bytes);
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB"];
  let scaled = value / 1024;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit++;
  }
  return `${scaled.toFixed(1)} ${units[unit]}`;
}

function identity(report) {
  const claim = report.inputs?.claim;
  const manifest = report.manifests?.artifact?.value;
  const name = claim?.name ?? manifest?.name;
  const version = claim?.version ?? manifest?.version;
  return name && version ? `${name}@${version}` : "local artifact";
}

function verdict(exitCode) {
  if (exitCode === 0)
    return "No deterministic findings in the inspected scope (exit 0)";
  if (exitCode === 3) return "Deterministic findings need review (exit 3)";
  return "Incomplete analysis; no verdict is claimed (exit 2)";
}

function coverageLines(report) {
  const coverage = report.coverage ?? {};
  const inventory = coverage.inventory ?? {};
  const totals = states
    .map((state) => `${count(coverage.states?.[state]?.files)} ${state}`)
    .join(", ");
  const lines = [
    `Coverage  ${coverage.complete ? "complete" : "incomplete"}: ${inventory.lowerBound ? "at least " : ""}${count(inventory.files)} file${count(inventory.files) === 1 ? "" : "s"}, ${formatBytes(inventory.bytes)}`,
    `          ${totals}`,
  ];
  const source = report.source ?? {};
  const commit =
    typeof source.commit === "string"
      ? ` at ${source.commit.slice(0, 12)}`
      : "";
  lines.push(
    `Source    ${safeText(source.status ?? "unknown")} via ${safeText(source.method ?? "unknown")}${safeText(commit)}${coverage.sourceAvailable === false ? " (no source compared)" : ""}`,
  );
  return lines;
}

function findingLines(report) {
  const findings = list(report.policy?.findings);
  const failures = list(report.failures);
  const lines = [];
  if (findings.length) {
    lines.push(`Findings  ${findings.length}`);
    for (const finding of findings.slice(0, 10)) {
      const detail = finding.script
        ? ` (script ${finding.script})`
        : finding.fields
          ? ` (${list(finding.fields).join(", ")})`
          : "";
      lines.push(`  - ${safeText(finding.ruleId)}${safeText(detail)}`);
    }
    if (findings.length > 10)
      lines.push(`  ... ${findings.length - 10} more in the full report`);
  } else lines.push("Findings  none");
  if (failures.length) {
    lines.push(`Failures  ${failures.length}`);
    for (const failure of failures.slice(0, 5))
      lines.push(
        `  - ${safeText(failure.code ?? "failure")}${failure.path ? ` ${safeText(failure.path, 80)}` : ""}`,
      );
    if (failures.length > 5)
      lines.push(`  ... ${failures.length - 5} more in the full report`);
  }
  return lines;
}

function modelLines(model) {
  if (!object(model)) return ["AI        not reported"];
  if (model.status === "complete") {
    const hypotheses = list(model.hypotheses);
    const lines = [
      `AI        complete, ${hypotheses.length} ${hypotheses.length === 1 ? "hypothesis" : "hypotheses"} (separate from deterministic evidence)`,
    ];
    if (typeof model.summary === "string")
      lines.push(`  Summary: ${safeText(model.summary, 600)}`);
    const assessment = model.assessment;
    if (object(assessment) && assessment.source === "model") {
      if (typeof assessment.checkedScope === "string")
        lines.push(`  Scope: ${safeText(assessment.checkedScope, 200)}`);
      if (typeof assessment.uncertainty === "string")
        lines.push(`  Uncertainty: ${safeText(assessment.uncertainty, 200)}`);
    }
    for (const hypothesis of hypotheses.slice(0, 3))
      lines.push(`  - ${safeText(hypothesis?.explanation, 200)}`);
    if (hypotheses.length > 3)
      lines.push(`  ... ${hypotheses.length - 3} more in the full report`);
    return lines;
  }
  const reason = model.reason ? ` (${safeText(model.reason, 60)})` : "";
  return [
    `AI        ${safeText(model.status, 40)}${reason}; no AI summary for this check`,
  ];
}

function advisoryLines(details) {
  const check = details?.vulnerabilityCheck;
  if (!object(check)) return ["Advisory  not assessed in this check"];
  const advisories = list(check.advisories);
  if (check.status === "found") {
    const lines = [
      `Advisory  ${advisories.length} known for this exact version (${safeText(check.source ?? "OSV", 20)})`,
    ];
    for (const item of advisories.slice(0, 5)) {
      const label =
        typeof item?.databaseSeverity === "string"
          ? ` [${item.databaseSeverity}]`
          : "";
      lines.push(
        `  - ${safeText(item?.id, 64)}${safeText(label, 24)} ${safeText(item?.summary ?? "", 120)}`.trimEnd(),
      );
    }
    if (advisories.length > 5)
      lines.push(`  ... ${advisories.length - 5} more in the full details`);
    return lines;
  }
  if (check.status === "none-reported")
    return [
      `Advisory  none reported by ${safeText(check.source ?? "OSV", 20)} for this exact version`,
    ];
  const reasons = list(check.reasons)
    .slice(0, 3)
    .map((r) => safeText(r, 40));
  return [
    `Advisory  ${safeText(check.status ?? "unavailable", 30)}${reasons.length ? ` (${reasons.join(", ")})` : ""}`,
  ];
}

function nextActions(report, { details, outDir }) {
  const actions = [];
  const exitCode = report.policy?.exitCode;
  if (details?.vulnerabilityCheck?.status === "found")
    actions.push(
      "Known advisories exist: do not install this version until each advisory is reviewed.",
    );
  if (exitCode === 3)
    actions.push(
      "Review each finding and its cited evidence before installing.",
    );
  if (exitCode === 2)
    actions.push(
      "Coverage is incomplete: treat this as unverified and retry or inspect the failures.",
    );
  if (exitCode === 0)
    actions.push(
      "No deterministic finding is not proof of safety; review advisories and AI notes.",
    );
  const assessment = report.model?.assessment;
  if (
    report.model?.status === "complete" &&
    assessment?.source === "model" &&
    typeof assessment.nextAction === "string"
  )
    actions.push(`AI suggests: ${safeText(assessment.nextAction, 200)}`);
  if (report.model?.status !== "complete")
    actions.push(
      "AI explanation was not produced; rely on deterministic evidence only.",
    );
  actions.push(
    outDir
      ? `Open ${safeText(outDir, 200)}/report.html for full evidence.`
      : "Add --out DIR to save the full JSON and HTML evidence.",
  );
  return actions;
}

export function renderCheckSummary(report, { details, outDir } = {}) {
  const lines = [
    `UNMASK ${safeText(identity(report), 120)}`,
    `Result    ${verdict(report.policy?.exitCode)}`,
    ...coverageLines(report),
    ...findingLines(report),
    ...advisoryLines(details),
    ...modelLines(report.model),
    "Next",
    ...nextActions(report, { details, outDir }).map(
      (action) => `  - ${action}`,
    ),
  ];
  return lines.join("\n") + "\n";
}
