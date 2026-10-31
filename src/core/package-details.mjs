import path from "node:path";
import { validateReport } from "./report.mjs";

export const PACKAGE_DETAILS_LIMITS = Object.freeze({
  maxItems: 20000,
  maxValueBytes: 32768,
  maxSectionBytes: 262144,
  maxTotalBytes: 2097152,
});
const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const pointer = (value) =>
  String(value).replace(/~/g, "~0").replace(/\//g, "~1");
const sorted = (value) => Object.keys(value).sort(order);
const type = (value) =>
  value === null ? "null" : Array.isArray(value) ? "array" : typeof value;

export function buildPackageDetails(report, options = {}) {
  validateReport(report);
  const limits = { ...PACKAGE_DETAILS_LIMITS, ...options };
  if (
    Object.entries(limits).some(
      ([key, value]) =>
        !Object.hasOwn(PACKAGE_DETAILS_LIMITS, key) ||
        !Number.isSafeInteger(value) ||
        value < 1 ||
        value > PACKAGE_DETAILS_LIMITS[key],
    ) ||
    limits.maxTotalBytes < 65536
  )
    throw new TypeError("Invalid package details limits");
  let remaining = limits.maxTotalBytes - 32768;
  function take(values) {
    const result = {
      items: [],
      total: values.length,
      returned: 0,
      omitted: 0,
      omissionReasons: {},
    };
    let bytes = 2;
    for (const value of values) {
      const json = JSON.stringify(value);
      const size = Buffer.byteLength(json) + 1;
      const reason =
        size > limits.maxValueBytes
          ? "value-byte-cap"
          : result.returned >= limits.maxItems
            ? "item-cap"
            : bytes + size > limits.maxSectionBytes
              ? "section-byte-cap"
              : size > remaining
                ? "response-byte-cap"
                : null;
      if (reason) {
        result.omitted++;
        result.omissionReasons[reason] =
          (result.omissionReasons[reason] ?? 0) + 1;
      } else {
        result.items.push(JSON.parse(json));
        result.returned++;
        bytes += size;
        remaining -= size;
      }
    }
    return result;
  }
  const manifest = report.manifests.artifact;
  const declared = manifest.status === "usable" ? manifest.value : null;
  const allManifestEvidenceIds = declared
    ? [...new Set(manifest.evidenceIds)].sort(order)
    : [];
  const evidenceIds = allManifestEvidenceIds.slice(0, 16);
  const evidenceIdsOmitted = allManifestEvidenceIds.length - evidenceIds.length;
  function field(name) {
    const present = declared !== null && Object.hasOwn(declared, name);
    return {
      field: name,
      pointer: `/${pointer(name)}`,
      status:
        declared === null
          ? manifest.status
          : present
            ? "declared"
            : "not-declared-in-manifest",
      ...(present
        ? { value: declared[name], valueType: type(declared[name]) }
        : {}),
      evidenceIds,
    };
  }
  function entries(name, mode = "map") {
    const entry = field(name);
    const value = entry.value;
    let status = entry.status;
    let values = [];
    let declaredCount = null;
    if (entry.status === "declared") {
      if (mode === "bundled" && typeof value === "boolean") {
        status = value
          ? "declared-all-runtime-dependencies"
          : "declared-disabled";
      } else if (mode === "bundled" && Array.isArray(value)) {
        values = value.map((item, index) => ({
          name: item,
          index,
          status: typeof item === "string" ? "declared" : "invalid-type",
          pointer: `/${name}/${index}`,
          evidenceIds,
        }));
        values.sort(
          (a, b) =>
            order(JSON.stringify(a.name), JSON.stringify(b.name)) ||
            a.index - b.index,
        );
        declaredCount = value.length;
      } else if (mode === "map" && object(value)) {
        values = sorted(value).map((key) => ({
          name: key,
          value: value[key],
          status: typeof value[key] === "string" ? "declared" : "invalid-type",
          pointer: `/${name}/${pointer(key)}`,
          ...(name === "scripts"
            ? {
                installHook: ["preinstall", "install", "postinstall"].includes(
                  key,
                ),
              }
            : {}),
          evidenceIds,
        }));
        declaredCount = values.length;
      } else status = "invalid-type";
    } else if (entry.status === "not-declared-in-manifest") declaredCount = 0;
    return {
      field: name,
      status,
      declaredCount,
      validEntryCount:
        declaredCount === null
          ? null
          : values.filter((item) => item.status === "declared").length,
      entries: take(values),
      evidenceIds,
      evidenceIdsOmitted,
    };
  }
  const fileOrder = (a, b) =>
    order(a.path ?? "", b.path ?? "") || order(a.originalPath, b.originalPath);
  const files = [...report.files].sort(fileOrder);
  const extensions = new Map();
  for (const file of files) {
    const extension =
      path.posix.extname(file.path ?? file.originalPath).toLowerCase() ||
      "(none)";
    const group = extensions.get(extension) ?? {
      extension,
      files: 0,
      bytes: 0,
    };
    group.files++;
    group.bytes += file.size;
    extensions.set(extension, group);
  }
  const observations = [
    ...report.cues.map((cue, index) => ({ ...cue, cueRef: `/cues/${index}` })),
    ...report.annotations.map((cue, index) => ({
      ...cue,
      cueRef: `/annotations/${index}`,
    })),
  ].filter(
    (cue) => typeof cue.ruleId === "string" && cue.ruleId.startsWith("syntax-"),
  );
  observations.sort(
    (a, b) => order(a.ruleId, b.ruleId) || order(a.cueRef, b.cueRef),
  );
  const capabilityGroups = new Map();
  for (const cue of observations) {
    const group = capabilityGroups.get(cue.ruleId) ?? {
      ruleId: cue.ruleId,
      observations: 0,
    };
    group.observations++;
    capabilityGroups.set(cue.ruleId, group);
  }
  const byPath = new Map(
    files.filter((file) => file.path !== null).map((file) => [file.path, file]),
  );
  const topDirectories = new Map();
  for (const file of files) {
    const name = (file.path ?? file.originalPath).includes("/")
      ? (file.path ?? file.originalPath).split("/")[0]
      : "(root)";
    const item = topDirectories.get(name) ?? {
      directory: name,
      files: 0,
      bytes: 0,
    };
    item.files++;
    item.bytes += file.size;
    topDirectories.set(name, item);
  }
  const evidenceById = new Map(report.evidence.map((item) => [item.id, item]));
  const cueRefsByPath = new Map();
  for (const cue of observations)
    for (const id of cue.evidenceIds ?? []) {
      const evidence = evidenceById.get(id);
      if (evidence?.side !== "artifact") continue;
      const refs = cueRefsByPath.get(evidence.path) ?? new Set();
      refs.add(cue.cueRef);
      cueRefsByPath.set(evidence.path, refs);
    }
  const skippedByPath = new Map();
  for (const annotation of report.annotations)
    if (
      annotation.type === "syntax-not-inspected" &&
      annotation.side === "artifact"
    ) {
      const reasons = skippedByPath.get(annotation.path) ?? new Set();
      reasons.add(annotation.reason);
      skippedByPath.set(annotation.path, reasons);
    }
  const targets = [];
  let targetNodes = 0;
  let targetTraversalOmitted = false;
  function visitTarget(value, parts) {
    if (++targetNodes > 4096) {
      targetTraversalOmitted = true;
      return;
    }
    if (typeof value === "string") {
      const candidate = value.startsWith("./") ? value.slice(2) : value;
      const safe =
        candidate.length > 0 &&
        !/[\\\0*?\[\]{}:]/u.test(candidate) &&
        !candidate.startsWith("/") &&
        candidate
          .split("/")
          .every((part) => part && part !== "." && part !== "..");
      const file = safe ? byPath.get(candidate) : undefined;
      const cueRefs = file
        ? [...(cueRefsByPath.get(file.path) ?? [])].sort(order)
        : [];
      const skipped = file
        ? [...(skippedByPath.get(file.path) ?? [])].sort(order)
        : [];
      targets.push({
        field: parts[0],
        pointer: "/" + parts.map(pointer).join("/"),
        target: value,
        matchStatus: !safe
          ? "not-assessed-unsafe-or-pattern-target"
          : file
            ? "exact-file-match"
            : "no-exact-match-in-accepted-inventory",
        ...(file
          ? {
              path: file.path,
              state: file.state,
              bytes: file.size,
              evidenceIds: file.evidenceIds,
              syntaxStatus: cueRefs.length
                ? "observed-syntax-cues"
                : skipped.length
                  ? "recorded-not-inspected"
                  : "not-recorded-per-file",
              syntaxCueRefs: cueRefs,
              syntaxSkippedReasons: skipped,
            }
          : { evidenceIds: [] }),
      });
    } else if (object(value) || Array.isArray(value)) {
      for (const key of sorted(value)) {
        if (targetNodes >= 4096) {
          targetTraversalOmitted = true;
          break;
        }
        visitTarget(value[key], [...parts, key]);
      }
    }
  }
  if (declared)
    for (const name of [
      "main",
      "module",
      "exports",
      "bin",
      "types",
      "typings",
      "browser",
    ])
      if (Object.hasOwn(declared, name)) visitTarget(declared[name], [name]);
  function dependencyDelta(side) {
    const other = report.manifests[side];
    const proven =
      declared &&
      other.status === "usable" &&
      (side === "source"
        ? report.source.complete &&
          report.coverage.sourceComplete &&
          ["selected", "resolved"].includes(report.source.status) &&
          !["unresolved", "conflicting"].includes(report.source.method)
        : typeof report.inputs.registryDocument?.sha256 === "string");
    const differences = [];
    const unassessedFields = [];
    if (proven)
      for (const field of [
        "dependencies",
        "optionalDependencies",
        "peerDependencies",
        "devDependencies",
      ]) {
        const left = declared[field];
        const right = other.value[field];
        if (
          (left !== undefined && !object(left)) ||
          (right !== undefined && !object(right))
        ) {
          unassessedFields.push(field);
          continue;
        }
        for (const name of [
          ...new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})]),
        ].sort(order)) {
          const inArtifact = Object.hasOwn(left ?? {}, name);
          const inOther = Object.hasOwn(right ?? {}, name);
          const artifactValue = inArtifact ? left[name] : null;
          const otherValue = inOther ? right[name] : null;
          if (
            (inArtifact && typeof artifactValue !== "string") ||
            (inOther && typeof otherValue !== "string")
          ) {
            unassessedFields.push(field + "/" + pointer(name));
            continue;
          }
          if (artifactValue !== otherValue)
            differences.push({
              field,
              name,
              change: !inOther
                ? "artifact-declared-only"
                : !inArtifact
                  ? side + "-declared-only"
                  : "declared-value-differs",
              artifactValue,
              otherValue,
              pointer: "/" + field + "/" + pointer(name),
              evidenceIds,
              otherEvidenceIds: other.evidenceIds ?? [],
              ...(side === "registry"
                ? { documentSha256: report.inputs.registryDocument.sha256 }
                : {}),
            });
        }
      }
    return {
      side,
      status: proven ? "declared-values-compared" : "not-assessed",
      normalization: "not-assessed",
      differences: take(differences),
      unassessedFields: take(unassessedFields),
    };
  }
  const result = {
    detailsVersion: "1",
    reportSchemaVersion: report.schemaVersion,
    versions: take([
      {
        analyzer: report.analyzerVersion,
        policy: report.policyVersion,
        limits: report.limitsVersion,
      },
    ]),
    scope: {
      method: "bounded-static-projection-of-existing-report",
      safetyVerdict: "not-provided",
      allCodeRead: false,
      vulnerabilityScan: "not-performed",
      licenseScan: "not-performed",
      cryptographicProvenance:
        "not-assessed-by-this-projection; consult recorded provenance status",
      additionalFetches: 0,
      additionalModelCalls: 0,
      targetExecution: "not-performed",
      limitation:
        "Accepted inventory and bounded observations only. Declaration omissions are not runtime absence. Partial coverage cannot establish package-wide absence; extension groups do not prove language or behavior. Raw schema-1 report retains the underlying accepted detail.",
    },
    identity: take([
      {
        requested: report.inputs.claim ?? null,
        artifactDigests: {
          sha256: report.inputs.artifact.sha256,
          sha512: report.inputs.artifact.sha512,
        },
      },
    ]),
    declarations: {
      side: "artifact",
      evidenceIdsOmitted,
      label: "publisher-declared; runtime behavior unverified",
      status: manifest.status,
      fields: take(
        [
          "name",
          "version",
          "description",
          "license",
          "licenses",
          "engines",
          "os",
          "cpu",
          "type",
          "main",
          "module",
          "exports",
          "bin",
          "types",
          "typings",
          "homepage",
          "keywords",
          "browser",
        ]
          .map(field)
          .sort((a, b) => order(a.field, b.field)),
      ),
    },
    entrypoints: {
      matching:
        "Safe exact relative declaration target only; no Node conditional selection, wildcard expansion, extension inference or runtime resolution. No exact match is not a package-wide absence claim.",
      traversalNodeLimit: 4096,
      traversalOmitted: targetTraversalOmitted,
      targets: take(targets),
    },
    dependencies: {
      transitive: "not-assessed",
      counting:
        "Exact declared entries per field; overlapping categories are not deduplicated. Invalid and omitted entries remain in declaredCount; boolean bundled declarations have no resolved count.",
      categories: [
        "dependencies",
        "optionalDependencies",
        "peerDependencies",
        "devDependencies",
        "bundledDependencies",
        "bundleDependencies",
      ].map((name) =>
        entries(name, name.includes("undle") ? "bundled" : "map"),
      ),
      peerMetadata: take([field("peerDependenciesMeta")]),
      comparisons: [dependencyDelta("source"), dependencyDelta("registry")],
    },
    scripts: {
      ...entries("scripts"),
      execution: "not-performed",
      bindingGyp: {
        interpretation:
          "Observed binding.gyp file and gypfile declaration only; npm implicit-install behavior is not executed or inferred beyond recorded policy cues.",
        files: take(files.filter((file) => file.path === "binding.gyp")),
        declaration: take([field("gypfile")]),
        recordedCues: take(
          report.policy.findings
            .map((finding, index) => ({
              ...finding,
              findingRef: `/policy/findings/${index}`,
            }))
            .filter((finding) => finding.ruleId === "lifecycle-implicit-gyp"),
        ),
      },
    },
    inventory: {
      scope: "accepted-artifact-regular-files",
      complete: report.coverage.inventory.complete,
      counts: {
        files: report.coverage.inventory.files,
        bytes: report.coverage.inventory.bytes,
        lowerBound: report.coverage.inventory.lowerBound,
      },
      files: take(files),
      typeGrouping:
        "Lowercase final path extension; (none) includes extensionless and dotfiles. Classification is lexical only.",
      typeGroups: take(
        [...extensions.values()].sort((a, b) =>
          order(a.extension, b.extension),
        ),
      ),
      topDirectories: take(
        [...topDirectories.values()].sort((a, b) =>
          order(a.directory, b.directory),
        ),
      ),
      largestFiles: take(
        [...files]
          .sort((a, b) => b.size - a.size || fileOrder(a, b))
          .slice(0, 20),
      ),
      sourceOnlyPaths: take([...report.coverage.sourceOnly].sort(order)),
      inertLinks: take(report.coverage.linkEntries),
      linkCounts: {
        artifact: report.coverage.links.artifact,
        source: report.coverage.links.source,
      },
      nonregularCounts: {
        artifact: report.coverage.nonregular.artifact,
        source: report.coverage.nonregular.source,
      },
    },
    capabilities: {
      label: "observed syntax references; execution and bindings unproven",
      referenceFormat:
        "cueRef is a JSON pointer into the raw report; existing cue IDs, when present, are preserved. evidenceIds refer to raw-report evidence IDs.",
      groups: take(
        [...capabilityGroups.values()].sort((a, b) =>
          order(a.ruleId, b.ruleId),
        ),
      ),
      observations: take(
        observations.map((cue) => ({
          ...cue,
          locations: (cue.evidenceIds ?? [])
            .map((id) => evidenceById.get(id))
            .filter(Boolean)
            .map(({ id, side, path, range }) => ({
              evidenceId: id,
              side,
              path,
              range,
            })),
        })),
      ),
    },
    provenance: {
      label:
        "report-recorded facts; publisher claims retain their recorded verification status",
      facts: take([
        { field: "source", value: report.source },
        ...["artifact", "sourceArchive", "registryDocument"]
          .filter((name) => report.inputs[name] !== undefined)
          .map((name) => ({ field: name, value: report.inputs[name] })),
      ]),
    },
    ai: {
      advisory: true,
      selection: {
        selectedGroups: Array.isArray(report.model.evidenceGroups)
          ? report.model.evidenceGroups.length
          : null,
        omittedGroups: Array.isArray(report.model.omittedEvidenceGroups)
          ? report.model.omittedEvidenceGroups.length
          : null,
        omittedEvidenceItems: Array.isArray(report.model.omittedEvidenceIds)
          ? report.model.omittedEvidenceIds.length
          : null,
        interpretation:
          "Prompt-selected groups as recorded, not full-file review or proof of model attention. Null means no selection count recorded; original modelReviewed counters are unchanged.",
      },
      validation:
        "Upstream model-result validation is preserved; this projection performs no new inference or usefulness assessment.",
      metadata: take([
        Object.fromEntries(
          Object.entries(report.model).filter(([key]) => key !== "hypotheses"),
        ),
      ]),
      hypotheses: take(
        report.model.status === "complete" &&
          Array.isArray(report.model.hypotheses)
          ? report.model.hypotheses
          : [],
      ),
    },
    coverage: {
      counters: {
        ...Object.fromEntries(
          [
            "inventory",
            "compared",
            "unresolved",
            "syntaxInspected",
            "modelReviewed",
          ].map((key) => [
            key,
            {
              files: report.coverage[key].files,
              bytes: report.coverage[key].bytes,
              ...(key === "inventory"
                ? {
                    complete: report.coverage.inventory.complete,
                    lowerBound: report.coverage.inventory.lowerBound,
                  }
                : {}),
            },
          ]),
        ),
        complete: report.coverage.complete,
        sourceAvailable: report.coverage.sourceAvailable,
        sourceComplete: report.coverage.sourceComplete,
        states: Object.fromEntries(
          ["byte-identical", "changed", "artifact-only", "not-compared"].map(
            (key) => [
              key,
              {
                files: report.coverage.states[key].files,
                bytes: report.coverage.states[key].bytes,
              },
            ],
          ),
        ),
      },
      effectiveLimits: take([
        {
          limits: report.inputs.limits ?? null,
          limitsDigest: report.inputs.limitsDigest ?? null,
        },
      ]),
      observations: take(
        report.annotations
          .map((item, index) => ({
            ...item,
            annotationRef: `/annotations/${index}`,
          }))
          .filter((item) =>
            ["syntax-scope", "syntax-not-inspected", "manifest-scope"].includes(
              item.type,
            ),
          ),
      ),
      failures: take(report.failures),
      policyFindings: take(report.policy.findings),
    },
    projection: {
      limits,
      sorting:
        "UTF-16 code-unit ascending: declaration fields, dependency/script keys, file path then originalPath, extension and ruleId. Dependency categories use the documented fixed field order. Bundled lists sort by JSON name then original index. exports object member order is preserved. Other lists preserve report order.",
    },
  };
  if (Buffer.byteLength(JSON.stringify(result)) > limits.maxTotalBytes)
    throw new TypeError("Package details metadata exceeds response cap");
  return result;
}
