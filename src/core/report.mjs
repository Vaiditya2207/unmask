import { createHash } from "node:crypto";
import { POLICY_VERSION, policyResult } from "./policy.mjs";

const fields = [
  "schemaVersion",
  "analyzerVersion",
  "policyVersion",
  "limitsVersion",
  "inputs",
  "source",
  "files",
  "coverage",
  "evidence",
  "manifests",
  "cues",
  "annotations",
  "failures",
  "model",
  "run",
  "policy",
];
const states = ["byte-identical", "changed", "artifact-only", "not-compared"];
const methods = [
  "provenance-verified",
  "provenance-claimed",
  "publisher-gitHead",
  "user-full-SHA",
  "unresolved",
  "conflicting",
];
const digest = (value, size = 64) =>
  typeof value === "string" && new RegExp(`^[a-f0-9]{${size}}$`).test(value);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
function requireValue(condition, message) {
  if (!condition) throw new TypeError(message);
}
function jsonData(value, ancestors = new Set(), depth = 0) {
  requireValue(depth <= 64, "Report nesting limit exceeded");
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number") {
    requireValue(Number.isFinite(value), "Nonfinite JSON number");
    return;
  }
  requireValue(
    typeof value === "object" &&
      (Array.isArray(value) ||
        Object.getPrototypeOf(value) === Object.prototype ||
        Object.getPrototypeOf(value) === null),
    "Report requires plain JSON data",
  );
  requireValue(!ancestors.has(value), "Cyclic report");
  ancestors.add(value);
  const keys = Reflect.ownKeys(value).filter(
    (key) => !(Array.isArray(value) && key === "length"),
  );
  if (Array.isArray(value))
    requireValue(
      keys.length === value.length &&
        keys.every((key, index) => key === String(index)),
      "Sparse or extended JSON array",
    );
  for (const key of keys) {
    requireValue(typeof key === "string", "Symbol report key");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    requireValue(
      descriptor.enumerable && Object.hasOwn(descriptor, "value"),
      "Report accessor or hidden field",
    );
    jsonData(descriptor.value, ancestors, depth + 1);
  }
  ancestors.delete(value);
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function safePath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    value.split("/").every((part) => part && part !== "." && part !== "..")
  );
}
function counter(value) {
  return value && integer(value.files) && integer(value.bytes);
}

export function createReport({
  inputs,
  source,
  comparison,
  manifests,
  failures = [],
  run = {},
  analyzerVersion = "0.0.0",
  limitsVersion = "1",
}) {
  const report = {
    schemaVersion: "1",
    analyzerVersion,
    policyVersion: POLICY_VERSION,
    limitsVersion,
    inputs,
    source: {
      ...source,
      complete: source.complete ?? comparison.coverage.sourceComplete,
    },
    files: comparison.files,
    coverage: comparison.coverage,
    evidence: comparison.evidence,
    manifests,
    cues: [],
    annotations: [],
    failures,
    model: { status: "disabled" },
    run: {
      timestamps: {},
      timings: {},
      surface: "unknown",
      observations: [],
      ...run,
    },
  };
  jsonData(report);
  const snapshot = structuredClone(report);
  snapshot.policy = policyResult(snapshot);
  return validateReport(snapshot);
}

export function validateReport(report) {
  jsonData(report);
  requireValue(
    report &&
      !Array.isArray(report) &&
      fields.every((key) => Object.hasOwn(report, key)) &&
      Object.keys(report).every((key) => fields.includes(key)),
    "Invalid report fields",
  );
  requireValue(
    report.schemaVersion === "1" &&
      typeof report.analyzerVersion === "string" &&
      report.analyzerVersion.length > 0 &&
      report.policyVersion === POLICY_VERSION &&
      typeof report.limitsVersion === "string" &&
      report.limitsVersion.length > 0,
    "Unsupported report version",
  );
  requireValue(
    report.inputs &&
      digest(report.inputs.artifact?.sha256) &&
      digest(report.inputs.artifact?.sha512, 128),
    "Original artifact digests are required",
  );
  requireValue(
    (report.inputs.limits &&
      typeof report.inputs.limits === "object" &&
      !Array.isArray(report.inputs.limits) &&
      Object.keys(report.inputs.limits).length > 0) ||
      digest(report.inputs.limitsDigest),
    "Effective limits object or digest is required",
  );
  for (const key of ["sourceArchive", "registryDocument"]) {
    if (report.inputs[key] !== undefined)
      requireValue(digest(report.inputs[key]?.sha256), `Invalid ${key} digest`);
  }
  const expected = report.inputs.artifact.expectedIntegrity;
  if (expected !== undefined)
    requireValue(
      expected &&
        ((expected.status === "unavailable" && expected.digest === undefined) ||
          (["sha256", "sha512"].includes(expected.algorithm) &&
            digest(
              expected.digest,
              expected.algorithm === "sha512" ? 128 : 64,
            ))),
      "Invalid expected integrity",
    );
  if (report.inputs.claim !== undefined)
    requireValue(
      report.inputs.claim &&
        typeof report.inputs.claim.name === "string" &&
        typeof report.inputs.claim.version === "string",
      "Invalid identity claim",
    );
  requireValue(
    report.source &&
      typeof report.source.complete === "boolean" &&
      [
        "selected",
        "resolved",
        "unresolved",
        "conflicting",
        "unavailable",
      ].includes(report.source.status) &&
      methods.includes(report.source.method) &&
      Array.isArray(report.source.alternatives),
    "Invalid source selection",
  );
  if (report.source.commit !== undefined)
    requireValue(
      /^[a-f0-9]{40}$/.test(report.source.commit),
      "Source commit must be a full SHA",
    );
  requireValue(
    Array.isArray(report.files) &&
      Array.isArray(report.evidence) &&
      Array.isArray(report.failures) &&
      Array.isArray(report.cues) &&
      Array.isArray(report.annotations),
    "Invalid report collections",
  );
  requireValue(
    report.model &&
      typeof report.model.status === "string" &&
      report.run &&
      typeof report.run === "object",
    "Invalid model or run section",
  );
  const coverage = report.coverage;
  requireValue(
    coverage &&
      counter(coverage.inventory) &&
      typeof coverage.inventory.complete === "boolean" &&
      coverage.inventory.lowerBound === !coverage.inventory.complete &&
      typeof coverage.complete === "boolean" &&
      typeof coverage.sourceAvailable === "boolean" &&
      typeof coverage.sourceComplete === "boolean",
    "Invalid coverage inventory",
  );
  requireValue(
    coverage.complete ===
      (coverage.inventory.complete &&
        (!coverage.sourceAvailable || coverage.sourceComplete)),
    "Invalid completeness claim",
  );
  requireValue(
    report.source.complete === coverage.sourceComplete,
    "Source completeness differs from comparison",
  );
  for (const name of [
    "compared",
    "unresolved",
    "syntaxInspected",
    "modelReviewed",
  ])
    requireValue(
      counter(coverage[name]) &&
        coverage[name].files <= coverage.inventory.files &&
        coverage[name].bytes <= coverage.inventory.bytes,
      "Invalid coverage counter",
    );
  requireValue(
    coverage.states && states.every((state) => counter(coverage.states[state])),
    "Invalid correspondence coverage",
  );
  for (const name of ["links", "nonregular"])
    requireValue(
      coverage[name] &&
        integer(coverage[name].artifact) &&
        integer(coverage[name].source),
      "Invalid nonregular coverage",
    );
  requireValue(
    Array.isArray(coverage.linkEntries) &&
      coverage.linkEntries.every(
        (link) =>
          link &&
          ["artifact", "source"].includes(link.side) &&
          ["symlink", "hardlink"].includes(link.type) &&
          (link.path === null || safePath(link.path)) &&
          typeof link.originalPath === "string" &&
          typeof link.linkTarget === "string",
      ) &&
      ["artifact", "source"].every(
        (side) =>
          coverage.linkEntries.filter((link) => link.side === side).length ===
          coverage.links[side],
      ),
    "Invalid inert link inventory",
  );
  requireValue(
    Array.isArray(coverage.sourceOnly) && coverage.sourceOnly.every(safePath),
    "Invalid source-only paths",
  );
  const evidence = new Map();
  for (const item of report.evidence) {
    requireValue(
      item &&
        ["artifact", "source"].includes(item.side) &&
        (item.path === null || safePath(item.path)) &&
        typeof item.originalPath === "string" &&
        digest(item.blobDigest) &&
        digest(item.fileSha256) &&
        integer(item.size) &&
        Array.isArray(item.range) &&
        item.range.length === 2 &&
        item.range.every(integer) &&
        item.range[0] <= item.range[1] &&
        item.range[1] <= item.size,
      "Invalid evidence provenance/range",
    );
    const blob =
      item.side === "artifact"
        ? report.inputs.artifact
        : report.inputs.sourceArchive;
    requireValue(
      item.blobDigest === blob?.sha256,
      "Evidence is not bound to an input",
    );
    const identity = [
      item.side,
      item.blobDigest,
      item.path ?? item.originalPath,
      item.range,
    ];
    const expectedId = `ev-${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
    requireValue(
      item.id === expectedId && !evidence.has(item.id),
      "Invalid or duplicate evidence ID",
    );
    if (item.excerpt !== undefined)
      requireValue(
        typeof item.excerpt === "string" &&
          Array.isArray(item.excerptRange) &&
          item.excerptRange.length === 2 &&
          item.excerptRange.every(integer) &&
          item.excerptRange[0] === item.range[0] &&
          item.excerptRange[1] <= item.range[1] &&
          item.excerptRange[1] - item.excerptRange[0] ===
            Buffer.byteLength(item.excerpt),
        "Invalid evidence excerpt range",
      );
    evidence.set(item.id, item);
  }
  function references(ids) {
    requireValue(
      Array.isArray(ids) && ids.every((id) => evidence.has(id)),
      "Unknown evidence reference",
    );
  }
  const totals = Object.fromEntries(
    states.map((state) => [state, { files: 0, bytes: 0 }]),
  );
  const paths = new Set();
  for (const file of report.files) {
    requireValue(
      file &&
        (file.path === null || safePath(file.path)) &&
        typeof file.originalPath === "string" &&
        integer(file.size) &&
        digest(file.artifactSha256) &&
        states.includes(file.state) &&
        ["whole-file", "byte-spans"].includes(file.localization),
      "Invalid file correspondence",
    );
    const key = file.path ?? `\0${file.originalPath}`;
    requireValue(!paths.has(key), "Duplicate artifact file");
    paths.add(key);
    references(file.evidenceIds);
    requireValue(
      file.evidenceIds.some((id) => {
        const e = evidence.get(id);
        return (
          e.side === "artifact" &&
          e.path === file.path &&
          e.originalPath === file.originalPath &&
          e.size === file.size &&
          e.fileSha256 === file.artifactSha256
        );
      }),
      "Missing artifact file evidence",
    );
    if (["byte-identical", "changed"].includes(file.state))
      requireValue(
        digest(file.sourceSha256) &&
          file.evidenceIds.some((id) => {
            const e = evidence.get(id);
            return (
              e.side === "source" &&
              e.path === file.path &&
              e.fileSha256 === file.sourceSha256 &&
              (file.state !== "byte-identical" ||
                (e.size === file.size &&
                  file.sourceSha256 === file.artifactSha256))
            );
          }),
        "Invalid source correspondence evidence",
      );
    if (file.state === "artifact-only")
      requireValue(
        coverage.sourceAvailable &&
          coverage.sourceComplete &&
          ["selected", "resolved"].includes(report.source.status),
        "Source absence is not established",
      );
    if (file.localization === "byte-spans") {
      requireValue(
        file.state === "changed" &&
          file.spans &&
          ["artifact", "source"].every((side) => {
            const range = file.spans[side];
            return (
              Array.isArray(range) &&
              range.length === 2 &&
              range.every(integer) &&
              range[0] <= range[1] &&
              file.evidenceIds.some((id) => {
                const e = evidence.get(id);
                return (
                  e.side === side && canonical(e.range) === canonical(range)
                );
              })
            );
          }),
        "Invalid byte-span localization",
      );
    }
    if (file.state === "not-compared")
      requireValue(
        typeof file.reason === "string" && file.reason.length > 0,
        "Unknown comparison reason",
      );
    totals[file.state].files++;
    totals[file.state].bytes += file.size;
  }
  requireValue(
    states.every(
      (state) => canonical(totals[state]) === canonical(coverage.states[state]),
    ),
    "Coverage state totals differ",
  );
  const totalBytes = Object.values(totals).reduce(
    (sum, value) => sum + value.bytes,
    0,
  );
  requireValue(
    Number.isSafeInteger(totalBytes) &&
      report.files.length === coverage.inventory.files &&
      totalBytes === coverage.inventory.bytes,
    "Coverage denominator differs",
  );
  requireValue(
    coverage.compared.files ===
      totals["byte-identical"].files + totals.changed.files &&
      coverage.compared.bytes ===
        totals["byte-identical"].bytes + totals.changed.bytes &&
      coverage.unresolved.files ===
        report.files.length - totals["byte-identical"].files &&
      coverage.unresolved.bytes === totalBytes - totals["byte-identical"].bytes,
    "Coverage correspondence totals differ",
  );
  for (const side of ["artifact", "source", "registry"]) {
    const manifest = report.manifests?.[side];
    requireValue(
      manifest &&
        ["usable", "unavailable", "invalid"].includes(manifest.status),
      "Invalid manifest status",
    );
    if (manifest.status === "usable") {
      requireValue(
        manifest.value &&
          typeof manifest.value === "object" &&
          !Array.isArray(manifest.value),
        "Invalid manifest value",
      );
      references(manifest.evidenceIds);
    }
  }
  for (const failure of report.failures)
    requireValue(
      failure &&
        typeof failure.code === "string" &&
        typeof failure.message === "string",
      "Invalid deterministic failure",
    );
  for (const item of [...report.cues, ...report.annotations])
    if (item.evidenceIds !== undefined) references(item.evidenceIds);
  requireValue(
    canonical(policyResult(report)) === canonical(report.policy),
    "Policy result differs from deterministic evidence",
  );
  for (const finding of report.policy.findings) references(finding.evidenceIds);
  return report;
}

export function canonicalReport(report) {
  validateReport(report);
  return (
    canonical(
      Object.fromEntries(
        Object.entries(report).filter(
          ([key]) => key !== "run" && key !== "model",
        ),
      ),
    ) + "\n"
  );
}
