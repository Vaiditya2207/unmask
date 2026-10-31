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

function advisoryItems(advisories) {
  const lines = advisories.slice(0, 5).map((item) => {
    const label =
      typeof item?.databaseSeverity === "string"
        ? ` [${item.databaseSeverity}]`
        : "";
    return `  - ${safeText(item?.id, 64)}${safeText(label, 24)} ${safeText(item?.summary ?? "", 120)}`.trimEnd();
  });
  if (advisories.length > 5)
    lines.push(`  ... ${advisories.length - 5} more in the full details`);
  return lines;
}

const knownAdvisories = (check) => list(check?.advisories).length > 0;

function advisoryLines(details) {
  const check = details?.vulnerabilityCheck;
  if (!object(check)) return ["Advisory  not assessed in this check"];
  const advisories = list(check.advisories);
  const source = safeText(check.source ?? "OSV", 20);
  if (check.status === "none-reported")
    return [`Advisory  none reported by ${source} for this exact version`];
  const reasons = list(check.reasons)
    .slice(0, 3)
    .map((r) => safeText(r, 40));
  const why = reasons.length ? ` (${reasons.join(", ")})` : "";
  if (check.status === "found")
    return [
      `Advisory  ${advisories.length} known for this exact version (${source})`,
      ...advisoryItems(advisories),
    ];
  if (advisories.length)
    return [
      `Advisory  ${advisories.length} known for this exact version so far; lookup ${safeText(check.status ?? "unavailable", 30)}${why}, more may exist (${source})`,
      ...advisoryItems(advisories),
    ];
  return [`Advisory  ${safeText(check.status ?? "unavailable", 30)}${why}`];
}

function nextActions(report, { details, outDir }) {
  const actions = [];
  const exitCode = report.policy?.exitCode;
  if (knownAdvisories(details?.vulnerabilityCheck))
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

export function renderAdvisoryOnly(
  result,
  spec,
  { style = terminalStyle() } = {},
) {
  const details = { vulnerabilityCheck: result.vulnerabilityCheck };
  const reason = result.artifactVerification?.reason;
  const found = knownAdvisories(result.vulnerabilityCheck);
  const lines = [
    `UNMASK ${safeText(spec, 120)}`,
    style.paint(
      found ? "yellow" : "red",
      "Result    Advisory-only: artifact not inspected; no verdict is claimed (exit 2)",
    ),
    `${style.paint("bold", "Artifact")}  not inspected${reason ? ` (${safeText(reason, 80)})` : ""}; source comparison not performed`,
    ...advisoryLines(details).map((line) =>
      line.startsWith("Advisory")
        ? style.paint("bold", "Advisory") + line.slice(8)
        : line,
    ),
    `${style.paint("bold", "AI")}        not run; no artifact evidence to explain`,
    `${style.paint("bold", "Notice")}    ${safeText(result.notice, 400)}`,
    style.paint("bold", "Next"),
    found
      ? "  - Known advisories exist: do not install this version until each advisory is reviewed."
      : "  - No current advisory is not evidence of safety; the artifact itself was not checked.",
    "  - Prefer a different exact version that UNMASK can fully analyze.",
  ];
  return lines.join("\n") + "\n";
}

const codes = { bold: 1, red: 31, yellow: 33, cyan: 36, dim: 2 };
const label =
  /^(UNMASK|Result|Coverage|Source|Findings|Failures|Advisory|AI|Next)\b/;

export function terminalStyle(stream, env = process.env) {
  const tty = stream?.isTTY === true && env.TERM !== "dumb";
  const color = tty && !env.NO_COLOR;
  return {
    tty,
    color,
    paint: (name, text) =>
      color ? `\u001b[${codes[name]}m${text}\u001b[0m` : text,
  };
}

function resultColor(report, details) {
  if (report.policy?.exitCode === 2) return "red";
  if (
    report.policy?.exitCode === 3 ||
    knownAdvisories(details?.vulnerabilityCheck)
  )
    return "yellow";
  return "bold";
}

export function renderCheckSummary(
  report,
  { details, outDir, style = terminalStyle() } = {},
) {
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
  const tone = resultColor(report, details);
  return (
    lines
      .map((line) => {
        const match = label.exec(line);
        if (!match) return line;
        const rest = line.slice(match[0].length);
        if (match[0] === "Result") return style.paint(tone, line);
        if (match[0] === "Advisory" && / known for /.test(rest))
          return style.paint("yellow", line);
        return style.paint("bold", match[0]) + rest;
      })
      .join("\n") + "\n"
  );
}

const frames = ["|", "/", "-", "\\"];
const phases = {
  submitting: "Submitting exact package to the hosted service",
  queued: "Queued on the hosted service",
  running: "Hosted analysis running",
  details: "Fetching package details and advisories",
  local: "Analyzing local artifact",
  model: "Requesting AI explanation",
  writing: "Writing report files",
};

export function createProgress(
  stream,
  { env = process.env, now = Date.now, intervalMs = 120, subject = "" } = {},
) {
  const style = terminalStyle(stream, env);
  const started = now();
  let phase,
    frame = 0,
    timer;
  const message = () =>
    `${phases[phase] ?? safeText(phase, 60)}${subject ? ` ${safeText(subject, 120)}` : ""}`;
  const draw = () => {
    const seconds = Math.floor((now() - started) / 1000);
    stream.write(
      `\r\u001b[2K${style.paint("cyan", frames[frame++ % frames.length])} ${message()} ${style.paint("dim", `${seconds}s`)}`,
    );
  };
  return {
    update(next) {
      if (next === phase) return;
      phase = next;
      if (!style.tty) {
        stream.write(`unmask: ${message()}\n`);
        return;
      }
      draw();
      if (!timer) {
        timer = setInterval(draw, intervalMs);
        timer.unref?.();
      }
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
      if (style.tty && phase !== undefined) stream.write("\r\u001b[2K");
    },
  };
}

const hints = {
  usage: "Run unmask check name@exact-version, or see docs/cli.md.",
  "unknown-option": "See docs/cli.md for the supported check options.",
  "missing-value": "Each option needs a value, for example --out ./report.",
  "output-write-failed":
    "Choose a fresh --out folder; existing report files are never replaced.",
  "hosted-unavailable": "Check your network or UNMASK_SERVER_URL, then retry.",
  "hosted-timeout": "Retry later; the hosted service may be busy.",
};

export function renderError(code, message, style) {
  const head = style.paint("red", `unmask error ${safeText(code, 60)}`);
  const hint = hints[code]
    ? `\n${style.paint("dim", `Hint: ${hints[code]}`)}`
    : "";
  return `${head}: ${safeText(message, 400)}${hint}\n`;
}
