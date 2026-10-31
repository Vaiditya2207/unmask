const states = new Map([
  ["changed", "changed"],
  ["artifact-only", "added"],
  ["byte-identical", "identical"],
  ["not-compared", "not-compared"],
]);
const digest = (value) => (/^[a-f0-9]{64}$/.test(value ?? "") ? value : null);
const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const EXPLORATION_BYTE_LIMIT = 131072;
export const explorationLimitations = [
  "States compare artifact and selected source, not releases or version history.",
  "Source-only paths are recorded observations; their hashes, file types and excerpts may be unavailable.",
  "Incomplete inventories and unassessed files do not establish safety or absence.",
];

export function safeExplorationPath(value, { prefix = false } = {}) {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    /[\x00-\x1f\x7f\\%:]/.test(value)
  )
    return false;
  if (prefix && value === "") return true;
  const parts = (
    prefix && value.endsWith("/") ? value.slice(0, -1) : value
  ).split("/");
  return parts.every((part) => part && part !== "." && part !== "..");
}

export function explorationJson(value) {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function reportFileRows(report) {
  const rows = [];
  const paths = new Set();
  let omitted = 0;
  for (const file of report.files ?? []) {
    if (
      !states.has(file.state) ||
      !safeExplorationPath(file.originalPath) ||
      (file.path !== null && !safeExplorationPath(file.path))
    ) {
      omitted++;
      continue;
    }
    if (file.path !== null) paths.add(file.path);
    rows.push({
      path: file.path,
      originalPath: file.originalPath,
      state: states.get(file.state),
      comparisonState: file.state,
      size:
        Number.isSafeInteger(file.size) && file.size >= 0 ? file.size : null,
      artifactSha256: digest(file.artifactSha256),
      sourceSha256: digest(file.sourceSha256),
      reason:
        typeof file.reason === "string" ? file.reason.slice(0, 128) : null,
    });
  }
  for (const path of new Set(report.coverage?.sourceOnly ?? [])) {
    if (!safeExplorationPath(path)) {
      omitted++;
      continue;
    }
    if (paths.has(path)) continue;
    rows.push({
      path,
      originalPath: null,
      state: "removed",
      comparisonState: "source-only",
      size: null,
      artifactSha256: null,
      sourceSha256: null,
      reason: "recorded-source-only",
    });
  }
  rows.sort(
    (a, b) =>
      order(a.path ?? a.originalPath, b.path ?? b.originalPath) ||
      order(a.originalPath ?? "", b.originalPath ?? ""),
  );
  return { rows, omitted };
}

export function buildReportFileInventory(
  report,
  { state = "all", prefix = "", offset = 0, limit = 50 } = {},
) {
  if (
    !["all", "removed", ...states.values()].includes(state) ||
    !safeExplorationPath(prefix, { prefix: true }) ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new TypeError("Invalid inventory query");
  const { rows, omitted } = reportFileRows(report);
  const filtered = rows.filter(
    (file) =>
      (state === "all" || file.state === state) &&
      (file.path ?? file.originalPath).startsWith(prefix),
  );
  const files = [];
  let bytes = 0;
  for (const file of filtered.slice(offset, offset + limit)) {
    const size = Buffer.byteLength(explorationJson(file)) + 1;
    if (
      bytes + size >
      EXPLORATION_BYTE_LIMIT -
        Buffer.byteLength(explorationJson({ prefix })) -
        8192
    )
      break;
    bytes += size;
    files.push(file);
  }
  return {
    schemaVersion: "1",
    scope: "artifact-source",
    state,
    prefix,
    offset,
    limit,
    total: filtered.length,
    files,
    nextOffset:
      offset + files.length < filtered.length ? offset + files.length : null,
    omittedUnsafePaths: omitted,
    inventoryComplete: report.coverage?.inventory?.complete === true,
    sourceComplete: report.coverage?.sourceComplete === true,
    limitations: explorationLimitations,
  };
}
