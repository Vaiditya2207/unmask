import { existsSync, readFileSync, statSync } from "node:fs";
import { LocalInputError } from "../core/pipeline.mjs";

const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_MAIN_BYTES = 256 * 1024;
const GROUPS = [
  "Package checks",
  "Project and lockfile",
  "Install guard and policy",
  "Automation outputs",
  "Local tools",
];
const COMMANDS = [
  {
    name: "check",
    group: 0,
    module: "main.mjs",
    summary:
      "Check an exact npm version via the hosted service, or a local tarball offline.",
    usage: [
      "unmask check NAME@VERSION [--out DIR]",
      "unmask check --tarball FILE --offline --cache-dir DIR [--out DIR] [--claim NAME@VERSION] [--source-archive FILE --commit SHA --source-root DIR [--source-dir DIR]] [--allow-model]",
    ],
  },
  {
    name: "scan",
    group: 0,
    module: "scan.mjs",
    summary:
      "Resolve a package name or dist-tag to one exact version, then check that pinned version.",
    usage: [
      "unmask scan PACKAGE[@VERSION-OR-TAG] [--json]   (semver ranges are unsupported)",
    ],
  },
  {
    name: "batch",
    group: 0,
    module: "batch.mjs",
    summary:
      "Check several explicit exact versions with per-item outcomes and visible partial failures.",
    usage: ["unmask batch NAME@VERSION... [--stdin] [--json]"],
  },
  {
    name: "info",
    group: 0,
    module: "info.mjs",
    summary:
      "Show hosted package details: metadata, scripts, dependencies, provenance and advisories.",
    usage: ["unmask info NAME@VERSION"],
  },
  {
    name: "files",
    group: 0,
    module: "files.mjs",
    summary: "List a checked version's file inventory with hashes and states.",
    usage: [
      "unmask files NAME@VERSION [--report ID] [--path TEXT] [--state STATE] [--limit 1..200] [--offset N]",
    ],
  },
  {
    name: "file",
    group: 0,
    module: "file.mjs",
    summary:
      "Show one recorded file's evidence, bound to a hosted report ID and file ID.",
    usage: ["unmask file NAME@VERSION --report REPORT_ID --file-id FILE_ID"],
  },
  {
    name: "compare",
    group: 0,
    module: "compare.mjs",
    summary:
      "Compare scripts, dependencies and files between two exact versions of one package.",
    usage: ["unmask compare NAME@OLD NAME@NEW [--json]"],
  },
  {
    name: "history",
    group: 0,
    module: "history.mjs",
    summary:
      "Show a bounded npm release timeline with deprecations and exact-version guidance.",
    usage: ["unmask history NAME [--limit 1-100] [--json]"],
  },
  {
    name: "audit",
    group: 1,
    module: "audit.mjs",
    summary: "Audit the exact dependency versions in an npm v2/v3 lockfile.",
    usage: [
      "unmask audit [--lockfile PATH] [--max N] [--concurrency N] [--omit-dev] [--json]",
    ],
  },
  {
    name: "why",
    group: 1,
    module: "why.mjs",
    summary: "Explain the lockfile dependency paths that bring in a package.",
    usage: [
      "unmask why NAME[@VERSION] [--lockfile PATH] [--max-paths N] [--json]",
    ],
  },
  {
    name: "preflight",
    group: 1,
    module: "preflight.mjs",
    summary:
      "Check exact lockfile changes against a baseline for CI pipelines.",
    usage: [
      "unmask preflight --baseline FILE [--lockfile PATH] [--max-checks N] [--no-check] [--json]",
    ],
  },
  {
    name: "watch",
    group: 1,
    module: "watch.mjs",
    summary:
      "Watch the project lockfile and run bounded, non-overlapping checks on changes.",
    usage: [
      "unmask watch [--lockfile PATH] [--debounce-ms 50-60000] [--max-checks N] [--no-check] [--json]",
    ],
  },
  {
    name: "ci",
    group: 2,
    module: "install-guard.mjs",
    summary:
      "Screen the exact lockfile plan, then run npm ci only if policy allows it.",
    usage: [
      "unmask ci [--omit|--include dev|optional|peer] [--loglevel LEVEL] [--ignore-scripts] [--prefer-offline] [--offline] [other allowlisted npm ci flags]",
    ],
  },
  {
    name: "install",
    group: 2,
    module: "install-guard.mjs",
    summary:
      "Refuses to run npm install (it can re-resolve versions) and explains the lockfile-first path.",
    usage: ["unmask install [ARGS]"],
  },
  {
    name: "enable",
    group: 2,
    module: "shell-integration.mjs",
    summary:
      "Print shell code that routes npm ci through the guard; no startup file is written.",
    usage: ["unmask enable bash|zsh|fish"],
  },
  {
    name: "disable",
    group: 2,
    module: "shell-integration.mjs",
    summary: "Print shell code that removes the guard routing.",
    usage: ["unmask disable bash|zsh|fish"],
  },
  {
    name: "init",
    group: 2,
    module: "init.mjs",
    summary:
      "Create a new project .unmask.json guard configuration; never overwrites an existing one.",
    usage: ["unmask init [--profile strict|balanced|audit] [--project DIR]"],
  },
  {
    name: "config",
    group: 2,
    module: "config.mjs",
    summary:
      "Show or set the project guard policy profile (strict, balanced, audit).",
    usage: [
      "unmask config show|profiles [--json] [--project DIR]",
      "unmask config set profile strict|balanced|audit [--project DIR]",
    ],
  },
  {
    name: "exceptions",
    group: 2,
    module: "exceptions.mjs",
    summary:
      "Manage explicit, expiring exact-version exceptions with recorded reasons.",
    usage: [
      "unmask exceptions list [--json] [--project DIR]",
      "unmask exceptions check NAME@VERSION [--json] [--project DIR]",
      "unmask exceptions add NAME@VERSION --reason TEXT --expires YYYY-MM-DD [--project DIR]",
      "unmask exceptions remove NAME@VERSION [--project DIR]",
      "unmask exceptions prune [--project DIR]",
    ],
  },
  {
    name: "sarif",
    group: 3,
    module: "sarif.mjs",
    summary: "Export an existing UNMASK report as SARIF.",
    usage: ["unmask sarif --report FILE [--details FILE] [--out FILE]"],
  },
  {
    name: "annotations",
    group: 3,
    module: "annotations.mjs",
    summary:
      "Print CI annotations from an existing report, optionally appending a summary file.",
    usage: [
      "unmask annotations --report FILE [--details FILE] [--summary FILE]",
    ],
  },
  {
    name: "doctor",
    group: 4,
    module: "doctor.mjs",
    summary:
      "Diagnose Node, hosted service version and project guard configuration.",
    usage: [
      "unmask doctor [--offline] [--server-url ORIGIN] [--project DIR] [--json]",
    ],
  },
  {
    name: "cache",
    group: 4,
    module: "cache.mjs",
    summary: "Import, inspect and explicitly prune local report snapshots.",
    usage: [
      "unmask cache import --report FILE [--cache-dir DIR] [--json]",
      "unmask cache inspect [--cache-dir DIR] [--json]",
      "unmask cache prune --older-than-days N --limit N [--apply] [--cache-dir DIR] [--json]",
    ],
  },
];
export function dispatchedCommands(mainSource) {
  return new Set(
    [...String(mainSource).matchAll(/argv\[0\] === "([a-z][a-z-]*)"/g)].map(
      (match) => match[1],
    ),
  );
}
function shippedDispatch() {
  try {
    const url = new URL("./main.mjs", import.meta.url);
    if (statSync(url).size > MAX_MAIN_BYTES) return new Set();
    return dispatchedCommands(readFileSync(url, "utf8"));
  } catch {
    return new Set();
  }
}
function usageError(message) {
  return new LocalInputError("usage", message);
}
export function commandCatalog() {
  const dispatched = shippedDispatch();
  return COMMANDS.map((command) => ({
    name: command.name,
    module: command.module,
    group: GROUPS[command.group],
    available:
      command.name === "check" ||
      (dispatched.has(command.name) &&
        existsSync(new URL(`./${command.module}`, import.meta.url))),
    summary: command.summary,
    usage: command.usage,
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
  const lines = ["Usage: unmask <command> [options]"];
  for (const group of GROUPS) {
    const rows = catalog.filter(
      (command) => command.available && command.group === group,
    );
    if (rows.length) lines.push("", `${group}:`, ...rows.map(row));
  }
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
