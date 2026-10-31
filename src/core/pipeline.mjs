import { constants } from "node:fs";
import { open, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { readArchive, DEFAULT_LIMITS } from "./archive.mjs";
import { selectSourcePackage } from "./source.mjs";
import { compareInventories } from "./compare.mjs";
import { createReport } from "./report.mjs";
import { inspectJavaScript, addSyntaxInspection } from "./syntax.mjs";
import { addManifestObservations } from "./manifests.mjs";

export class LocalInputError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LocalInputError";
    this.code = code;
    this.exitCode = 2;
  }
}
function limitsFor(overrides = {}) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides))
    throw new LocalInputError("invalid-limits", "Limits must be an object");
  const defaults = { ...DEFAULT_LIMITS, retentionBudgetBytes: 134217728 };
  for (const [key, value] of Object.entries(overrides))
    if (
      !(key in defaults) ||
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > defaults[key]
    )
      throw new LocalInputError(
        "invalid-limits",
        "Local limits may only lower finite defaults",
      );
  return { ...defaults, ...overrides };
}
function safeDirectory(value, allowEmpty = false) {
  return (
    typeof value === "string" &&
    ((allowEmpty && value === "") ||
      (value.length > 0 &&
        !/^[a-z]:/i.test(value) &&
        !/[\0\\]/.test(value) &&
        !value.startsWith("/") &&
        value
          .split("/")
          .every((part) => part && part !== "." && part !== "..")))
  );
}
function validateOptions(options) {
  if (typeof options.tarballPath !== "string" || !options.tarballPath)
    throw new LocalInputError(
      "artifact-required",
      "A local artifact path is required",
    );
  if (options.sourceArchivePath !== undefined) {
    if (
      typeof options.sourceArchivePath !== "string" ||
      !options.sourceArchivePath ||
      !/^[a-f0-9]{40}$/.test(options.commit || "") ||
      !safeDirectory(options.sourceRoot)
    )
      throw new LocalInputError(
        "invalid-source-claim",
        "Selected source requires a local archive, full lowercase commit SHA and explicit safe root",
      );
  } else if (
    options.commit !== undefined ||
    options.sourceRoot !== undefined ||
    options.sourceDir !== undefined
  )
    throw new LocalInputError(
      "source-required",
      "Source options require an explicit local source archive",
    );
  if (
    options.sourceDir !== undefined &&
    !safeDirectory(options.sourceDir, true)
  )
    throw new LocalInputError(
      "invalid-source-directory",
      "Source directory must be a safe relative path",
    );
  if (
    options.claim !== undefined &&
    (!options.claim ||
      typeof options.claim !== "object" ||
      typeof options.claim.name !== "string" ||
      typeof options.claim.version !== "string")
  )
    throw new LocalInputError(
      "invalid-claim",
      "Identity claim requires an exact name and version",
    );
  if (
    options.cacheDir !== undefined &&
    (typeof options.cacheDir !== "string" || !options.cacheDir)
  )
    throw new LocalInputError(
      "invalid-cache",
      "Cache directory must be an explicit path",
    );
}
async function boundedRead(filename, cap, side) {
  let handle;
  try {
    handle = await open(filename, constants.O_RDONLY | constants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile())
      throw new LocalInputError(
        `${side}-read-failed`,
        "Input must be a regular local file",
      );
    if (before.size > BigInt(cap))
      throw new LocalInputError(
        `${side}-compressed-cap`,
        "Compressed input exceeds the configured byte cap",
      );
    const bytes = Buffer.allocUnsafe(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        Math.min(bytes.length - offset, 65536),
        offset,
      );
      if (bytesRead === 0)
        throw new LocalInputError(
          `${side}-read-changed`,
          "Local file changed during bounded read",
        );
      offset += bytesRead;
    }
    const extra = await handle.read(Buffer.alloc(1), 0, 1, offset);
    const after = await handle.stat({ bigint: true });
    if (
      extra.bytesRead ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new LocalInputError(
        `${side}-read-changed`,
        "Local file changed during bounded read",
      );
    return bytes;
  } catch (error) {
    if (error instanceof LocalInputError) throw error;
    if (typeof error.code === "string" && /^E[A-Z]+$/.test(error.code))
      throw new LocalInputError(
        `${side}-read-failed`,
        "Unable to read the selected local input",
      );
    throw error;
  } finally {
    if (handle) await handle.close();
  }
}
async function cacheBytes(cacheDir, inventory, bytes, observations) {
  if (cacheDir === undefined) return;
  const directory = path.join(cacheDir, "blobs", "sha256");
  const destination = path.join(directory, inventory.digest.sha256);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = await boundedRead(destination, bytes.length, "cache");
      if (!existing.equals(bytes)) throw new Error("Cache bytes differ");
    }
  } catch {
    observations.push({
      code: "cache-write-failed",
      message:
        "Original input was analyzed, but its private cache copy could not be verified",
    });
  }
}
function manifestFor(inventory, comparison, side) {
  const entry = inventory?.entries.find(
    (item) => item.type === "file" && item.path === "package.json",
  );
  const evidenceIds = comparison.evidence
    .filter((e) => e.side === side && e.path === "package.json")
    .map((e) => e.id);
  if (!entry || !Buffer.isBuffer(entry.content))
    return {
      status: "unavailable",
      reason: entry?.inspection || "missing-or-nonregular",
    };
  try {
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(entry.content),
    );
    if (!value || typeof value !== "object" || Array.isArray(value))
      return { status: "invalid", reason: "not-an-object" };
    return { status: "usable", value, evidenceIds };
  } catch {
    return { status: "invalid", reason: "invalid-json-or-encoding" };
  }
}
function artifactName(inventory) {
  const entry = inventory.entries.find(
    (item) => item.type === "file" && item.path === "package.json",
  );
  if (!Buffer.isBuffer(entry?.content)) return undefined;
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(entry.content),
    )?.name;
  } catch {
    return undefined;
  }
}

export async function analyzeLocal(options) {
  validateOptions(options);
  const limits = limitsFor(options.limits);
  const { retentionBudgetBytes, ...archiveLimits } = limits;
  const retentionBudget = { limitBytes: retentionBudgetBytes, usedBytes: 0 };
  const observations = [];
  const failures = [];
  const artifactBytes = await boundedRead(
    options.tarballPath,
    limits.compressedBytes,
    "artifact",
  );
  const artifact = await readArchive(artifactBytes, {
    kind: "artifact",
    limits: archiveLimits,
    retentionBudget,
  });
  failures.push(...artifact.failures.map((f) => ({ ...f, side: "artifact" })));
  await cacheBytes(options.cacheDir, artifact, artifactBytes, observations);
  let source = {
    status: "unresolved",
    method: "unresolved",
    complete: false,
    alternatives: [],
  };
  let sourceArchive = null;
  let selected = null;
  if (options.sourceArchivePath !== undefined) {
    source = {
      status: "unavailable",
      method: "user-full-SHA",
      commit: options.commit,
      complete: false,
      alternatives: [],
    };
    try {
      const sourceBytes = await boundedRead(
        options.sourceArchivePath,
        limits.compressedBytes,
        "source",
      );
      sourceArchive = await readArchive(sourceBytes, {
        kind: "source",
        sourceRoot: options.sourceRoot,
        limits: archiveLimits,
        retentionBudget,
      });
      await cacheBytes(
        options.cacheDir,
        sourceArchive,
        sourceBytes,
        observations,
      );
      failures.push(
        ...sourceArchive.failures.map((f) => ({ ...f, side: "source" })),
      );
      const selection = selectSourcePackage(sourceArchive, {
        ...(options.sourceDir === undefined
          ? {}
          : { directory: options.sourceDir }),
        packageName: artifactName(artifact),
      });
      source.status = selection.status;
      source.reason =
        selection.reason ||
        (sourceArchive.complete
          ? "explicit-local-source"
          : "incomplete-source-inventory");
      if (selection.directory !== null) source.directory = selection.directory;
      if (selection.status === "selected") {
        selected = { ...sourceArchive, entries: selection.entries };
        source.complete = sourceArchive.complete;
      } else
        failures.push({
          code: "source-selection-unresolved",
          message:
            "Selected source package could not be resolved unambiguously",
          reason: selection.reason,
        });
    } catch (error) {
      if (!(error instanceof LocalInputError)) throw error;
      failures.push({
        code: error.code,
        message: error.message,
        side: "source",
      });
    }
  }
  const comparison = compareInventories(artifact, selected);
  const manifests = {
    artifact: manifestFor(artifact, comparison, "artifact"),
    source: manifestFor(selected, comparison, "source"),
    registry: { status: "unavailable", reason: "offline" },
  };
  for (const side of ["artifact", "source"])
    if (manifests[side].status === "invalid")
      failures.push({
        code: `${side}-manifest-invalid`,
        message: "Package manifest is not a valid UTF-8 JSON object",
        side,
      });
  const inputs = {
    artifact: {
      ...artifact.digest,
      kind: "local",
      expectedIntegrity: { status: "unavailable" },
    },
    limits,
    ...(sourceArchive
      ? { sourceArchive: { ...sourceArchive.digest, kind: "local" } }
      : {}),
    ...(options.claim ? { claim: options.claim } : {}),
  };
  const report = createReport({
    inputs,
    source,
    comparison,
    manifests,
    failures,
    run: { surface: "cli", observations },
  });
  const inspected = addSyntaxInspection(
    report,
    inspectJavaScript(artifact, selected),
  );
  return addManifestObservations(inspected, { artifact, source: selected });
}

export { limitsFor as effectiveLimits, cacheBytes as preserveInputBytes };
