import { parsePackageSpec } from "./acquire.mjs";

export const GRAPH_LIMITS = Object.freeze({
  entries: 20000,
  locations: 20,
  edges: 200000,
});
export const PATH_LIMITS = Object.freeze({
  paths: 20,
  depth: 32,
  visits: 20000,
});
const REGISTRY = "https://registry.npmjs.org/";

export class LockfileError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function nameFromKey(key) {
  const segments = key.split("/");
  const start = segments.indexOf("node_modules");
  if (
    start < 0 ||
    segments.slice(0, start).some((part) => ["", ".", ".."].includes(part))
  )
    return null;
  const parts = [];
  for (let i = start; i < segments.length;) {
    if (segments[i] !== "node_modules") return null;
    const scoped = segments[i + 1]?.startsWith("@");
    const name = scoped
      ? `${segments[i + 1]}/${segments[i + 2]}`
      : segments[i + 1];
    if (!name || (scoped && !segments[i + 2])) return null;
    parts.push(name);
    i += scoped ? 3 : 2;
  }
  return parts.length ? parts.at(-1) : null;
}

function exact(name, version) {
  try {
    return parsePackageSpec(`${name}@${version}`);
  } catch {
    return null;
  }
}

function classify(key, entry) {
  if (!object(entry)) return { reason: "invalid-entry" };
  const name = nameFromKey(key);
  // Only a key outside node_modules with no artifact claim can be local workspace code.
  if (name === null)
    return !key.split("/").includes("node_modules") &&
      typeof entry.version === "string" &&
      entry.resolved === undefined &&
      entry.integrity === undefined &&
      entry.inBundle !== true
      ? { local: true, reason: "workspace-package" }
      : { reason: "invalid-location" };
  if (entry.link === true) return { name, local: true, reason: "linked-local" };
  if (typeof entry.name === "string" && entry.name !== name)
    return { name, reason: "alias-identity" };
  if (entry.inBundle === true) return { name, reason: "bundled-dependency" };
  if (typeof entry.version !== "string") return { name, reason: "no-version" };
  const claim = exact(name, entry.version);
  if (!claim) return { name, reason: "non-exact-version" };
  if (typeof entry.resolved !== "string")
    return { name, reason: "missing-resolved" };
  if (!entry.resolved.startsWith(REGISTRY))
    return { name, reason: "non-registry-resolved" };
  const base = name.includes("/") ? name.split("/")[1] : name;
  if (entry.resolved !== `${REGISTRY}${name}/-/${base}-${claim.version}.tgz`)
    return { name, reason: "resolved-identity-mismatch" };
  return { name, claim };
}

// Parses npm lockfile v2/v3 package entries into exact registry identities without trusting non-registry claims.
export function parseNpmLockfile(input, { limits: overrides = {} } = {}) {
  const limits = { ...GRAPH_LIMITS, ...overrides };
  let lock = input;
  if (typeof input === "string") {
    try {
      lock = JSON.parse(input);
    } catch {
      throw new LockfileError("invalid-json");
    }
  }
  if (!object(lock)) throw new LockfileError("invalid-lockfile");
  if (![2, 3].includes(lock.lockfileVersion))
    throw new LockfileError("unsupported-lockfile-version");
  if (!object(lock.packages)) throw new LockfileError("missing-packages");
  const keys = Object.keys(lock.packages);
  if (keys.length > limits.entries) throw new LockfileError("entry-limit");
  const root = lock.packages[""];
  const identities = new Map();
  const integrities = new Map();
  const bySpec = new Map();
  const rejected = [];
  const local = [];
  for (const key of keys) {
    if (key === "") continue;
    const entry = lock.packages[key];
    const result = classify(key, entry);
    const flags = {
      dev: entry?.dev === true,
      optional: entry?.optional === true || entry?.devOptional === true,
    };
    if (result.local) {
      local.push({ location: key, reason: result.reason });
      continue;
    }
    if (!result.claim) {
      rejected.push({
        location: key,
        name: result.name ?? null,
        reason: result.reason,
        ...flags,
      });
      continue;
    }
    const spec = `${result.claim.name}@${result.claim.version}`;
    const identity = identities.get(spec) ?? {
      spec,
      name: result.claim.name,
      version: result.claim.version,
      locations: [],
      locationCount: 0,
      dev: true,
      optional: true,
    };
    identity.locationCount++;
    bySpec.set(spec, [...(bySpec.get(spec) ?? []), key]);
    if (identity.locations.length < limits.locations)
      identity.locations.push(key);
    const integrity =
      typeof entry.integrity === "string" &&
      /^sha(?:256|384|512)-[A-Za-z0-9+/]{1,200}={0,2}$/.test(entry.integrity)
        ? entry.integrity
        : "";
    integrities.set(spec, (integrities.get(spec) ?? new Set()).add(integrity));
    identity.dev &&= flags.dev;
    identity.optional &&= flags.optional;
    identities.set(spec, identity);
  }
  return {
    lockfileVersion: lock.lockfileVersion,
    root: {
      name: typeof root?.name === "string" ? root.name : null,
      version: typeof root?.version === "string" ? root.version : null,
    },
    entries: keys.length - (Object.hasOwn(lock.packages, "") ? 1 : 0),
    identities: [...identities.values()]
      .map((identity) => {
        const seen = [...integrities.get(identity.spec)];
        const integrityStatus =
          seen.length > 1 ? "conflicting" : seen[0] ? "consistent" : "missing";
        return {
          ...identity,
          integrity: integrityStatus === "consistent" ? seen[0] : null,
          integrityStatus,
        };
      })
      .sort((a, b) => (a.spec < b.spec ? -1 : a.spec > b.spec ? 1 : 0)),
    rejected,
    local,
    index: indexEdges(lock.packages, keys, bySpec, limits),
  };
}

function parentLocation(location) {
  const at = location.lastIndexOf("/node_modules/");
  return at >= 0 ? location.slice(0, at) : "";
}

// Resolves each declared dependency with node_modules lookup from the dependent location upward, following workspace links.
function indexEdges(packages, keys, bySpec, limits) {
  const reverse = new Map();
  let edges = 0,
    unresolved = 0,
    truncated = false;
  for (const from of keys) {
    const entry = packages[from];
    if (!object(entry)) continue;
    const declared = [
      entry.dependencies,
      entry.optionalDependencies,
      entry.peerDependencies,
      from.startsWith("node_modules/") ? undefined : entry.devDependencies,
    ];
    const names = new Set(declared.filter(object).flatMap(Object.keys));
    for (const name of names) {
      if (++edges > limits.edges) {
        truncated = true;
        break;
      }
      let target = null;
      for (let at = from; target === null; at = parentLocation(at)) {
        const candidate = `${at ? `${at}/` : ""}node_modules/${name}`;
        if (Object.hasOwn(packages, candidate)) target = candidate;
        else if (at === "") break;
      }
      if (target === null) {
        unresolved++;
        continue;
      }
      const linked = packages[target];
      if (
        linked?.link === true &&
        typeof linked.resolved === "string" &&
        Object.hasOwn(packages, linked.resolved)
      )
        target = linked.resolved;
      if (!reverse.has(target)) reverse.set(target, new Set());
      reverse.get(target).add(from);
    }
    if (truncated) break;
  }
  return { reverse, bySpec, unresolved, truncated, packages };
}

function describe(packages, location) {
  const entry = packages[location];
  return {
    location,
    name:
      location === ""
        ? typeof entry?.name === "string"
          ? entry.name
          : null
        : (nameFromKey(location) ?? entry?.name ?? null),
    version: typeof entry?.version === "string" ? entry.version : null,
  };
}

// Enumerates bounded simple paths from the project root or workspace to every location of an exact identity.
export function explainDependencyPaths(
  graph,
  spec,
  { limits: overrides = {} } = {},
) {
  const limits = { ...PATH_LIMITS, ...overrides };
  const { reverse, bySpec, packages } = graph.index;
  const targets = bySpec.get(spec) ?? [];
  const paths = [];
  const reasons = new Set();
  if (graph.index.truncated) reasons.add("edge-limit");
  let visits = 0;
  for (const target of targets) {
    const stack = [[target]];
    while (stack.length) {
      if (paths.length >= limits.paths) {
        reasons.add("path-limit");
        break;
      }
      if (++visits > limits.visits) {
        reasons.add("visit-limit");
        break;
      }
      const chain = stack.pop();
      const head = chain.at(-1);
      const parents = reverse.get(head);
      if (head === "" || (head !== target && nameFromKey(head) === null)) {
        paths.push(chain.toReversed().map((at) => describe(packages, at)));
        continue;
      }
      if (!parents?.size) {
        reasons.add("unreachable-location");
        continue;
      }
      if (chain.length > limits.depth) {
        reasons.add("depth-limit");
        continue;
      }
      const next = [...parents].filter((parent) => !chain.includes(parent));
      if (!next.length) reasons.add("cycle-without-root");
      for (const parent of next.sort().reverse())
        stack.push([...chain, parent]);
    }
  }
  return {
    spec,
    locations: targets.length,
    direct: paths.some((path) => path.length === 2 && path[0].location === ""),
    paths,
    complete: reasons.size === 0,
    reasons: [...reasons].sort(),
  };
}
