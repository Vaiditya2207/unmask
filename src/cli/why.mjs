import { LocalInputError } from "../core/pipeline.mjs";
import {
  isExactVersion,
  isPackageName,
  nameFromKey,
  readLockfile,
  resolveEdge,
} from "./lockfile.mjs";

export const WHY_LIMITS = Object.freeze({
  defaultPaths: 10,
  maxPaths: 100,
  maxDepth: 64,
  maxSteps: 50000,
});

export function parseQuery(value) {
  const separator = typeof value === "string" ? value.lastIndexOf("@") : -1;
  const name = separator > 0 ? value.slice(0, separator) : value;
  const version = separator > 0 ? value.slice(separator + 1) : null;
  if (!isPackageName(name) || (version !== null && !isExactVersion(version)))
    throw new LocalInputError(
      "invalid-package",
      "Use why name or why name@exact-version",
    );
  return { name, version };
}

export function parseWhyArgs(argv) {
  const options = {
    lockfile: "package-lock.json",
    maxPaths: WHY_LIMITS.defaultPaths,
    json: false,
  };
  if (!argv[0] || argv[0].startsWith("--"))
    throw new LocalInputError(
      "usage",
      "Use why name[@version] [--lockfile PATH] [--max-paths N] [--json]",
    );
  options.query = parseQuery(argv[0]);
  const seen = new Set();
  for (let index = 1; index < argv.length; index++) {
    const key = argv[index];
    if (seen.has(key))
      throw new LocalInputError(
        "duplicate-option",
        "Each option may be supplied only once",
      );
    seen.add(key);
    if (key === "--json") {
      options.json = true;
      continue;
    }
    const value = argv[++index];
    if (key === "--lockfile" && value && !value.startsWith("--"))
      options.lockfile = value;
    else if (
      key === "--max-paths" &&
      /^[1-9]\d*$/.test(value ?? "") &&
      Number(value) <= WHY_LIMITS.maxPaths
    )
      options.maxPaths = Number(value);
    else
      throw new LocalInputError(
        "invalid-option",
        `Use --lockfile PATH, --max-paths 1..${WHY_LIMITS.maxPaths} or --json`,
      );
  }
  return options;
}

function graph(lock) {
  const dependents = new Map();
  const unresolved = [];
  for (const entry of lock.entries.values()) {
    for (const edge of entry.edges) {
      const target = resolveEdge(lock, entry.key, edge.name);
      if (!target) {
        if (edge.type !== "dev" || ["root", "workspace"].includes(entry.kind))
          unresolved.push({ from: entry.key, ...edge });
        continue;
      }
      const list = dependents.get(target.key) ?? [];
      list.push({ from: entry.key, type: edge.type, range: edge.range });
      dependents.set(target.key, list);
    }
  }
  return { dependents, unresolved };
}

const isRoot = (entry) => ["root", "workspace"].includes(entry?.kind);
const label = (entry) =>
  entry.kind === "root"
    ? `${entry.name ?? "(root)"} (root)`
    : `${entry.name}@${entry.version ?? "?"}${entry.kind === "workspace" ? " (workspace)" : ""}`;

function pathsTo(lock, dependents, key, limits) {
  const paths = [];
  let steps = 0;
  let truncated = false;
  const onPath = new Set([key]);
  // Depth-first walk to roots over dependents; onPath breaks cycles.
  function walk(current, trail) {
    if (paths.length >= limits.maxPaths || ++steps > limits.maxSteps) {
      truncated = true;
      return;
    }
    const entry = lock.entries.get(current);
    if (isRoot(entry) && current !== key) {
      paths.push(trail.slice().reverse());
      return;
    }
    if (trail.length > limits.maxDepth) {
      truncated = true;
      return;
    }
    for (const link of dependents.get(current) ?? []) {
      if (onPath.has(link.from)) continue;
      onPath.add(link.from);
      trail.push({ key: link.from, type: link.type, range: link.range });
      walk(link.from, trail);
      trail.pop();
      onPath.delete(link.from);
    }
  }
  walk(key, [{ key, type: null, range: null }]);
  paths.sort((a, b) => a.length - b.length);
  return {
    paths: paths.map((trail) =>
      trail.map((step) => {
        const entry = lock.entries.get(step.key);
        return {
          key: step.key,
          label: label(entry),
          dependencyType: step.type,
          range: step.range,
        };
      }),
    ),
    truncated,
  };
}

export function explainWhy(lock, query, { maxPaths = 10 } = {}) {
  const limits = { ...WHY_LIMITS, maxPaths };
  const { dependents, unresolved } = graph(lock);
  const matches = [];
  for (const entry of lock.entries.values()) {
    if (entry.kind === "root" || entry.kind === "link") continue;
    const alias = nameFromKey(entry.key);
    if (entry.name !== query.name && alias !== query.name) continue;
    if (query.version && entry.version !== query.version) continue;
    const { paths, truncated } = pathsTo(lock, dependents, entry.key, limits);
    matches.push({
      key: entry.key,
      name: entry.name,
      alias: alias !== entry.name ? alias : null,
      version: entry.version,
      kind: entry.kind,
      dev: entry.dev,
      optional: entry.optional,
      bundled: entry.bundled,
      direct: paths.some((trail) => trail.length === 2),
      workspace: entry.kind === "workspace",
      paths,
      truncated,
    });
  }
  const versions = new Set(matches.map((match) => match.version));
  const limitations = [
    "Paths follow lockfile placement and npm node_modules resolution, not the installed tree on disk.",
  ];
  if (matches.length > 1)
    limitations.push(
      `${matches.length} locations (${versions.size} versions) are locked; each is explained separately.`,
    );
  if (matches.some((match) => match.truncated))
    limitations.push("Some path lists were truncated by traversal limits.");
  if (matches.some((match) => !match.workspace && match.paths.length === 0))
    limitations.push(
      "Entries with no path are extraneous, bundled or reached only through unresolved links.",
    );
  if (matches.some((match) => match.workspace))
    limitations.push(
      "A workspace is part of the project itself; paths show only other workspaces that depend on it.",
    );
  if ([...lock.entries.values()].some((entry) => entry.kind === "workspace"))
    limitations.push(
      "Workspaces are treated as their own roots; root-to-workspace membership is not shown as an edge.",
    );
  return {
    schemaVersion: "1",
    query,
    found: matches.length > 0,
    matches,
    unresolvedEdges: unresolved
      .filter((edge) => edge.name === query.name)
      .slice(0, limits.maxPaths),
    limitations,
  };
}

function formatText(result) {
  const lines = [];
  for (const match of result.matches) {
    const flags = [
      match.workspace ? null : match.direct ? "direct" : "transitive",
      match.dev && "dev",
      match.optional && "optional",
      match.bundled && "bundled",
      !["registry", "bundled"].includes(match.kind) && match.kind,
    ].filter(Boolean);
    lines.push(
      `${match.name}@${match.version ?? "?"} at ${match.key} (${flags.join(", ")}): ${match.paths.length}${match.truncated ? "+" : ""} path(s)`,
    );
    for (const trail of match.paths)
      lines.push(
        "  " +
          trail
            .map((step) =>
              step.dependencyType && step.dependencyType !== "prod"
                ? `${step.label} -[${step.dependencyType}]->`
                : step.dependencyType
                  ? `${step.label} ->`
                  : step.label,
            )
            .join(" "),
      );
  }
  for (const note of result.limitations) lines.push(`Note: ${note}`);
  return lines.join("\n") + "\n";
}

export async function runWhy(argv) {
  const options = parseWhyArgs(argv);
  const lock = await readLockfile(options.lockfile);
  const result = explainWhy(lock, options.query, options);
  if (!result.found && result.unresolvedEdges.length > 0) {
    const from = result.unresolvedEdges
      .map((edge) => `${edge.from || "the root"} (${edge.type})`)
      .join(", ");
    throw new LocalInputError(
      "package-not-locked",
      `Declared by ${from} but has no locked entry; npm would resolve it at install time, so it is unscreened.`,
    );
  }
  if (!result.found)
    throw new LocalInputError(
      "package-not-in-lockfile",
      "No locked entry matches that package; it is not part of this lockfile.",
    );
  process.stdout.write(
    options.json ? JSON.stringify(result, null, 2) + "\n" : formatText(result),
  );
  return 0;
}
