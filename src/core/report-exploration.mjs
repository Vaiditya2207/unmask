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

function validRange(value, size) {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((number) => Number.isSafeInteger(number) && number >= 0) &&
    value[0] <= value[1] &&
    value[1] <= size
  );
}

function recordedExcerpt(item) {
  const unavailable = {
    excerpt: null,
    excerptRange: null,
    recordedExcerptRange: null,
    excerptTruncated: false,
    excerptStatus: "not-recorded",
  };
  if (item.excerpt === undefined) return unavailable;
  if (
    typeof item.excerpt !== "string" ||
    !validRange(item.excerptRange, item.size) ||
    item.excerptRange[0] !== item.range[0] ||
    item.excerptRange[1] > item.range[1] ||
    Buffer.byteLength(item.excerpt) !==
      item.excerptRange[1] - item.excerptRange[0]
  )
    return { ...unavailable, excerptStatus: "invalid-recorded-range" };
  let excerpt = "",
    bytes = 0;
  for (const character of item.excerpt) {
    const size = Buffer.byteLength(character);
    if (bytes + size > 2048) break;
    bytes += size;
    excerpt += character;
  }
  return {
    excerpt,
    excerptRange: [item.excerptRange[0], item.excerptRange[0] + bytes],
    recordedExcerptRange: item.excerptRange,
    excerptTruncated: bytes < Buffer.byteLength(item.excerpt),
    excerptStatus: "recorded",
  };
}

export function buildReportFileEvidence(report, selection) {
  const keys = Object.keys(selection ?? {});
  if (
    keys.length !== 1 ||
    !["path", "originalPath"].includes(keys[0]) ||
    !safeExplorationPath(selection[keys[0]])
  )
    throw new TypeError("Invalid file selection");
  const { rows } = reportFileRows(report);
  const matches = rows.filter((file) =>
    keys[0] === "path"
      ? file.path === selection.path
      : file.path === null && file.originalPath === selection.originalPath,
  );
  if (matches.length !== 1) return null;
  const file = matches[0];
  const rawFile = (report.files ?? []).find(
    (item) =>
      item.path === file.path && item.originalPath === file.originalPath,
  );
  const samePathEvidence = (report.evidence ?? []).filter((item) =>
    file.path === null
      ? item.side === "artifact" &&
        item.path === null &&
        item.originalPath === file.originalPath
      : item.path === file.path &&
        (file.state !== "removed" || item.side === "source"),
  );
  if (file.state === "removed") {
    const hashes = new Set(
      samePathEvidence
        .filter(
          (item) =>
            digest(item.fileSha256) &&
            digest(item.blobDigest) &&
            item.blobDigest === report.inputs?.sourceArchive?.sha256,
        )
        .map((item) => item.fileSha256),
    );
    if (hashes.size === 1) file.sourceSha256 = [...hashes][0];
  }
  const candidateIds = new Set([
    ...(rawFile?.evidenceIds ?? []),
    ...samePathEvidence.map((item) => item.id),
  ]);
  const result = {
    schemaVersion: "1",
    scope: "artifact-source",
    file,
    recordedOnly: true,
    evidence: [],
    evidenceStatus: "unavailable",
    evidenceOmitted: 0,
    invalidEvidenceOmitted: 0,
    limitations: [
      ...explorationLimitations,
      "Only previously recorded excerpts are returned; omitted text is not fetched or reconstructed. Hashes are recorded claims, not new artifact verification. Render excerpts as text, never HTML.",
    ],
  };
  const evidenceById = new Map();
  for (const item of report.evidence ?? [])
    evidenceById.set(item.id, evidenceById.has(item.id) ? null : item);
  let bytes = Buffer.byteLength(explorationJson(result));
  for (const id of candidateIds) {
    const item = evidenceById.get(id);
    const expectedHash =
      item?.side === "artifact" ? file.artifactSha256 : file.sourceSha256;
    const input =
      item?.side === "artifact"
        ? report.inputs?.artifact
        : report.inputs?.sourceArchive;
    if (
      !item ||
      !/^ev-[a-f0-9]{64}$/.test(id) ||
      !["artifact", "source"].includes(item.side) ||
      item.path !== file.path ||
      !safeExplorationPath(item.originalPath) ||
      (item.side === "artifact" &&
        (item.originalPath !== file.originalPath || item.size !== file.size)) ||
      !expectedHash ||
      item.fileSha256 !== expectedHash ||
      !digest(item.blobDigest) ||
      item.blobDigest !== input?.sha256 ||
      !Number.isSafeInteger(item.size) ||
      item.size < 0 ||
      !validRange(item.range, item.size)
    ) {
      result.invalidEvidenceOmitted++;
      continue;
    }
    const evidence = {
      id,
      side: item.side,
      path: item.path,
      originalPath: item.originalPath,
      fileSha256: item.fileSha256,
      blobDigest: item.blobDigest,
      size: item.size,
      range: item.range,
      ...recordedExcerpt(item),
    };
    const size = Buffer.byteLength(explorationJson(evidence)) + 1;
    if (
      result.evidence.length >= 32 ||
      bytes + size > EXPLORATION_BYTE_LIMIT - 2048
    ) {
      result.evidenceOmitted++;
      continue;
    }
    bytes += size;
    result.evidence.push(evidence);
  }
  if (result.evidence.length)
    result.evidenceStatus =
      result.evidenceOmitted || result.invalidEvidenceOmitted
        ? "partial"
        : "recorded";
  return result;
}
