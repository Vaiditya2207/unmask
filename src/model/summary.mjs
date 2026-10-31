export const SUMMARY_POLICY = "every-check-1";
const SUMMARY_TEMPLATE = "≤600 chars";
const SUMMARY_TASK =
  " Ground summary in scope and evidence; no safety verdicts.";
const VERDICT =
  /\b(?:(?:un)?safe(?:ly|ty)?|benign|harmless|malware-free|risk-free|trustworthy|no risks?)\b/iu;
// Only exact caveat templates may mention safety; any other negation still counts as a verdict.
const CAVEAT =
  /\bnot (?:a |an )?(?:proof|evidence|guarantee|indication)(?: that)?(?: (?:the|this) package| it)?(?: is)? safe\b|\b(?:not a|no) safety (?:verdict|signal|claim|guarantee)\b|\bdoes not (?:mean|imply|prove|establish|show) (?:that )?(?:it|the package|this package) is safe\b/giu;
const ABSENCE_CLAIM =
  /\b(?:absent|missing|lacks?|omits?)\b|does not (?:exist|contain|include)|not (?:present|in)\b|not found(?! within supplied evidence)/iu;
const SCOPED_ABSENCE =
  /\b(?:absent|missing|not (?:present|found|in))\s+(?:(?:from|in|within)\s+)?(?:the\s+)?(?:selected source|supplied (?:evidence|scope))\b|\bsource(?: archive)? (?:is|was) (?:missing|absent)\b|\bomits?\s+\d+\s+(?:evidence\s+)?(?:items?|groups?)\b/giu;
const counter = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? value : null;
const ruleIds = (items) =>
  [
    ...new Set(
      items
        .map((item) => item?.ruleId)
        .filter(
          (id) => typeof id === "string" && /^[a-z0-9-]{1,64}$/u.test(id),
        ),
    ),
  ].sort();
const list = (value) => (Array.isArray(value) ? value : []);

export function scopeFor(report, bundle) {
  const files = list(report.files);
  const states = {};
  for (const file of files) {
    const state = /^[a-z-]{1,32}$/u.test(file?.state ?? "")
      ? file.state
      : "other";
    states[state] = (states[state] ?? 0) + 1;
  }
  const coverage = report.coverage ?? {};
  const findings = list(report.policy?.findings);
  const cues = list(report.cues);
  const supplied = new Set(list(bundle.evidenceGroups).map((g) => g.ruleId));
  const scope = {
    files: files.length,
    states,
    inventory: counter(coverage.inventory?.files),
    complete: coverage.inventory?.complete === true,
    compared: counter(coverage.compared?.files),
    syntax: counter(coverage.syntaxInspected?.files),
    source: /^[a-z-]{1,32}$/u.test(report.source?.status ?? "")
      ? report.source.status
      : "unknown",
    exit: counter(report.policy?.exitCode),
    findings: findings.length,
    cues: cues.length,
    // Rule IDs already named by a supplied group are not repeated.
    unseenRules: ruleIds([...findings, ...cues])
      .filter((id) => !supplied.has(id))
      .slice(0, 6),
    supplied: bundle.selected.size,
    omitted: bundle.omittedEvidenceIds.length,
  };
  for (const [key, value] of Object.entries(scope))
    if (value === null || (Array.isArray(value) && !value.length))
      delete scope[key];
  return scope;
}

export function summaryBundle(promptFor, report, inputLimit) {
  let limit = inputLimit;
  for (let pass = 0; pass < 6; pass++) {
    const bundle = promptFor(report, limit);
    const scope = scopeFor(report, bundle);
    const payload = JSON.parse(bundle.prompt);
    const prompt = JSON.stringify({
      ...payload,
      task: payload.task + SUMMARY_TASK,
      output: {
        summary: SUMMARY_TEMPLATE,
        ...payload.output,
      },
      scope,
    });
    const over = Buffer.byteLength(prompt) + 256 - inputLimit;
    if (over <= 0 || pass === 5) return { ...bundle, prompt, scope };
    // Repack below the bytes actually used so each pass strictly shrinks evidence.
    limit = Math.min(limit, Buffer.byteLength(bundle.prompt) + 256) - over;
  }
}

function prose(value, max, secret) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= max &&
    !value.includes(secret) &&
    !VERDICT.test(value.replace(CAVEAT, " ")) &&
    !ABSENCE_CLAIM.test(value.replace(SCOPED_ABSENCE, " "))
  );
}

export function validSummary(value, secret) {
  return prose(value, 600, secret);
}
