import { constants, open } from "node:fs/promises";
import { LocalInputError } from "../core/pipeline.mjs";

export const LOCKFILE_LIMITS = Object.freeze({
  maxBytes: 32 * 1024 * 1024,
  maxEntries: 100000,
});
const EXACT =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const EDGE_TYPES = [
  ["dependencies", "prod"],
  ["optionalDependencies", "optional"],
  ["peerDependencies", "peer"],
  ["devDependencies", "dev"],
];
const invalid = (message) => new LocalInputError("lockfile-invalid", message);
const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const isExactVersion = (value) =>
  typeof value === "string" &&
  value.length <= 256 &&
  EXACT.test(value) &&
  !value
    .split("+")[0]
    .split("-")
    .slice(1)
    .join("-")
    .split(".")
    .some((part) => /^0\d+$/.test(part));
export const isPackageName = (value) =>
  typeof value === "string" && value.length <= 214 && NAME.test(value);

function nameFromKey(key) {
  const index = key.lastIndexOf("node_modules/");
  return index === -1 ? null : key.slice(index + "node_modules/".length);
}

export function parentKey(key) {
  const index = key.lastIndexOf("/node_modules/");
  return index === -1 ? "" : key.slice(0, index);
}

export const NPM_REGISTRY_HOST = "registry.npmjs.org";
export function isNpmRegistryTarball(resolved, name, version) {
  if (typeof resolved !== "string") return false;
  try {
    const url = new URL(resolved);
    return (
      url.protocol === "https:" &&
      url.host === NPM_REGISTRY_HOST &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === `/${name}/-/${name.split("/").pop()}-${version}.tgz`
    );
  } catch {
    return false;
  }
}

function classify(key, raw) {
  if (key === "") return { kind: "root", reason: null };
  if (raw.link === true) return { kind: "link", reason: "workspace-or-link" };
  if (!key.includes("node_modules/"))
    return { kind: "workspace", reason: "workspace-or-link" };
  if (raw.inBundle === true)
    return { kind: "bundled", reason: "bundled-dependency" };
  const name = raw.name ?? nameFromKey(key);
  if (!isPackageName(name)) return { kind: "invalid", reason: "invalid-name" };
  if (typeof raw.version !== "string")
    return { kind: "invalid", reason: "missing-version" };
  if (/^(?:git\+|git:|github:|https?:|file:)/.test(raw.version))
    return { kind: "url", reason: "non-registry-source" };
  if (!isExactVersion(raw.version))
    return { kind: "invalid", reason: "inexact-version" };
  if (
    raw.resolved !== undefined &&
    !isNpmRegistryTarball(raw.resolved, name, raw.version)
  )
    return { kind: "url", reason: "non-registry-source" };
  return { kind: "registry", reason: null };
}

function edges(raw) {
  const result = [];
  const peerMeta = isObject(raw.peerDependenciesMeta)
    ? raw.peerDependenciesMeta
    : {};
  for (const [field, type] of EDGE_TYPES) {
    const value = raw[field];
    if (value === undefined) continue;
    if (!isObject(value)) throw invalid(`Lockfile ${field} must be an object.`);
    for (const [name, range] of Object.entries(value)) {
      // Legacy or unusual names stay as edges; only their own entries are classified invalid.
      if (
        typeof range !== "string" ||
        !name ||
        name.length > 214 ||
        /[\0-\x1f\x7f\\]/.test(name)
      )
        throw invalid(`Lockfile ${field} contains an invalid entry.`);
      result.push({
        name,
        range,
        type,
        optional:
          type === "optional" ||
          (type === "peer" && peerMeta[name]?.optional === true),
      });
    }
  }
  return result;
}

export function parseLockfile(text, limits = LOCKFILE_LIMITS) {
  if (typeof text !== "string" || Buffer.byteLength(text) > limits.maxBytes)
    throw invalid("Lockfile is missing or exceeds the size limit.");
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw invalid("Lockfile is not valid JSON.");
  }
  if (!isObject(data)) throw invalid("Lockfile must be a JSON object.");
  if (![2, 3].includes(data.lockfileVersion))
    throw new LocalInputError(
      "lockfile-unsupported",
      "Only npm lockfileVersion 2 or 3 (with a packages map) is supported.",
    );
  if (!isObject(data.packages) || !isObject(data.packages[""]))
    throw invalid("Lockfile packages map with a root entry is required.");
  const keys = Object.keys(data.packages);
  if (keys.length > limits.maxEntries)
    throw invalid("Lockfile exceeds the entry limit.");
  const entries = new Map();
  for (const key of keys) {
    const raw = data.packages[key];
    if (
      !isObject(raw) ||
      key.length > 4096 ||
      (key !== "" &&
        key
          .split("/")
          .some(
            (part) => ["", ".", ".."].includes(part) || part.includes("\\"),
          ))
    )
      throw invalid("Lockfile contains an invalid package entry.");
    const { kind, reason } = classify(key, raw);
    entries.set(key, {
      key,
      name:
        key === ""
          ? (raw.name ?? data.name ?? null)
          : (raw.name ?? nameFromKey(key) ?? key),
      version: typeof raw.version === "string" ? raw.version : null,
      kind,
      reason,
      dev: raw.dev === true,
      optional: raw.optional === true || raw.devOptional === true,
      bundled: raw.inBundle === true,
      resolved: typeof raw.resolved === "string" ? raw.resolved : null,
      integrity: typeof raw.integrity === "string" ? raw.integrity : null,
      bound:
        kind === "registry" &&
        isNpmRegistryTarball(
          raw.resolved,
          raw.name ?? nameFromKey(key),
          raw.version,
        ) &&
        /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(raw.integrity ?? ""),
      edges: kind === "link" ? [] : edges(raw),
    });
  }
  return { lockfileVersion: data.lockfileVersion, entries };
}

export async function readLockfile(filename, limits = LOCKFILE_LIMITS) {
  const unreadable = () =>
    new LocalInputError(
      "lockfile-unreadable",
      "The lockfile must be a readable regular file within the size limit; pass --lockfile PATH to package-lock.json.",
    );
  let handle;
  try {
    // Nonblocking open plus fstat rejects FIFOs/devices before any read.
    handle = await open(filename, constants.O_RDONLY | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > limits.maxBytes) throw unreadable();
    const buffer = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length !== info.size) throw unreadable();
    return parseLockfile(buffer.subarray(0, length).toString("utf8"), limits);
  } catch (error) {
    if (error instanceof LocalInputError) throw error;
    throw unreadable();
  } finally {
    await handle?.close();
  }
}

export function resolveEdge(lock, fromKey, name) {
  let base = fromKey;
  for (let step = 0; step < 4096; step++) {
    const candidate = (base ? base + "/" : "") + "node_modules/" + name;
    const entry = lock.entries.get(candidate);
    if (entry) {
      if (entry.kind !== "link") return entry;
      return lock.entries.get(entry.resolved ?? "") ?? null;
    }
    if (base === "") return null;
    base = parentKey(base);
  }
  return null;
}

export function unresolvedEdges(lock, { omitDev = false } = {}) {
  const missing = [];
  for (const entry of lock.entries.values()) {
    if (entry.kind === "link" || (omitDev && entry.dev)) continue;
    const project = ["root", "workspace"].includes(entry.kind);
    for (const edge of entry.edges) {
      if (edge.optional || (edge.type === "dev" && (!project || omitDev)))
        continue;
      if (!resolveEdge(lock, entry.key, edge.name))
        missing.push({ from: entry.key, name: edge.name, type: edge.type });
    }
  }
  return missing;
}

export function exactTargets(lock, { omitDev = false } = {}) {
  const unique = new Map();
  const skipped = {};
  let considered = 0;
  const unresolved = unresolvedEdges(lock, { omitDev });
  if (unresolved.length) skipped["unresolved-dependency"] = unresolved.length;
  for (const entry of lock.entries.values()) {
    if (["root", "workspace", "link"].includes(entry.kind)) continue;
    if (omitDev && entry.dev) continue;
    considered++;
    if (entry.kind !== "registry") {
      skipped[entry.reason] = (skipped[entry.reason] ?? 0) + 1;
      continue;
    }
    const spec = `${entry.name}@${entry.version}`;
    const target = unique.get(spec) ?? {
      spec,
      name: entry.name,
      version: entry.version,
      locations: [],
      bound: true,
      integrity: [],
    };
    target.locations.push(entry.key);
    target.bound &&= entry.bound;
    if (entry.integrity && !target.integrity.includes(entry.integrity))
      target.integrity.push(entry.integrity);
    if (target.integrity.length > 1) target.bound = false;
    unique.set(spec, target);
  }
  return {
    considered,
    targets: [...unique.values()].sort((a, b) =>
      a.spec < b.spec ? -1 : a.spec > b.spec ? 1 : 0,
    ),
    skipped,
    unresolved: unresolved.slice(0, 100),
  };
}
