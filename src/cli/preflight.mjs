import { readFile, stat } from "node:fs/promises";
import { LocalInputError } from "../core/pipeline.mjs";
import { checkHosted } from "./hosted.mjs";
import { screenPlan } from "./install-guard.mjs";
import { nameFromKey, parseLockfile, unresolvedEdges } from "./lockfile.mjs";

export const PREFLIGHT_SCHEMA = "unmask-preflight-1";
const MAX_LOCKFILE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_CHECKS = 6;
const LIMIT_MAX_CHECKS = 100;
const failure = (code, message) => new LocalInputError(code, message);

export function lockIdentities(text) {
  const lock = parseLockfile(text);
  const identities = new Map();
  const unsupported = [];
  for (const entry of lock.entries.values()) {
    if (entry.edgesValid === false)
      unsupported.push({
        path: entry.key,
        reason: "invalid-dependencies",
        version: entry.version,
        resolved: entry.resolved,
      });
    if (entry.kind === "link" && !lock.entries.has(entry.resolved ?? ""))
      unsupported.push({
        path: entry.key,
        reason: "dangling-link",
        version: entry.version,
        resolved: entry.resolved,
      });
    const claimsArtifact =
      entry.kind === "workspace" && (entry.resolved || entry.integrity);
    if (["root", "workspace", "link"].includes(entry.kind) && !claimsArtifact)
      continue;
    if (entry.kind !== "registry") {
      unsupported.push({
        path: entry.key,
        reason: claimsArtifact ? "workspace-artifact-claim" : entry.reason,
        version: entry.version,
        resolved: entry.resolved,
      });
      continue;
    }
    const key = `${entry.name}@${entry.version}`;
    const existing = identities.get(key) ?? {
      name: entry.name,
      version: entry.version,
      paths: [],
      sources: new Set(),
      integrities: new Set(),
      bound: true,
    };
    existing.paths.push(entry.key);
    existing.sources.add(JSON.stringify([entry.resolved, entry.integrity]));
    existing.integrities.add(entry.integrity);
    existing.integrity ??= entry.integrity;
    existing.bound &&= entry.bound === true && existing.integrities.size === 1;
    identities.set(key, existing);
  }
  for (const edge of unresolvedEdges(lock))
    unsupported.push({
      path: `${edge.name} (required by ${edge.from || "root"})`,
      reason: "unresolved-dependency",
      version: edge.type,
      resolved: null,
    });
  for (const item of identities.values()) delete item.integrities;
  return { identities, unsupported };
}

export function lockDiff(baselineText, lockfileText) {
  const before = lockIdentities(baselineText);
  const after = lockIdentities(lockfileText);
  const added = [];
  for (const [key, item] of after.identities) {
    const prior = before.identities.get(key);
    const { sources, ...identity } = item;
    if (!prior) added.push({ ...identity, reason: "new-identity" });
    else if ([...sources].some((value) => !prior.sources.has(value)))
      added.push({ ...identity, reason: "source-changed" });
  }
  const removed = [...before.identities.values()]
    .filter((item) => !after.identities.has(`${item.name}@${item.version}`))
    .map(({ name, version }) => ({ name, version }));
  const seen = new Set(before.unsupported.map((item) => JSON.stringify(item)));
  const unsupported = after.unsupported
    .filter((item) => !seen.has(JSON.stringify(item)))
    .map(({ path, reason }) => ({ path, reason }));
  return {
    baselineIdentities: before.identities.size,
    lockfileIdentities: after.identities.size,
    added,
    removed,
    unsupported,
  };
}

async function checkOne(item, checkPackage, signal) {
  const spec = `${item.name}@${item.version}`;
  try {
    const report = await checkPackage(spec, { signal });
    return {
      name: item.name,
      version: item.version,
      status: "completed",
      bound: item.bound,
      exitCode: report.policy.exitCode,
      findings: report.policy.findings.map((finding) => finding.ruleId),
      coverageComplete: report.coverage.complete === true,
    };
  } catch (error) {
    if (signal?.aborted)
      return {
        name: item.name,
        version: item.version,
        status: "cancelled",
      };
    return {
      name: item.name,
      version: item.version,
      status: "unavailable",
      reason:
        error instanceof LocalInputError ? error.code : "internal-check-error",
    };
  }
}

export async function preflight({
  baselineText,
  lockfileText,
  check = true,
  maxChecks = DEFAULT_MAX_CHECKS,
  checkPackage,
  screenAdvisories,
  signal,
  onCheck = () => {},
}) {
  const diff = lockDiff(baselineText, lockfileText);
  const screening = check && typeof screenAdvisories === "function";
  const checks = [];
  for (const [index, item] of diff.added.entries()) {
    if (!check || index >= maxChecks || signal?.aborted) {
      checks.push({
        name: item.name,
        version: item.version,
        status: signal?.aborted ? "cancelled" : "not-checked",
        ...(signal?.aborted
          ? {}
          : { reason: check ? "max-checks" : "checks-disabled" }),
      });
      continue;
    }
    const result = await checkOne(item, checkPackage, signal);
    checks.push(result);
    onCheck(result);
  }
  const screenable = diff.added.filter((item) => item.bound);
  if (screening && screenable.length && !signal?.aborted) {
    let decisions = new Map();
    try {
      decisions = await screenAdvisories(screenable, { signal });
    } catch {}
    for (const [index, item] of diff.added.entries()) {
      if (!item.bound) continue;
      const found = decisions.get(`${item.name}@${item.version}`);
      checks[index].advisory = found
        ? {
            decision: found.decision,
            reasons: found.reasons,
            advisories: found.advisories,
          }
        : {
            decision: signal?.aborted ? "cancelled" : "unknown",
            reasons: ["advisory-screening-unavailable"],
            advisories: [],
          };
    }
  }
  const advisorySettled = (item) =>
    !screening || ["allow", "warn", "block"].includes(item.advisory?.decision);
  const advisoryScreened = checks.filter(
    (item) => item.advisory && advisorySettled(item),
  ).length;
  const checked = checks.filter(
    (item) =>
      item.status === "completed" &&
      item.exitCode !== 2 &&
      item.bound &&
      advisorySettled(item),
  ).length;
  const unbound = diff.added.filter((item) => !item.bound).length;
  const complete =
    diff.unsupported.length === 0 && checked === diff.added.length;
  const cancelled = checks.some((item) => item.status === "cancelled");
  const findings = checks.some(
    (item) => item.exitCode === 3 || item.advisory?.decision === "block",
  );
  const status = findings
    ? "findings"
    : cancelled
      ? "cancelled"
      : complete
        ? "pass"
        : "incomplete";
  return {
    schema: PREFLIGHT_SCHEMA,
    status,
    exitCode: findings ? 3 : complete && !cancelled ? 0 : 2,
    cancelled,
    baseline: { identities: diff.baselineIdentities },
    lockfile: { identities: diff.lockfileIdentities },
    changes: { added: diff.added, removed: diff.removed },
    checks,
    coverage: {
      complete,
      required: diff.added.length,
      checked,
      unbound,
      advisoryScreening: screening ? "strict-guard-policy" : "not-requested",
      advisoryScreened,
      unsupported: diff.unsupported,
    },
    note: "pass means no default-policy finding or advisory block in checked changes; it does not mean safe.",
  };
}

export async function readLockText(filename) {
  let info;
  try {
    info = await stat(filename);
  } catch {
    throw failure("lockfile-unreadable", `Cannot read lockfile ${filename}.`);
  }
  if (!info.isFile() || info.size > MAX_LOCKFILE_BYTES)
    throw failure(
      "lockfile-unreadable",
      `Lockfile ${filename} must be a regular file of at most 32 MiB.`,
    );
  const bytes = await readFile(filename);
  if (bytes.length > MAX_LOCKFILE_BYTES)
    throw failure("lockfile-unreadable", `Lockfile ${filename} is too large.`);
  return bytes.toString("utf8");
}

export function parseCount(value, name) {
  if (!/^[1-9]\d{0,2}$/.test(value ?? "") || Number(value) > LIMIT_MAX_CHECKS)
    throw failure("invalid-value", `${name} must be an integer from 1 to 100.`);
  return Number(value);
}

export function hostedChecker(runtime) {
  return (spec, { signal } = {}) =>
    checkHosted(spec, {
      serverUrl: (runtime.env ?? process.env).UNMASK_SERVER_URL,
      fetchImpl: runtime.fetchImpl,
      signal: signal ?? runtime.signal,
      limits: runtime.hostedLimits,
    });
}

export function hostedScreener(runtime) {
  return async (items, { signal } = {}) => {
    const packages = { "": { name: "unmask-preflight", version: "0.0.0" } };
    // Every identity keeps its own lockfile locations; alias-only identities get a private nested slot.
    for (const [index, item] of items.entries()) {
      const entry = {
        version: item.version,
        resolved: `https://registry.npmjs.org/${item.name}/-/${item.name.split("/").pop()}-${item.version}.tgz`,
        integrity: item.integrity,
      };
      const keys = item.paths.filter((key) => nameFromKey(key) === item.name);
      if (!keys.length)
        keys.push(
          `node_modules/unmask-preflight-slot-${index}/node_modules/${item.name}`,
        );
      for (const key of keys) packages[key] = entry;
    }
    const result = await screenPlan(
      {
        packages: items.map((item) => ({
          id: `${item.name}@${item.version}`,
          name: item.name,
          version: item.version,
          integrity: item.integrity,
          binding: "registry-integrity",
          paths: item.paths,
        })),
        lockBytes: Buffer.from(
          JSON.stringify({ lockfileVersion: 3, packages }),
        ),
      },
      {
        source: "hosted",
        policy: "strict",
        fetchImpl: runtime.fetchImpl,
        signal: signal ?? runtime.signal,
        serverUrl: (runtime.env ?? process.env).UNMASK_SERVER_URL,
      },
    );
    return new Map(result.decisions.map((decision) => [decision.id, decision]));
  };
}

export function formatPreflight(result) {
  const lines = [
    `preflight ${result.status}: ${result.changes.added.length} changed, ${result.changes.removed.length} removed, ${result.coverage.checked}/${result.coverage.required} checked`,
  ];
  for (const item of result.checks) {
    const detail =
      item.status === "completed"
        ? `exit ${item.exitCode}${item.findings.length ? ` (${item.findings.join(", ")})` : ""}${item.bound ? "" : "; unbound: lockfile resolved/integrity not verified"}`
        : item.status + (item.reason ? ` (${item.reason})` : "");
    const advisory = item.advisory
      ? `; advisory ${item.advisory.decision}${item.advisory.reasons.length ? ` (${[...item.advisory.reasons, ...item.advisory.advisories].join(", ")})` : ""}`
      : "";
    lines.push(`  ${item.name}@${item.version}: ${detail}${advisory}`);
  }
  for (const item of result.coverage.unsupported)
    lines.push(`  ${item.path}: unsupported (${item.reason})`);
  lines.push(result.note);
  return lines.join("\n") + "\n";
}

function parseArgs(argv) {
  const options = { lockfile: "package-lock.json", check: true, json: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (seen.has(key))
      throw failure(
        "duplicate-option",
        "Each option may be supplied only once",
      );
    seen.add(key);
    if (key === "--json") options.json = true;
    else if (key === "--no-check") options.check = false;
    else if (["--lockfile", "--baseline", "--max-checks"].includes(key)) {
      const value = argv[++index];
      if (!value || value.startsWith("--"))
        throw failure("missing-value", "An option is missing its value");
      options[key.slice(2)] = value;
    } else
      throw failure(
        "unknown-option",
        "Only the documented preflight options are supported",
      );
  }
  if (!options.baseline)
    throw failure("usage", "preflight requires --baseline FILE");
  options.maxChecks =
    options["max-checks"] === undefined
      ? DEFAULT_MAX_CHECKS
      : parseCount(options["max-checks"], "--max-checks");
  return options;
}

export async function preflightMain(argv, runtime = {}) {
  try {
    const options = parseArgs(argv);
    const [baselineText, lockfileText] = await Promise.all([
      readLockText(options.baseline),
      readLockText(options.lockfile),
    ]);
    const result = await preflight({
      baselineText,
      lockfileText,
      check: options.check,
      maxChecks: options.maxChecks,
      checkPackage: runtime.checkPackage ?? hostedChecker(runtime),
      screenAdvisories: runtime.screenAdvisories ?? hostedScreener(runtime),
      signal: runtime.signal,
    });
    process.stdout.write(
      options.json
        ? JSON.stringify(result, null, 2) + "\n"
        : formatPreflight(result),
    );
    return result.exitCode;
  } catch (error) {
    if (error instanceof LocalInputError) {
      process.stderr.write(`${error.code}: ${error.message}\n`);
      return 2;
    }
    process.stderr.write("Internal preflight error; no result is claimed.\n");
    return 1;
  }
}
