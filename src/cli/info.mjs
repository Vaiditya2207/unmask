import { parsePackageSpec, AcquisitionError } from "../core/acquire.mjs";
import { LocalInputError } from "../core/pipeline.mjs";
import { getHostedDetails } from "./hosted.mjs";

export function terminalText(value, max = 2048) {
  const text =
    typeof value === "string" ? value : (JSON.stringify(value) ?? "unknown");
  const escaped = text.replace(
    /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g,
    (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"),
  );
  return escaped.length > max
    ? escaped.slice(0, max) + "… [truncated]"
    : escaped;
}

export function exactPackage(spec) {
  try {
    return parsePackageSpec(spec);
  } catch (error) {
    if (error instanceof AcquisitionError)
      throw new LocalInputError(error.code, error.message);
    throw error;
  }
}

export function hostedOptions(runtime) {
  return {
    serverUrl: (runtime.env ?? process.env).UNMASK_SERVER_URL,
    fetchImpl: runtime.fetchImpl,
    signal: runtime.signal,
    limits: runtime.hostedLimits,
  };
}

function rows(list, render, max = 100) {
  const items = list?.items ?? [];
  const lines = items.slice(0, max).map(render);
  const omitted = (list?.omitted ?? 0) + Math.max(0, items.length - max);
  if (omitted)
    lines.push(`  ${omitted} entries omitted by hosted/terminal limits.`);
  return lines;
}

export function renderInfo({ details, report, reportUrl }) {
  const claim = report.inputs.claim;
  const text = terminalText;
  const lines = [
    `UNMASK info ${text(claim.name)}@${text(claim.version)}`,
    "Publisher declarations (runtime behavior unverified):",
    ...rows(
      details.declarations.fields,
      (item) =>
        `  ${text(item.field)}: ${text(item.status === "declared" ? item.value : item.status)}`,
    ),
    "Scripts (never executed):",
    `  Status: ${text(details.scripts.status)}`,
    ...rows(
      details.scripts.entries,
      (item) =>
        `  ${text(item.name)}: ${text(item.value)}${item.installHook ? " [install hook]" : ""}`,
    ),
    "Dependencies (declared only; transitive dependencies not assessed):",
  ];
  for (const category of details.dependencies.categories)
    lines.push(
      `  ${text(category.field)}: ${text(category.status)}; declared=${text(category.declaredCount)}`,
      ...rows(
        category.entries,
        (item) =>
          `    ${text(item.name)}${Object.hasOwn(item, "value") ? ": " + text(item.value) : ""} [${text(item.status)}]`,
      ),
    );
  lines.push(
    "Provenance (report-recorded verification status):",
    ...rows(
      details.provenance.facts,
      (item) => `  ${text(item.field)}: ${text(item.value)}`,
    ),
  );
  const check = details.vulnerabilityCheck;
  lines.push(
    `OSV exact-package query: ${text(check?.status ?? "not-assessed")}; complete=${check?.complete === true}`,
  );
  if (check?.queriedAt) lines.push(`  Queried at: ${text(check.queriedAt)}`);
  if (check?.reasons?.length) lines.push(`  Reasons: ${text(check.reasons)}`);
  const advisories = check?.advisories ?? [];
  for (const item of advisories.slice(0, 100))
    lines.push(
      `  ${text(item?.id)}: ${text(item?.summary ?? "No summary recorded")}`,
    );
  if (advisories.length > 100)
    lines.push(
      `  ${advisories.length - 100} advisory records omitted from terminal output.`,
    );
  lines.push(
    `AI: ${text(report.model.status)}${report.model.reason ? " (" + text(report.model.reason) + ")" : ""}`,
    `Inventory complete: ${details.inventory.complete === true}; coverage complete: ${report.coverage.complete === true}`,
    "This is not a safety verdict. No findings never means safe; missing or omitted facts remain unassessed.",
    `Report: ${text(reportUrl)}`,
  );
  return lines.join("\n") + "\n";
}

export async function infoCommand(args, runtime = {}) {
  if (args.length !== 1)
    throw new LocalInputError("usage", "Use info name@exact-version");
  exactPackage(args[0]);
  const result = await getHostedDetails(args[0], hostedOptions(runtime));
  (runtime.stdout ?? process.stdout).write(renderInfo(result));
  return 0;
}
