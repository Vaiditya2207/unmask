import { LocalInputError } from "../core/pipeline.mjs";
import { AcquisitionError } from "../core/acquire.mjs";
import { checkHosted } from "./hosted.mjs";
import { exactTargets, readLockfile } from "./lockfile.mjs";

export const AUDIT_LIMITS = Object.freeze({
  defaultMax: 6,
  maxPackages: 50,
  maxConcurrency: 2,
});
const STATUS_BY_EXIT = { 0: "no-findings", 2: "incomplete", 3: "findings" };

export function bindingStatus(target, report) {
  if (!target.bound) return "unbound";
  const actual = report?.inputs?.artifact?.sha512;
  if (typeof actual !== "string" || !/^[a-f0-9]{128}$/.test(actual))
    return "unavailable";
  const locked = target.integrity
    .flatMap((value) => value.split(/\s+/))
    .filter((value) => value.startsWith("sha512-"))
    .map((value) => Buffer.from(value.slice(7), "base64").toString("hex"));
  return locked.length > 0 && locked.every((value) => value === actual)
    ? "verified"
    : "mismatch";
}

function positive(value, max, label) {
  if (!/^[1-9]\d*$/.test(value ?? "") || Number(value) > max)
    throw new LocalInputError(
      "invalid-option",
      `${label} must be an integer from 1 to ${max}.`,
    );
  return Number(value);
}

export function parseAuditArgs(argv) {
  const options = {
    lockfile: "package-lock.json",
    max: AUDIT_LIMITS.defaultMax,
    concurrency: 1,
    omitDev: false,
    json: false,
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (seen.has(key))
      throw new LocalInputError(
        "duplicate-option",
        "Each option may be supplied only once",
      );
    seen.add(key);
    if (key === "--json") options.json = true;
    else if (key === "--omit-dev") options.omitDev = true;
    else if (key === "--lockfile") {
      const value = argv[++index];
      if (!value || value.startsWith("--"))
        throw new LocalInputError(
          "missing-value",
          "An option is missing its value",
        );
      options.lockfile = value;
    } else if (key === "--max")
      options.max = positive(argv[++index], AUDIT_LIMITS.maxPackages, "--max");
    else if (key === "--concurrency")
      options.concurrency = positive(
        argv[++index],
        AUDIT_LIMITS.maxConcurrency,
        "--concurrency",
      );
    else
      throw new LocalInputError(
        "unknown-option",
        "Use audit [--lockfile PATH] [--max N] [--concurrency N] [--omit-dev] [--json]",
      );
  }
  return options;
}

async function checkOne(target, check) {
  try {
    const report = await check(target.spec);
    const exitCode = report?.policy?.exitCode;
    return {
      ...target,
      status: STATUS_BY_EXIT[exitCode] ?? "incomplete",
      binding: bindingStatus(target, report),
      exitCode,
      findings: (report.policy.findings ?? []).map((item) => item.ruleId),
      model: report.model?.status ?? "not-reported",
    };
  } catch (error) {
    return {
      ...target,
      status: "failed",
      error:
        error instanceof LocalInputError
          ? { code: error.code, message: error.message }
          : error instanceof AcquisitionError
            ? { code: error.code, message: "Invalid exact package identity." }
            : { code: "internal", message: "Check failed unexpectedly." },
    };
  }
}

export async function auditLock(
  lock,
  { check, max = AUDIT_LIMITS.defaultMax, concurrency = 1, omitDev = false },
) {
  const { considered, targets, skipped, omitted } = exactTargets(lock, {
    omitDev,
  });
  const selected = targets.slice(0, max);
  const results = new Array(selected.length);
  let next = 0;
  // Bounded worker pool keeps hosted load within the shared rate limit.
  await Promise.all(
    Array.from({ length: Math.min(concurrency, selected.length) }, async () => {
      while (next < selected.length) {
        const index = next++;
        results[index] = await checkOne(selected[index], check);
      }
    }),
  );
  const notChecked = targets
    .slice(max)
    .map((target) => ({ ...target, status: "not-checked" }));
  const counts = {};
  for (const item of [...results, ...notChecked])
    counts[item.status] = (counts[item.status] ?? 0) + 1;
  const skippedTotal = Object.values(skipped).reduce((a, b) => a + b, 0);
  const binding = {};
  for (const item of results)
    if (item.binding) binding[item.binding] = (binding[item.binding] ?? 0) + 1;
  const complete =
    skippedTotal === 0 &&
    notChecked.length === 0 &&
    results.every(
      (item) =>
        ["no-findings", "findings"].includes(item.status) &&
        item.binding === "verified",
    );
  return {
    schemaVersion: "1",
    lockfileVersion: lock.lockfileVersion,
    scope: omitDev ? "production-and-optional" : "all-locked",
    coverage: {
      complete,
      lockedEntries: considered,
      uniqueExact: targets.length,
      checked: results.length,
      counts,
      binding,
      skipped,
      omitted,
    },
    exitCode: counts.findings ? 3 : complete ? 0 : 2,
    results: [...results, ...notChecked],
    limitations: [
      "No findings means no deterministic policy finding in the checked scope, not that a package is safe.",
      "Removed or unpublished registry versions fail acquisition and are reported as failed, not clean.",
      "Git, URL, file, workspace and invalid entries are not audited by exact registry identity.",
      "Coverage requires each locked sha512 integrity to equal the hosted artifact sha512; unbound (no registry.npmjs.org resolved or sha512 integrity), mismatched or unreported hashes stay incomplete.",
      "Unlocked optionalDependencies and optional peers are counted under coverage.omitted and not audited; npm does not require them, so they do not make coverage incomplete.",
      "At most --max (default 6, matching the hosted limit of six new checks per ten minutes) unique versions are checked, in name order; the rest are not-checked.",
    ],
  };
}

function formatText(result) {
  const lines = [];
  const { coverage } = result;
  lines.push(
    `Audited ${coverage.checked} of ${coverage.uniqueExact} unique exact versions (${coverage.lockedEntries} locked entries, lockfile v${result.lockfileVersion}).`,
  );
  for (const item of result.results) {
    const detail =
      item.status === "failed"
        ? ` ${item.error.code}`
        : (item.findings?.length ? ` ${item.findings.join(",")}` : "") +
          (item.binding && item.binding !== "verified"
            ? ` [binding ${item.binding}]`
            : "");
    const alias = item.aliases?.length
      ? ` (as ${item.aliases.join(", ")})`
      : "";
    lines.push(`  ${item.status.padEnd(12)} ${item.spec}${alias}${detail}`);
  }
  for (const [reason, count] of Object.entries(coverage.skipped))
    lines.push(`  skipped      ${count} entries: ${reason}`);
  const { optional, peerOptional, devEntries, devEdges } = coverage.omitted;
  if (optional + peerOptional + devEntries + devEdges > 0)
    lines.push(
      `  omitted      ${optional} unlocked optional, ${peerOptional} unlocked optional peer edges; ${devEntries} dev entries, ${devEdges} dev edges (--omit-dev)`,
    );
  lines.push(
    coverage.complete
      ? "Coverage: complete for the checked scope."
      : "Coverage: INCOMPLETE; unchecked, failed or skipped entries are not verified.",
  );
  lines.push(result.limitations[0]);
  return lines.join("\n") + "\n";
}

export async function runAudit(argv, runtime = {}) {
  const options = parseAuditArgs(argv);
  const lock = await readLockfile(options.lockfile);
  const env = runtime.env ?? process.env;
  const check =
    runtime.auditCheck ??
    ((spec) =>
      checkHosted(spec, {
        serverUrl: env.UNMASK_SERVER_URL,
        fetchImpl: runtime.fetchImpl,
        signal: runtime.signal,
        limits: runtime.hostedLimits,
      }));
  const result = await auditLock(lock, { ...options, check });
  process.stdout.write(
    options.json ? JSON.stringify(result, null, 2) + "\n" : formatText(result),
  );
  return result.exitCode;
}
