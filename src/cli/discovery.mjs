import { existsSync, readFileSync, statSync } from "node:fs";
import { LocalInputError } from "../core/pipeline.mjs";

const MAX_METADATA_BYTES = 1024 * 1024;
const COMMANDS = [
  {
    name: "check",
    module: "main.mjs",
    summary:
      "Check an exact npm version via the hosted service, or a local tarball offline.",
    usage: [
      "unmask check NAME@VERSION --out DIR",
      "unmask check --tarball FILE --offline --cache-dir DIR --out DIR [--claim NAME@VERSION] [--source-archive FILE --commit SHA --source-root DIR [--source-dir DIR]] [--allow-model]",
    ],
  },
  {
    name: "compare",
    module: "compare.mjs",
    summary:
      "Compare scripts, dependencies and files between two exact versions of one package.",
    usage: ["unmask compare NAME@OLD NAME@NEW [--json]"],
  },
  {
    name: "history",
    module: "history.mjs",
    summary:
      "Show a bounded npm release timeline with deprecations and exact-version guidance.",
    usage: ["unmask history NAME [--limit 1-100] [--json]"],
  },
  {
    name: "doctor",
    module: "doctor.mjs",
    summary:
      "Diagnose Node, hosted service version and project guard configuration.",
    usage: [
      "unmask doctor [--offline] [--server-url ORIGIN] [--project DIR] [--json]",
    ],
  },
  {
    name: "cache",
    module: "cache.mjs",
    summary: "Import, inspect and explicitly prune local report snapshots.",
    usage: [
      "unmask cache import --report FILE [--cache-dir DIR] [--json]",
      "unmask cache inspect [--cache-dir DIR] [--json]",
      "unmask cache prune --older-than-days N --limit N [--apply] [--cache-dir DIR] [--json]",
    ],
  },
  { name: "info", module: "info.mjs", summary: "Show hosted package details." },
  {
    name: "files",
    module: "files.mjs",
    summary: "List package file inventory.",
  },
  { name: "audit", module: "audit.mjs", summary: "Audit an npm lockfile." },
  {
    name: "why",
    module: "why.mjs",
    summary: "Explain lockfile dependency paths.",
  },
  {
    name: "scan",
    module: "scan.mjs",
    summary: "Resolve a tag to an exact version and check it.",
  },
  {
    name: "batch",
    module: "batch.mjs",
    summary: "Check several exact versions.",
  },
  {
    name: "config",
    module: "config.mjs",
    summary: "Manage project guard policy.",
  },
  {
    name: "exceptions",
    module: "exceptions.mjs",
    summary: "Manage expiring exact-version exceptions.",
  },
  {
    name: "watch",
    module: "watch.mjs",
    summary: "Watch a project lockfile and check changes.",
  },
  {
    name: "preflight",
    module: "preflight.mjs",
    summary: "Check lockfile changes for CI.",
  },
];
const available = (command) =>
  existsSync(new URL(`./${command.module}`, import.meta.url));
function usageError(message) {
  return new LocalInputError("usage", message);
}
export function commandCatalog() {
  return COMMANDS.map((command) => ({
    name: command.name,
    available: available(command),
    summary: command.summary,
    usage: command.usage ?? [],
  }));
}
function boundedJson(url) {
  const stat = statSync(url);
  if (!stat.isFile() || stat.size > MAX_METADATA_BYTES) throw new TypeError();
  return JSON.parse(readFileSync(url, "utf8"));
}
export function buildIdentity() {
  const metadataUrl = new URL("../version.json", import.meta.url);
  if (!existsSync(metadataUrl)) {
    const pkg = boundedJson(new URL("../../package.json", import.meta.url));
    if (typeof pkg?.version !== "string") throw new TypeError();
    return { version: pkg.version, build: "source", commit: null, dirty: null };
  }
  const metadata = boundedJson(metadataUrl);
  if (
    metadata?.buildSchema !== "1" ||
    typeof metadata.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(metadata.version) ||
    typeof metadata.dirty !== "boolean" ||
    !(metadata.commit === "unknown" || /^[a-f0-9]{40}$/.test(metadata.commit))
  )
    throw new TypeError();
  return {
    version: metadata.version,
    build: "built",
    commit: metadata.commit === "unknown" ? null : metadata.commit,
    dirty: metadata.dirty,
    sourceSha256: /^[a-f0-9]{64}$/.test(metadata.sourceSha256)
      ? metadata.sourceSha256
      : null,
  };
}
function renderOverview(catalog) {
  const width = Math.max(...catalog.map((command) => command.name.length));
  const row = (command) =>
    `  ${command.name.padEnd(width)}  ${command.summary}`;
  const lines = [
    "Usage: unmask <command> [options]",
    "",
    "Commands available in this build:",
    ...catalog.filter((command) => command.available).map(row),
  ];
  const planned = catalog.filter((command) => !command.available);
  if (planned.length)
    lines.push("", "Planned, not included in this build:", ...planned.map(row));
  lines.push(
    "",
    "Help and identity:",
    "  unmask --help | unmask help COMMAND | unmask COMMAND --help",
    "  unmask --version [--json]   build version and commit, read locally without network",
    "",
    "Results report evidence and coverage; no command guarantees a package is safe.",
  );
  return lines.join("\n") + "\n";
}
function renderCommand(command) {
  const lines = [`unmask ${command.name}: ${command.summary}`];
  if (!command.available)
    lines.push("Not included in this build; this command cannot be run here.");
  else if (command.usage.length)
    lines.push("Usage:", ...command.usage.map((usage) => `  ${usage}`));
  return lines.join("\n") + "\n";
}
export function discoveryCommand(argv, runtime = {}) {
  const stdout = runtime.stdout ?? process.stdout;
  if (argv[0] === "--version" || argv[0] === "version") {
    const json = argv[1] === "--json";
    if (argv.length > (json ? 2 : 1))
      throw usageError("Use unmask --version [--json]");
    let identity;
    try {
      identity = buildIdentity();
    } catch {
      throw new LocalInputError(
        "build-metadata-invalid",
        "Build version metadata is missing or invalid; reinstall the package.",
      );
    }
    stdout.write(
      json
        ? JSON.stringify(identity, null, 2) + "\n"
        : `unmask ${identity.version} (${
            identity.build === "source"
              ? "unbuilt source checkout, no build metadata"
              : identity.commit
                ? `commit ${identity.commit}`
                : "built from uncommitted changes, commit unknown"
          })\n`,
    );
    return 0;
  }
  const catalog = commandCatalog();
  const name =
    argv[0] === "help" ? argv[1] : argv[1] === "--help" ? argv[0] : undefined;
  const extra = argv[0] === "help" ? argv.slice(2) : argv.slice(1);
  if (name === undefined && argv.length <= 1) {
    stdout.write(renderOverview(catalog));
    return 0;
  }
  const command = catalog.find((item) => item.name === name);
  if (!command || (argv[0] === "help" ? extra.length : extra.length !== 1))
    throw usageError(
      "Unknown command or help request; run unmask --help for the command list",
    );
  stdout.write(renderCommand(command));
  return 0;
}
export function isDiscoveryRequest(argv) {
  return (
    ["--help", "-h", "help", "--version", "version"].includes(argv[0]) ||
    (argv.length === 2 && argv[1] === "--help")
  );
}
