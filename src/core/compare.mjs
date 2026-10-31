import { createHash } from "node:crypto";

const states = ["byte-identical", "changed", "artifact-only", "not-compared"];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const linked = (entry) => entry.type === "symlink" || entry.type === "hardlink";
const count = () => ({ files: 0, bytes: 0 });
function add(counter, entry) {
  counter.files++;
  counter.bytes += entry.size;
  if (!Number.isSafeInteger(counter.bytes))
    throw new TypeError("Unsafe inventory byte count");
}
function checkInventory(inventory) {
  if (
    !inventory ||
    !Array.isArray(inventory.entries) ||
    typeof inventory.complete !== "boolean" ||
    !/^[a-f0-9]{64}$/.test(inventory.digest?.sha256 || "")
  )
    throw new TypeError("Invalid archive inventory");
  const seen = new Set();
  for (const entry of inventory.entries) {
    if (
      !["file", "directory", "symlink", "hardlink"].includes(entry.type) ||
      typeof entry.originalPath !== "string" ||
      !(entry.path === null || typeof entry.path === "string") ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0
    )
      throw new TypeError("Invalid inventory entry");
    if (entry.path !== null && seen.has(entry.path))
      throw new TypeError("Duplicate comparison path");
    if (entry.path !== null) seen.add(entry.path);
    if (linked(entry) && typeof entry.linkTarget !== "string")
      throw new TypeError("Invalid inert link target");
    if (
      entry.type === "file" &&
      (!/^[a-f0-9]{64}$/.test(entry.sha256 || "") ||
        !(entry.content === null || Buffer.isBuffer(entry.content)) ||
        (entry.content !== null &&
          (entry.content.length !== entry.size ||
            hash(entry.content) !== entry.sha256)))
    )
      throw new TypeError("Invalid regular file digest or retained bytes");
  }
}
function evidenceFor(side, inventory, entry, range) {
  const identity = [
    side,
    inventory.digest.sha256,
    entry.path ?? entry.originalPath,
    range,
  ];
  const evidence = {
    id: `ev-${hash(JSON.stringify(identity))}`,
    side,
    blobDigest: inventory.digest.sha256,
    path: entry.path,
    originalPath: entry.originalPath,
    fileSha256: entry.sha256,
    size: entry.size,
    range,
  };
  if (entry.content !== null) {
    const end = Math.min(range[1], range[0] + 512);
    try {
      evidence.excerpt = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(entry.content.subarray(range[0], end));
      evidence.excerptRange = [range[0], end];
    } catch {}
  }
  return evidence;
}
function changedSpans(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let aEnd = a.length;
  let bEnd = b.length;
  while (aEnd > start && bEnd > start && a[aEnd - 1] === b[bEnd - 1]) {
    aEnd--;
    bEnd--;
  }
  return { artifact: [start, aEnd], source: [start, bEnd] };
}

export function compareInventories(artifact, sourceOrNull) {
  checkInventory(artifact);
  if (sourceOrNull !== null) checkInventory(sourceOrNull);
  const source = sourceOrNull;
  const sourceEntries = new Map(
    (source?.entries || [])
      .filter((e) => e.path !== null)
      .map((e) => [e.path, e]),
  );
  function ancestorLink(target) {
    if (target === null) return null;
    const parts = target.split("/");
    let prefix = "";
    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part;
      const entry = sourceEntries.get(prefix);
      if (entry && linked(entry)) return entry;
    }
    return null;
  }
  const regular = artifact.entries
    .filter((e) => e.type === "file")
    .sort(
      (a, b) =>
        order(a.path ?? "", b.path ?? "") ||
        order(a.originalPath, b.originalPath),
    );
  const files = [];
  const evidence = [];
  const coverage = {
    inventory: {
      ...count(),
      complete: artifact.complete,
      lowerBound: !artifact.complete,
    },
    states: Object.fromEntries(states.map((state) => [state, count()])),
    compared: count(),
    unresolved: count(),
    syntaxInspected: count(),
    modelReviewed: count(),
    links: {
      artifact: artifact.entries.filter(linked).length,
      source: source?.entries.filter(linked).length || 0,
    },
    nonregular: {
      artifact: artifact.entries.filter((e) => e.type !== "file").length,
      source: source?.entries.filter((e) => e.type !== "file").length || 0,
    },
    linkEntries: [
      ["artifact", artifact],
      ["source", source],
    ]
      .flatMap(([side, inventory]) =>
        (inventory?.entries || []).filter(linked).map((e) => ({
          side,
          path: e.path,
          originalPath: e.originalPath,
          type: e.type,
          linkTarget: e.linkTarget,
        })),
      )
      .sort(
        (a, b) =>
          order(a.side, b.side) ||
          order(a.path ?? "", b.path ?? "") ||
          order(a.originalPath, b.originalPath),
      ),
    sourceAvailable: source !== null,
    sourceComplete: source?.complete ?? false,
    complete: artifact.complete && (source === null || source.complete),
    sourceOnly: [],
  };
  for (const entry of regular) {
    const twin = entry.path === null ? null : sourceEntries.get(entry.path);
    const link = ancestorLink(entry.path);
    const file = {
      path: entry.path,
      originalPath: entry.originalPath,
      size: entry.size,
      artifactSha256: entry.sha256,
      state: "not-compared",
      localization: "whole-file",
      evidenceIds: [],
    };
    if (entry.path === null) file.reason = "prefixless";
    else if (!source) file.reason = "source-unavailable";
    else if (link) {
      file.reason = "source-link";
      file.sourceLink = {
        path: link.path,
        type: link.type,
        linkTarget: link.linkTarget,
      };
    } else if (twin?.type === "file") {
      file.sourceSha256 = twin.sha256;
      file.state =
        entry.size === twin.size && entry.sha256 === twin.sha256
          ? "byte-identical"
          : "changed";
      if (
        file.state === "changed" &&
        entry.content !== null &&
        twin.content !== null
      ) {
        file.localization = "byte-spans";
        file.spans = changedSpans(entry.content, twin.content);
      }
    } else if (!source.complete) file.reason = "source-incomplete";
    else if (twin) file.reason = "source-nonregular";
    else file.state = "artifact-only";
    const artifactEvidence = evidenceFor(
      "artifact",
      artifact,
      entry,
      file.spans?.artifact || [0, entry.size],
    );
    evidence.push(artifactEvidence);
    file.evidenceIds.push(artifactEvidence.id);
    if (twin?.type === "file" && !link && entry.path !== null) {
      const sourceEvidence = evidenceFor(
        "source",
        source,
        twin,
        file.spans?.source || [0, twin.size],
      );
      evidence.push(sourceEvidence);
      file.evidenceIds.push(sourceEvidence.id);
    }
    add(coverage.inventory, entry);
    add(coverage.states[file.state], entry);
    if (file.state === "changed" || file.state === "byte-identical")
      add(coverage.compared, entry);
    if (file.state !== "byte-identical") add(coverage.unresolved, entry);
    files.push(file);
  }
  const artifactPaths = new Set(artifact.entries.map((e) => e.path));
  coverage.sourceOnly = [...sourceEntries.values()]
    .filter((e) => e.type !== "directory" && !artifactPaths.has(e.path))
    .map((e) => e.path)
    .sort(order);
  return { files, coverage, evidence };
}
