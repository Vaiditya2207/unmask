import { createHash } from "node:crypto";
import { validateReport } from "./report.mjs";

export const MANIFEST_LIMITS = Object.freeze({
  fieldNodes: 4096,
  depth: 12,
  valueBytes: 65536,
  totalValueBytes: 262144,
  fieldComparisons: 8192,
  cues: 128,
  declarations: 256,
  pathComparisons: 20000,
  annotations: 512,
});
const fields = [
  ["dependencies"],
  ["optionalDependencies"],
  ["peerDependencies"],
  ["bundledDependencies"],
  ["bundleDependencies"],
  ["peerDependenciesMeta"],
  ["main"],
  ["module"],
  ["bin"],
  ["exports"],
  ["scripts", "preinstall"],
  ["scripts", "install"],
  ["scripts", "postinstall"],
  ["name"],
  ["version"],
  ["browser"],
  ["types"],
  ["typings"],
  ["os"],
  ["cpu"],
  ["engines"],
  ["gypfile"],
];
const entrypoints = new Set(["main", "module", "bin", "exports"]);
const dependencyFields = new Set([
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "bundledDependencies",
  "bundleDependencies",
]);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const pointer = (parts) =>
  "/" +
  parts
    .map((part) => String(part).replace(/~/g, "~0").replace(/\//g, "~1"))
    .join("/");
const absent = () => ({
  known: true,
  present: false,
  type: "absent",
  signature: "absent",
  children: new Map(),
  keys: [],
});
class Unassessed extends Error {}
function wholeEvidence(result, side, inventory) {
  const entry = inventory?.entries.find(
    (item) => item.path === "package.json" && item.type === "file",
  );
  const blob = (
    side === "artifact" ? result.inputs.artifact : result.inputs.sourceArchive
  )?.sha256;
  const existing = result.evidence.find(
    (item) =>
      item.side === side &&
      item.path === "package.json" &&
      item.blobDigest === blob &&
      item.range[0] === 0 &&
      item.range[1] === item.size &&
      (!entry ||
        (item.fileSha256 === entry.sha256 && item.size === entry.size)),
  );
  if (existing) return existing;
  if (!entry || !blob || inventory.digest?.sha256 !== blob) return null;
  const range = [0, entry.size];
  const evidence = {
    id: `ev-${hash(JSON.stringify([side, blob, "package.json", range]))}`,
    side,
    blobDigest: blob,
    path: "package.json",
    originalPath: entry.originalPath,
    fileSha256: entry.sha256,
    size: entry.size,
    range,
  };
  if (Buffer.isBuffer(entry.content)) {
    for (
      let end = Math.min(entry.size, 512);
      end >= Math.max(0, Math.min(entry.size, 512) - 3);
      end--
    ) {
      try {
        evidence.excerpt = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(entry.content.subarray(0, end));
        evidence.excerptRange = [0, end];
        break;
      } catch {}
    }
  }
  if (!result.evidence.some((item) => item.id === evidence.id))
    result.evidence.push(evidence);
  return evidence;
}

export function addManifestObservations(
  report,
  { artifact, source, limits: overrides } = {},
) {
  validateReport(report);
  const limits = {
    ...MANIFEST_LIMITS,
    ...(overrides ?? report.inputs.limits?.manifest ?? {}),
  };
  for (const [key, value] of Object.entries(limits))
    if (
      !Object.hasOwn(MANIFEST_LIMITS, key) ||
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > MANIFEST_LIMITS[key]
    )
      throw new TypeError("Invalid manifest observation limit");
  const result = structuredClone(report);
  result.cues = result.cues.filter((item) => item.module !== "manifest");
  result.annotations = result.annotations.filter(
    (item) => item.module !== "manifest",
  );
  result.inputs.limits = { ...result.inputs.limits, manifest: limits };
  const reasons = new Set();
  const counters = {
    fieldNodes: 0,
    valueBytes: 0,
    fieldComparisons: 0,
    cues: 0,
    declarations: 0,
    pathComparisons: 0,
    annotations: 0,
  };
  const proofs = {
    artifact: wholeEvidence(result, "artifact", artifact),
    source: wholeEvidence(result, "source", source),
  };
  const usable = (side) =>
    result.manifests[side]?.status === "usable" &&
    (side === "registry"
      ? /^[a-f0-9]{64}$/.test(result.inputs.registryDocument?.sha256 || "")
      : Boolean(proofs[side]));
  const sourceUsable =
    usable("source") &&
    usable("artifact") &&
    ["selected", "resolved"].includes(result.source.status) &&
    result.source.complete === true &&
    result.coverage.sourceComplete === true &&
    !["unresolved", "conflicting"].includes(result.source.method);
  for (const side of ["artifact", "source"])
    if (result.manifests[side]?.status === "usable" && !proofs[side])
      reasons.add(`${side}-manifest-evidence-unavailable`);
  const cache = new Map();
  function consume(bytes) {
    if (bytes > limits.totalValueBytes - counters.valueBytes)
      throw new Unassessed("total-value-cap");
    counters.valueBytes += bytes;
  }
  function snapshot(value, depth = 0) {
    if (counters.fieldNodes >= limits.fieldNodes)
      throw new Unassessed("field-cap");
    counters.fieldNodes++;
    if (depth > limits.depth) throw new Unassessed("depth-cap");
    const type =
      value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    const node = {
      known: true,
      present: true,
      type,
      value,
      children: new Map(),
      keys: [],
    };
    if (type !== "object" && type !== "array") {
      if (type === "string" && Buffer.byteLength(value) > limits.valueBytes)
        throw new Unassessed("field-value-cap");
      node.signature = JSON.stringify(value);
      consume(Buffer.byteLength(node.signature));
    } else {
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        if (node.keys.length >= limits.fieldNodes - counters.fieldNodes)
          throw new Unassessed("field-cap");
        node.keys.push(key);
        consume(Buffer.byteLength(key));
      }
      for (const key of node.keys)
        node.children.set(key, snapshot(value[key], depth + 1));
      node.signature =
        type === "array"
          ? "[" +
            node.keys.map((key) => node.children.get(key).signature).join(",") +
            "]"
          : "{" +
            node.keys
              .map(
                (key) =>
                  JSON.stringify(key) + ":" + node.children.get(key).signature,
              )
              .join(",") +
            "}";
    }
    if (Buffer.byteLength(node.signature) > limits.valueBytes)
      throw new Unassessed("field-value-cap");
    return node;
  }
  function field(side, parts) {
    const key = side + ":" + pointer(parts);
    if (cache.has(key)) return cache.get(key);
    let node = { known: false, present: false };
    if (usable(side)) {
      let value = result.manifests[side].value,
        present = true;
      for (const part of parts) {
        if (
          value === null ||
          typeof value !== "object" ||
          !Object.hasOwn(value, part)
        ) {
          present = false;
          break;
        }
        value = value[part];
      }
      try {
        node = present ? snapshot(value) : absent();
      } catch (error) {
        if (!(error instanceof Unassessed)) throw error;
        reasons.add(error.message);
      }
    }
    cache.set(key, node);
    return node;
  }
  function binding(side, parts, node) {
    const resultBinding = {
      side,
      pointer: pointer(parts),
      present: node.present,
    };
    if (node.present) {
      resultBinding.valueType = node.type;
      if (node.type === "object" || node.type === "array") {
        resultBinding.valueSha256 = hash(node.signature);
        resultBinding.keyOrder = node.keys;
      } else resultBinding.value = node.value;
    }
    if (side === "registry")
      resultBinding.documentSha256 = result.inputs.registryDocument.sha256;
    else {
      const proof = proofs[side];
      resultBinding.evidenceIds = [proof.id];
      resultBinding.evidenceScope = "whole-manifest";
      resultBinding.excerptRange = proof.excerptRange || null;
      resultBinding.excerptOmitted =
        !proof.excerptRange || proof.excerptRange[1] < proof.size;
    }
    return resultBinding;
  }
  function emit(ruleId, priority, parts, bindings, extra = {}) {
    if (counters.cues >= limits.cues) {
      reasons.add("cue-cap");
      return;
    }
    counters.cues++;
    const summaries = {
      "manifest-runtime-dependency-added":
        "Dependency declaration added relative to the complete selected source manifest.",
      "manifest-entrypoint-source-absent":
        "Declared entrypoint differs from the complete selected source manifest; target content is unverified.",
      "manifest-lifecycle-source-absent":
        "Nonempty install hook differs from the complete selected source manifest; target code was not executed.",
      "manifest-registry-runtime-divergence":
        "Registry and artifact runtime fields differ; npm normalization is unassessed.",
      "manifest-registry-source-observation":
        "Registry and source declared fields differ; normalization is unassessed.",
      "manifest-artifact-runtime-observation":
        "Artifact declaration observed; source comparison is unavailable.",
      "manifest-runtime-field-difference":
        "Declared fields differ; this observation does not establish runtime behavior.",
    };
    result.cues.push({
      module: "manifest",
      ruleId,
      priority,
      summary: summaries[ruleId],
      field: pointer(parts),
      bindings,
      evidenceIds: [
        ...new Set(bindings.flatMap((item) => item.evidenceIds || [])),
      ].sort(),
      ...extra,
    });
  }
  function diff(left, right, parts, visit) {
    if (counters.fieldComparisons >= limits.fieldComparisons) {
      reasons.add("field-comparison-cap");
      return;
    }
    counters.fieldComparisons++;
    if (!left.known || !right.known || left.signature === right.signature)
      return;
    const lContainer = left.type === "object" || left.type === "array",
      rContainer = right.type === "object" || right.type === "array";
    if (
      (lContainer && rContainer && left.type === right.type) ||
      (lContainer && !right.present) ||
      (rContainer && !left.present)
    ) {
      const keys = [...new Set([...left.keys, ...right.keys])].sort();
      if (keys.length === 0) {
        visit(left, right, parts, "value");
        return;
      }
      if (
        left.present &&
        right.present &&
        left.keys.length === right.keys.length &&
        left.keys.every((key) => right.children.has(key)) &&
        left.keys.join("\0") !== right.keys.join("\0")
      )
        visit(left, right, parts, "member-order");
      for (const key of keys)
        diff(
          left.children.get(key) || absent(),
          right.children.get(key) || absent(),
          [...parts, key],
          visit,
        );
    } else visit(left, right, parts, "value");
  }
  const pairs = {
    artifactSource: sourceUsable ? "available" : "unavailable",
    registryArtifact:
      usable("registry") && usable("artifact") ? "available" : "unavailable",
    registrySource:
      usable("registry") && usable("source") ? "available" : "unavailable",
  };
  if (!sourceUsable) reasons.add("source-comparison-unavailable");
  for (const parts of fields) {
    const a = field("artifact", parts),
      s = field("source", parts),
      r = field("registry", parts);
    if (sourceUsable) {
      diff(a, s, parts, (left, right, path, change) => {
        const binds = [
          binding("artifact", path, left),
          binding("source", path, right),
        ];
        const root = path[0];
        if (
          dependencyFields.has(root) &&
          path.length > 1 &&
          left.present &&
          !right.present &&
          left.type === "string" &&
          left.value.length > 0
        )
          emit("manifest-runtime-dependency-added", "MEDIUM", path, binds);
        else if (
          root === "scripts" &&
          left.present &&
          left.type === "string" &&
          left.value.length > 0
        )
          emit("manifest-lifecycle-source-absent", "HIGH", path, binds);
        else if (
          entrypoints.has(root) &&
          left.present &&
          ((left.type === "string" && left.value.length > 0) ||
            (change === "member-order" && root === "exports") ||
            (left.type === "object" && right.present))
        )
          emit("manifest-entrypoint-source-absent", "HIGH", path, binds, {
            change,
          });
        else
          emit("manifest-runtime-field-difference", "LOW", path, binds, {
            change,
          });
      });
    } else if (a.known && a.present && usable("artifact"))
      emit(
        "manifest-artifact-runtime-observation",
        "LOW",
        parts,
        [binding("artifact", parts, a)],
        { sourceComparison: "unavailable" },
      );
    if (pairs.registryArtifact === "available")
      diff(r, a, parts, (left, right, path, change) =>
        emit(
          "manifest-registry-runtime-divergence",
          "MEDIUM",
          path,
          [binding("registry", path, left), binding("artifact", path, right)],
          { normalization: "unassessed", change },
        ),
      );
    if (pairs.registrySource === "available")
      diff(r, s, parts, (left, right, path, change) =>
        emit(
          "manifest-registry-source-observation",
          "LOW",
          path,
          [binding("registry", path, left), binding("source", path, right)],
          { normalization: "unassessed", change },
        ),
      );
  }
  const declarations = [];
  function literal(value) {
    if (
      typeof value !== "string" ||
      !value ||
      /[\0\\*?\[\]{}!]/.test(value) ||
      value.startsWith("/") ||
      /^[a-z]:/i.test(value)
    )
      return null;
    const normalized = (
      value.startsWith("./") ? value.slice(2) : value
    ).replace(/\/$/, "");
    return normalized &&
      normalized
        .split("/")
        .every((part) => part && part !== "." && part !== "..")
      ? normalized
      : null;
  }
  function declaration(node, parts, prefix) {
    if (!node.known || !node.present) return;
    if (node.type !== "string" || !literal(node.value)) {
      reasons.add("unsupported-declaration");
      return;
    }
    if (counters.declarations >= limits.declarations)
      throw new Unassessed("declaration-cap");
    counters.declarations++;
    declarations.push({
      path: literal(node.value),
      prefix,
      field: pointer(parts),
      binding: binding("source", parts, node),
    });
  }
  function leaves(node, parts, mode) {
    if (!node.known || !node.present) return;
    if (parts.some((part) => /[\*?\[\]{}!]/.test(part))) {
      reasons.add("unsupported-declaration");
      return;
    }
    if (node.type === "string") {
      declaration(node, parts, false);
      return;
    }
    if (node.type === "null") return;
    if (node.type !== "object" && node.type !== "array") {
      reasons.add("unsupported-declaration");
      return;
    }
    for (const key of node.keys) {
      const child = node.children.get(key);
      if (mode === "bin" && child.type !== "string") {
        reasons.add("unsupported-declaration");
        continue;
      }
      leaves(child, [...parts, key], mode);
    }
  }
  if (
    usable("source") &&
    ["selected", "resolved"].includes(result.source.status)
  ) {
    try {
      const fileList = field("source", ["files"]);
      if (fileList.known && fileList.present) {
        if (fileList.type === "array")
          for (const key of fileList.keys)
            declaration(fileList.children.get(key), ["files", key], true);
        else reasons.add("unsupported-declaration");
      }
      for (const name of ["main", "module"])
        declaration(field("source", [name]), [name], false);
      leaves(field("source", ["bin"]), ["bin"], "bin");
      leaves(field("source", ["exports"]), ["exports"], "exports");
      for (const declared of declarations)
        for (const file of result.files) {
          if (counters.pathComparisons >= limits.pathComparisons)
            throw new Unassessed("path-comparison-cap");
          counters.pathComparisons++;
          if (
            file.path !== declared.path &&
            !(declared.prefix && file.path?.startsWith(declared.path + "/"))
          )
            continue;
          if (counters.annotations >= limits.annotations)
            throw new Unassessed("annotation-cap");
          counters.annotations++;
          result.annotations.push({
            module: "manifest",
            type: "declared-output-location",
            label: "declared-output-location; content unverified",
            path: file.path,
            field: declared.field,
            bindings: [declared.binding],
            evidenceIds: declared.binding.evidenceIds,
          });
        }
    } catch (error) {
      if (!(error instanceof Unassessed)) throw error;
      reasons.add(error.message);
    }
  }
  result.annotations.push({
    module: "manifest",
    type: "manifest-scope",
    sourceDeclarationStatus:
      usable("source") &&
      ["selected", "resolved"].includes(result.source.status)
        ? "available"
        : "unassessed",
    sourceDeclarationReason:
      typeof result.manifests.source.reason === "string"
        ? result.manifests.source.reason.slice(0, 128)
        : result.manifests.source.status,
    status: reasons.size ? "partial" : "complete",
    pairs,
    reasons: [...reasons].sort(),
    unassessed: [...reasons].sort(),
    counts: counters,
    limitation:
      "Declarations describe observed fields only; no normalization, glob expansion, publish-set prediction, build reproduction or content equivalence is established.",
  });
  return validateReport(result);
}
