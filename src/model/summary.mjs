export const SUMMARY_POLICY = "every-check-2";
const SUMMARY_TEMPLATE = "≤600 chars";
const SUMMARY_TASK =
  " Ground summary and assessment in scope and evidence; no safety verdicts.";
const ASSESSMENT_TEMPLATE = {
  uncertainty: "unchecked ≤300",
  nextAction: "review step ≤200",
};
const VERDICT =
  /\b(?:(?:un)?safe(?:ly|ty)?|benign|harmless|malware-free|risk-free|trustworthy|no risks?)\b/iu;
// Only exact caveat templates may mention safety; any other negation still counts as a verdict.
const CAVEAT =
  /\bnot (?:a |an )?(?:proof|evidence|guarantee|indication)(?: that)?(?: (?:the|this) package| it)?(?: is)? safe\b|\b(?:not a|no) safety (?:verdict|signal|claim|guarantee)\b|\bdoes not (?:mean|imply|prove|establish|show) (?:that )?(?:it|the package|this package) is safe\b/giu;
const ABSENCE_CLAIM =
  /\b(?:absent|missing|lacks?|omits?)\b|does not (?:exist|contain|include)|not (?:present|in)\b|not found(?! within supplied evidence)/iu;
const SCOPED_ABSENCE =
  /\b(?:absent|missing|not (?:present|found|in))\s+(?:(?:from|in|within)\s+)?(?:the\s+)?(?:selected source|supplied (?:evidence|scope))\b|\bsource(?: archive)? (?:is|was) (?:missing|absent)\b|\bomits?\s+\d+\s+(?:evidence\s+)?(?:items?|groups?)\b/giu;
const REVIEW_STEP =
  /^(?:review|inspect|compare|confirm|verify|check|locate|examine|trace|investigate|read|diff|audit)\b/iu;
const GO_AHEAD =
  /\b(?:proceed|go ahead|approve|ok(?:ay)? to|fine to|safe to|allow(?:ed)? to install)\b/iu;
const CONTROL =
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const FENCE = /^\s*```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```\s*$/u;
export const hasControl = (value) => CONTROL.test(value);
// One whole-body code fence is unwrapped; JSON embedded in other prose is still rejected.
export const unfence = (raw) => FENCE.exec(raw)?.[1] ?? raw;
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
        assessment: ASSESSMENT_TEMPLATE,
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
    !hasControl(value) &&
    !VERDICT.test(value.replace(CAVEAT, " ")) &&
    !ABSENCE_CLAIM.test(value.replace(SCOPED_ABSENCE, " "))
  );
}

const NONE = "(?:no|zero|0|without(?: any)?)\\s+";
const UNLOCALIZED = "(?!\\s+(?:in|for|on|within)\\b)";
const NO_FINDINGS = new RegExp(
  `\\b${NONE}(?:default\\s+)?(?:policy\\s+)?findings?\\b${UNLOCALIZED}`,
  "iu",
);
const NO_CUES = new RegExp(
  `\\b${NONE}(?:review\\s+)?(?:cues?|suggestions?|observations?)\\b${UNLOCALIZED}`,
  "iu",
);
const ALL_SAME = new RegExp(
  `\\b(?:all|every|each)\\b[^.;]{0,40}?\\b(?:byte-identical|identical|unchanged|match(?:es|ed)?)\\b|\\b(?:no|zero)\\s+(?:file\\s+)?(?:changes?|differences?)\\b${UNLOCALIZED}|\\bno\\s+files?\\s+(?:changed|differ(?:s|ed)?)\\b|\\bnothing\\s+(?:changed|differs)\\b`,
  "iu",
);
// Whole-report claims must not contradict the deterministic scope the model was given.
export function consistentWithScope(value, scope = {}) {
  const states = scope.states ?? {};
  const differs = Object.keys(states).some(
    (state) => state !== "byte-identical" && states[state] > 0,
  );
  return !(
    (scope.findings > 0 && NO_FINDINGS.test(value)) ||
    (scope.cues > 0 && NO_CUES.test(value)) ||
    (differs && ALL_SAME.test(value))
  );
}

export function validSummary(value, secret, scope) {
  return prose(value, 600, secret) && consistentWithScope(value, scope);
}

export function validAssessment(value, secret) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 2 &&
    prose(value.uncertainty, 300, secret) &&
    prose(value.nextAction, 200, secret) &&
    REVIEW_STEP.test(value.nextAction.trim()) &&
    !GO_AHEAD.test(value.nextAction)
  );
}

export function checkedScopeFor(bundle) {
  const { scope } = bundle;
  const notChecked = ["runtime-behavior"];
  if (scope.omitted) notChecked.push("omitted-evidence");
  if (!scope.complete) notChecked.push("incomplete-inventory");
  if (!["selected", "resolved"].includes(scope.source))
    notChecked.push("unselected-source");
  for (const [key, code] of [
    ["compared", "uncompared-files"],
    ["syntax", "uninspected-syntax"],
  ])
    if (!(scope[key] >= (scope.inventory ?? 0))) notChecked.push(code);
  return {
    basis: "deterministic-prompt-selection",
    evidenceSupplied: scope.supplied,
    evidenceOmitted: scope.omitted,
    groupsSupplied: bundle.evidenceGroups.length,
    groupsOmitted: bundle.omittedEvidenceGroups.length,
    paths: [...new Set([...bundle.selected.values()].map((e) => e.path))]
      .sort()
      .slice(0, 16),
    notChecked,
  };
}
