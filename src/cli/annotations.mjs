import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { LocalInputError } from "../core/pipeline.mjs";
import { collectFindings } from "../core/sarif.mjs";
import { parseExportOptions, readExportInputs } from "./sarif.mjs";

const MAX_SUMMARY_ITEMS = 50;
const commands = { error: "error", warning: "warning", note: "notice" };
const visible = (value) =>
  String(value).replace(
    /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

export function escapeData(value) {
  return visible(value)
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
}

export function escapeProperty(value) {
  return escapeData(value).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

export function escapeMarkdown(value) {
  return visible(value)
    .replace(/[\r\n]+/g, " ")
    .replace(/[\\`*_{}[\]()<>#+!|~&"'=-]/g, (char) => `\\${char}`);
}

function where(result) {
  const spans = result.locations.map(
    (item) =>
      `${item.side} ${item.path} bytes ${item.byteOffset}-${item.byteOffset + item.byteLength}`,
  );
  return spans.length ? ` [${spans.join("; ")}]` : "";
}

export function annotationOutcome(collected) {
  const { report, advisories, results } = collected;
  let exitCode = report.policy.exitCode;
  const knownAdvisory = results.some((item) =>
    ["advisory/known-malware", "advisory/known-vulnerability"].includes(
      item.ruleId,
    ),
  );
  if (exitCode === 0 && knownAdvisory) exitCode = 3;
  if (exitCode === 0 && advisories && !advisories.complete) exitCode = 2;
  return exitCode;
}

export function renderAnnotations(collected) {
  const lines = [];
  for (const result of collected.results)
    lines.push(
      `::${commands[result.level]} title=${escapeProperty(`unmask ${result.ruleId}`)}::${escapeData(result.message + where(result))}`,
    );
  for (const item of collected.limitations)
    lines.push(
      `::${commands[item.level]} title=${escapeProperty(`unmask ${item.id}`)}::${escapeData(item.message)}`,
    );
  return lines.join("\n") + "\n";
}

export function renderSummary(collected, exitCode) {
  const { report, identity, advisories, results, limitations } = collected;
  const conflict = identity?.identityStatus === "claim-conflicts-with-manifest";
  const name = identity
    ? conflict
      ? `${identity.name}@${identity.version} (claimed; artifact declares ${identity.declared.name}@${identity.declared.version})`
      : `${identity.name}@${identity.version}`
    : "unidentified artifact";
  const count = (level) =>
    results.filter((item) => item.level === level).length;
  const lines = [
    `## UNMASK check: ${escapeMarkdown(name)}`,
    "",
    "| Item | Value |",
    "| --- | --- |",
    `| Exit code | ${exitCode} |`,
    `| Policy findings | ${report.policy.findings.length} |`,
    `| Coverage complete | ${report.coverage.complete ? "yes" : "no"} |`,
    `| Identity | ${escapeMarkdown(identity?.identityStatus ?? "unknown")} |`,
    `| Advisory check | ${escapeMarkdown(advisories ? `${advisories.status}${advisories.boundTo === "claim" && identity.identityStatus !== "claim-matches-manifest" ? " (for requested identity)" : ""}` : "not supplied")} |`,
    `| Results | ${count("error")} error, ${count("warning")} warning, ${count("note")} note |`,
    `| Artifact sha256 | \`${report.inputs.artifact.sha256}\` |`,
    "",
  ];
  if (results.length) {
    lines.push("### Results", "");
    for (const item of results.slice(0, MAX_SUMMARY_ITEMS))
      lines.push(
        `- **${item.level}** \`${item.ruleId}\`: ${escapeMarkdown(item.message + where(item))}`,
      );
    if (results.length > MAX_SUMMARY_ITEMS)
      lines.push(
        `- ${results.length - MAX_SUMMARY_ITEMS} more results omitted`,
      );
    lines.push("");
  }
  lines.push("### Limitations", "");
  for (const item of limitations)
    lines.push(`- ${item.level}: ${escapeMarkdown(item.message)}`);
  return lines.join("\n") + "\n\n";
}

async function appendSummary(filename, markdown) {
  let handle;
  try {
    handle = await open(
      filename,
      constants.O_WRONLY |
        constants.O_APPEND |
        constants.O_CREAT |
        constants.O_NONBLOCK |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    if (!(await handle.stat()).isFile()) throw new Error("not regular");
    await handle.writeFile(markdown);
  } catch {
    throw new LocalInputError(
      "output-write-failed",
      "Summary requires a regular, writable file path",
    );
  } finally {
    await handle?.close();
  }
}

export async function annotationsCommand(argv, stdout = process.stdout) {
  const options = parseExportOptions(argv, {
    "--report": "report",
    "--details": "details",
    "--summary": "summary",
  });
  const { report, details } = await readExportInputs(options);
  const collected = collectFindings(report, details);
  const exitCode = annotationOutcome(collected);
  if (options.summary !== undefined)
    await appendSummary(options.summary, renderSummary(collected, exitCode));
  stdout.write(renderAnnotations(collected));
  return exitCode;
}
