import { parsePackageSpec, AcquisitionError } from "../core/acquire.mjs";
import { LocalInputError } from "../core/pipeline.mjs";
import { checkHosted } from "./hosted.mjs";

const DEPENDENCY_FIELDS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
];
const LIFECYCLE = new Set(["preinstall", "install", "postinstall", "prepare"]);
const MAX_LISTED = 40;
const usage = () =>
  new LocalInputError(
    "usage",
    "Use compare OLD_NAME@VERSION NEW_NAME@VERSION [--json]",
  );
function exactSpec(spec) {
  try {
    return parsePackageSpec(spec);
  } catch (error) {
    if (error instanceof AcquisitionError)
      throw new LocalInputError(error.code, error.message);
    throw error;
  }
}
export function parseCompareArgs(argv) {
  const positional = [];
  let json = false;
  for (const value of argv) {
    if (value === "--json" && !json) json = true;
    else if (value.startsWith("--")) throw usage();
    else positional.push(value);
  }
  if (positional.length !== 2) throw usage();
  const [older, newer] = positional.map(exactSpec);
  if (older.name !== newer.name)
    throw new LocalInputError(
      "unrelated-packages",
      `Refusing to compare different package names (${older.name} vs ${newer.name}); renamed or forked packages are not treated as versions of one package.`,
    );
  if (older.version === newer.version)
    throw new LocalInputError(
      "same-version",
      "Compare requires two different exact versions",
    );
  return { specs: positional, json };
}
const manifestOf = (report) =>
  report.manifests.artifact.status === "usable"
    ? report.manifests.artifact.value
    : null;
const plainObject = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};
function diffMap(before, after) {
  const changes = [];
  const keys = new Set([
    ...Object.keys(plainObject(before)),
    ...Object.keys(plainObject(after)),
  ]);
  for (const key of [...keys].sort()) {
    const from = plainObject(before)[key];
    const to = plainObject(after)[key];
    if (from === to) continue;
    changes.push({
      key,
      change:
        from === undefined ? "added" : to === undefined ? "removed" : "changed",
      ...(from === undefined ? {} : { from: String(from) }),
      ...(to === undefined ? {} : { to: String(to) }),
    });
  }
  return changes;
}
function filesByPath(report) {
  return new Map(
    report.files.map((file) => [file.path ?? file.originalPath, file]),
  );
}
function diffFiles(older, newer) {
  const before = filesByPath(older);
  const after = filesByPath(newer);
  const result = { added: [], removed: [], modified: [], unchanged: 0 };
  for (const [key, file] of after) {
    const previous = before.get(key);
    const entry = { path: key, size: file.size, state: file.state };
    if (!previous) result.added.push(entry);
    else if (previous.artifactSha256 !== file.artifactSha256)
      result.modified.push({ ...entry, previousSize: previous.size });
    else result.unchanged++;
  }
  for (const [key, file] of before)
    if (!after.has(key))
      result.removed.push({ path: key, size: file.size, state: file.state });
  for (const list of [result.added, result.removed, result.modified])
    list.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return result;
}
function side(report) {
  return {
    name: report.inputs.claim.name,
    version: report.inputs.claim.version,
    exitCode: report.policy.exitCode,
    findings: report.policy.findings.map((finding) => finding.ruleId),
    coverageComplete: report.coverage.complete,
    sourceStatus: report.source.status,
    failures: report.failures.map((failure) => failure.code),
    manifestStatus: report.manifests.artifact.status,
  };
}
export function aggregateExit(...reports) {
  const codes = reports.map((report) => report.policy.exitCode);
  return codes.includes(2) ? 2 : codes.includes(3) ? 3 : 0;
}
export function compareReports(older, newer) {
  const a = manifestOf(older);
  const b = manifestOf(newer);
  const scripts = diffMap(a?.scripts, b?.scripts).map((change) => ({
    ...change,
    lifecycle: LIFECYCLE.has(change.key),
  }));
  const dependencies = Object.fromEntries(
    DEPENDENCY_FIELDS.map((field) => [field, diffMap(a?.[field], b?.[field])]),
  );
  const caveats = [];
  for (const [label, report] of [
    ["old", older],
    ["new", newer],
  ]) {
    const version = report.inputs.claim.version;
    if (report.manifests.artifact.status !== "usable")
      caveats.push(
        `${label} ${version}: package manifest is ${report.manifests.artifact.status}; script and dependency changes are incomplete.`,
      );
    if (!report.coverage.complete)
      caveats.push(
        `${label} ${version}: file inventory or source comparison is incomplete.`,
      );
    if (report.failures.length)
      caveats.push(
        `${label} ${version}: deterministic failures ${report.failures.map((failure) => failure.code).join(", ")}.`,
      );
  }
  if (scripts.some((change) => change.lifecycle && change.change !== "removed"))
    caveats.push(
      "A lifecycle script was added or changed; installs may run it automatically.",
    );
  caveats.push(
    "A version without current findings is not proven safe; known malware may be missed when advisories lag or versions were removed.",
  );
  return {
    package: older.inputs.claim.name,
    old: side(older),
    new: side(newer),
    scripts,
    dependencies,
    files: diffFiles(older, newer),
    caveats,
    exitCode: aggregateExit(older, newer),
  };
}
const UNSAFE =
  /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const JSON_UNSAFE = /[\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const escapeUnsafe = (text, pattern = UNSAFE) =>
  text.replace(
    pattern,
    (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"),
  );
const display = (value) => JSON.stringify(value).slice(0, 200);
function listed(lines, items, format) {
  for (const item of items.slice(0, MAX_LISTED)) lines.push(format(item));
  if (items.length > MAX_LISTED)
    lines.push(`    ... ${items.length - MAX_LISTED} more`);
}
function mapLines(lines, title, changes) {
  lines.push(`${title}: ${changes.length ? "" : "no changes"}`.trimEnd());
  listed(lines, changes, (change) => {
    const mark = { added: "+", removed: "-", changed: "~" }[change.change];
    const flag = change.lifecycle ? " [lifecycle]" : "";
    if (change.change === "changed")
      return `  ${mark} ${change.key}${flag}: ${display(change.from)} -> ${display(change.to)}`;
    return `  ${mark} ${change.key}${flag}: ${display(change.to ?? change.from)}`;
  });
}
export function renderComparison(result) {
  const lines = [
    `Compare ${result.package} ${result.old.version} -> ${result.new.version}`,
    `Aggregate exit ${result.exitCode}: 2 if either side is incomplete or failed, else 3 if either side has findings, else 0`,
  ];
  for (const label of ["old", "new"]) {
    const item = result[label];
    lines.push(
      `${label.padEnd(3)} ${item.version}: exit ${item.exitCode}, findings ${item.findings.join(", ") || "none"}, coverage ${item.coverageComplete ? "complete" : "incomplete"}, source ${item.sourceStatus}`,
    );
  }
  mapLines(lines, "Scripts", result.scripts);
  for (const field of DEPENDENCY_FIELDS)
    mapLines(lines, field, result.dependencies[field]);
  const files = result.files;
  lines.push(
    `Files: ${files.added.length} added, ${files.removed.length} removed, ${files.modified.length} modified, ${files.unchanged} unchanged`,
  );
  listed(lines, files.added, (file) => `  + ${file.path} (${file.size} B)`);
  listed(lines, files.removed, (file) => `  - ${file.path} (${file.size} B)`);
  listed(
    lines,
    files.modified,
    (file) => `  ~ ${file.path} (${file.previousSize} B -> ${file.size} B)`,
  );
  lines.push("Caveats:");
  for (const caveat of result.caveats) lines.push(`  ! ${caveat}`);
  return lines.map((line) => escapeUnsafe(line)).join("\n") + "\n";
}
export async function runCompare(argv, runtime = {}) {
  const { specs, json } = parseCompareArgs(argv);
  const check = runtime.checkHosted ?? checkHosted;
  const options = {
    serverUrl: (runtime.env ?? process.env).UNMASK_SERVER_URL,
    fetchImpl: runtime.fetchImpl,
    signal: runtime.signal,
    limits: runtime.hostedLimits,
  };
  const older = await check(specs[0], options);
  const newer = await check(specs[1], options);
  const result = compareReports(older, newer);
  (runtime.stdout ?? process.stdout).write(
    json
      ? escapeUnsafe(JSON.stringify(result, null, 2), JSON_UNSAFE) + "\n"
      : renderComparison(result),
  );
  return result.exitCode;
}
