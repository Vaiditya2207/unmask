import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalInputError } from "../core/pipeline.mjs";
import {
  activeExceptionFor,
  loadGuardSettings,
  PROFILES,
} from "../core/guard-config.mjs";
import { classifyGuardAdvisory } from "../core/guard-policy.mjs";
import { parentKey, parseLockfile, resolveEdge } from "./lockfile.mjs";
import { DEFAULT_SERVER_URL, serverOrigin } from "./hosted.mjs";

export const GUARD_ACTIVE_ENV = "UNMASK_GUARD_ACTIVE";
export const GUARD_SOURCES = Object.freeze(["hosted", "osv"]);
export const GUARD_LIMITS = Object.freeze({
  lockfileBytes: 16 * 1024 * 1024,
  manifestBytes: 1024 * 1024,
  packages: 10000,
  batchSize: 1000,
  detailFetches: 200,
  responseBytes: 16 * 1024 * 1024,
  timeoutMs: 120000,
  probeTimeoutMs: 30000,
  concurrency: 8,
});
const OSV_BATCH = "https://api.osv.dev/v1/querybatch";
const OSV_VULN = "https://api.osv.dev/v1/vulns/";
const SEVERITY = ["unknown", "low", "medium", "high", "critical"];
const IDENTIFIER = /^[A-Za-z0-9:_.-]{1,256}$/;
const SHA512 = /^sha512-[A-Za-z0-9+/]{86}==$/;
const CI_FLAGS = new Set([
  "--ignore-scripts",
  "--foreground-scripts",
  "--no-audit",
  "--audit=false",
  "--no-fund",
  "--fund=false",
  "--no-progress",
  "--progress=false",
  "--no-color",
  "--color=false",
  "--prefer-offline",
  "--offline",
  "--silent",
  "--quiet",
  "-q",
  "--verbose",
  "-d",
]);
const DEP_TYPES = ["dev", "optional", "peer"];
const CI_VALUES = {
  "--omit": DEP_TYPES,
  "--include": DEP_TYPES,
  "--loglevel": [
    "silent",
    "error",
    "warn",
    "notice",
    "http",
    "info",
    "verbose",
    "silly",
  ],
};
const SAFE_NPM_ENV = new Set(
  [
    "loglevel",
    "progress",
    "fund",
    "audit",
    "color",
    "update_notifier",
    "cache",
    "omit",
    "include",
    "ignore_scripts",
    "prefer_offline",
    "offline",
  ].map((key) => `npm_config_${key}`),
);
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
];
const REFRESH =
  "Run `npm install --package-lock-only --ignore-scripts` to refresh the lockfile without running package code, review the diff, then rerun `unmask ci`.";

export class GuardError extends Error {
  constructor(code, message, remediation) {
    super(message);
    this.code = code;
    this.remediation = remediation;
  }
}
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const identifiers = (list) =>
  Array.isArray(list) &&
  list.every((item) => typeof item === "string" && IDENTIFIER.test(item));

export function inspectCiArguments(args) {
  for (let index = 0; index < args.length; index++) {
    const arg = String(args[index]);
    const split = arg.indexOf("=");
    const flag = split === -1 ? arg : arg.slice(0, split);
    if (CI_FLAGS.has(arg)) continue;
    if (Object.hasOwn(CI_VALUES, flag)) {
      const given = split === -1 ? args[++index] : arg.slice(split + 1);
      if (CI_VALUES[flag].includes(given)) continue;
    }
    throw new GuardError(
      "unsupported-option",
      `${arg.slice(0, 64)} is not on the guard's npm ci allowlist, so the screened plan could differ from what npm installs`,
      "Supported: --omit/--include dev|optional|peer, --loglevel LEVEL, --ignore-scripts, --foreground-scripts, --no-audit, --no-fund, --no-progress, --no-color, --prefer-offline, --offline, --silent, --quiet, --verbose.",
    );
  }
}

export function inspectNpmEnvironment(env) {
  const unsafe = Object.keys(env)
    .filter((key) => /^npm_config_/i.test(key))
    .filter((key) => !SAFE_NPM_ENV.has(key.toLowerCase()))
    .sort();
  if (unsafe.length)
    throw new GuardError(
      "unsupported-config",
      `npm configuration from the environment (${unsafe.slice(0, 8).join(", ")}) could retarget npm away from the screened project`,
      "Unset those variables, or run unmask directly rather than from an npm script.",
    );
}

function sortedFields(manifest) {
  return JSON.stringify(
    DEPENDENCY_FIELDS.map((field) =>
      object(manifest?.[field])
        ? Object.entries(manifest[field]).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          )
        : [],
    ),
  );
}
function linkedOutside(lock, key, name) {
  for (let base = key; ; base = parentKey(base)) {
    const found = lock.entries.get(
      `${base ? base + "/" : ""}node_modules/${name}`,
    );
    if (found) return found.kind === "link";
    if (!base) return false;
  }
}

export function planFromLockfile(
  lockText,
  manifestText,
  limits = GUARD_LIMITS,
) {
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    throw new GuardError(
      "lockfile-invalid",
      "package.json is not valid JSON",
      REFRESH,
    );
  }
  const lock = parseLockfile(lockText);
  const raw = JSON.parse(lockText).packages;
  if (!object(manifest) || sortedFields(raw[""]) !== sortedFields(manifest))
    throw new GuardError(
      "lockfile-out-of-sync",
      "package.json dependencies differ from the lockfile root, so npm could resolve versions that were not screened",
      REFRESH,
    );
  if (lock.entries.size > limits.packages + 1)
    throw new GuardError(
      "plan-limit",
      `The lockfile has more than ${limits.packages} entries`,
      "Screen smaller workspaces separately; the guard does not truncate plans.",
    );
  const items = new Map();
  const missing = [];
  for (const entry of lock.entries.values()) {
    if (
      entry.key &&
      entry.key.split("/").some((part) => ["", ".", ".."].includes(part))
    )
      throw new GuardError(
        "lockfile-invalid",
        `Lockfile key ${entry.key.slice(0, 120)} is not a normalized project path`,
        REFRESH,
      );
    const project = entry.kind === "root" || entry.kind === "workspace";
    // Every installed dependency edge must already resolve inside the lockfile, otherwise npm would fetch unscreened packages.
    for (const edge of entry.edges)
      if (
        edge.type !== "optional" &&
        (edge.type !== "dev" || project) &&
        raw[entry.key]?.peerDependenciesMeta?.[edge.name]?.optional !== true &&
        !resolveEdge(lock, entry.key, edge.name) &&
        !linkedOutside(lock, entry.key, edge.name)
      )
        missing.push(`${entry.key || "(root)"} -> ${edge.name}`);
    if (entry.kind === "root") continue;
    if (entry.kind === "workspace" || entry.kind === "link") {
      items.set(`local:${entry.key}`, {
        id: `local:${entry.key}`,
        binding: entry.kind === "link" ? "local-link" : "workspace-package",
        paths: [entry.key],
      });
      continue;
    }
    if (entry.kind === "invalid")
      throw new GuardError(
        "lockfile-unbound",
        `Lockfile entry ${entry.key} has no exact registry name and version (${entry.reason})`,
        REFRESH,
      );
    const bound =
      entry.kind === "url"
        ? "non-registry-source"
        : entry.bundled
          ? "bundled-unverified"
          : !entry.resolved
            ? "missing-resolved"
            : !entry.integrity
              ? "missing-integrity"
              : !entry.bound || !SHA512.test(entry.integrity)
                ? "weak-integrity"
                : "registry-integrity";
    const id = `${entry.name}@${entry.version}`;
    const existing = items.get(id);
    if (!existing) {
      items.set(id, {
        id,
        name: entry.name,
        version: entry.version,
        integrity: entry.integrity,
        binding: bound,
        paths: [entry.key],
      });
      continue;
    }
    existing.paths.push(entry.key);
    if (bound !== "registry-integrity") existing.binding = bound;
    else if (existing.integrity !== entry.integrity)
      existing.binding = "conflicting-integrity";
  }
  if (missing.length)
    throw new GuardError(
      "lockfile-incomplete",
      `The lockfile has no resolved entry for ${missing.length} required dependencies (${missing.slice(0, 3).join("; ")}), so npm would resolve unscreened packages`,
      REFRESH,
    );
  return [...items.values()].sort(byId);
}

async function boundedRead(file, max) {
  const info = await stat(file);
  const bytes = info.isFile() && info.size <= max ? await readFile(file) : null;
  if (!bytes || bytes.length > max)
    throw new GuardError(
      "plan-limit",
      `${path.basename(file)} is not a regular file within the size limit`,
    );
  return bytes;
}
async function readInputs(cwd, limits) {
  for (const lockfile of ["npm-shrinkwrap.json", "package-lock.json"]) {
    let lockBytes;
    try {
      lockBytes = await boundedRead(
        path.join(cwd, lockfile),
        limits.lockfileBytes,
      );
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    let manifestBytes;
    try {
      manifestBytes = await boundedRead(
        path.join(cwd, "package.json"),
        limits.manifestBytes,
      );
    } catch (error) {
      if (error instanceof GuardError) throw error;
      throw new GuardError(
        "lockfile-invalid",
        "package.json could not be read",
        REFRESH,
      );
    }
    return {
      lockfile,
      lockBytes,
      digest: `${sha256(lockBytes)}:${sha256(manifestBytes)}`,
      manifestBytes,
    };
  }
  throw new GuardError(
    "lockfile-missing",
    "No package-lock.json or npm-shrinkwrap.json in this directory, so no exact plan exists",
    "Run `npm install --package-lock-only --ignore-scripts` in the project root, then rerun `unmask ci`.",
  );
}

export async function readProjectPlan(cwd, limits = GUARD_LIMITS) {
  const { manifestBytes, ...inputs } = await readInputs(cwd, limits);
  return {
    ...inputs,
    packages: planFromLockfile(
      inputs.lockBytes.toString("utf8"),
      manifestBytes.toString("utf8"),
      limits,
    ),
  };
}

async function fetchJson(fetchImpl, url, options, limits, signal) {
  const response = await fetchImpl(url, {
    ...options,
    redirect: "manual",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    signal,
    headers: { accept: "application/json", ...(options.headers ?? {}) },
  });
  try {
    if (response.status !== 200)
      throw Object.assign(new Error("http-error"), { status: response.status });
    if (
      !/^application\/json\b/i.test(response.headers.get("content-type") ?? "")
    )
      throw new Error("invalid-response");
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.byteLength;
      if (size > limits.responseBytes) throw new Error("response-limit");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } finally {
    response.body?.cancel?.().catch?.(() => {});
  }
}
const classify = (record, item) =>
  classifyGuardAdvisory(record, {
    ecosystem: "npm",
    name: item.name,
    version: item.version,
  });
const unknownLookup = (reason, advisories = []) => ({
  complete: false,
  reasons: [reason],
  advisories,
});
const activeFindings = (classified) =>
  classified
    .filter((record) => record.status === "active")
    .map((record) => ({
      id: record.id,
      malware: record.knownMalware,
      severity: record.severity,
    }));

async function osvLookups(registry, { fetchImpl, signal, limits }) {
  const lookups = new Map();
  for (let start = 0; start < registry.length; start += limits.batchSize) {
    const batch = registry.slice(start, start + limits.batchSize);
    let results;
    try {
      const body = await fetchJson(
        fetchImpl,
        OSV_BATCH,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            queries: batch.map((item) => ({
              package: { name: item.name, ecosystem: "npm" },
              version: item.version,
            })),
          }),
        },
        limits,
        signal,
      );
      results = body?.results;
      if (!Array.isArray(results) || results.length !== batch.length)
        throw new Error("invalid-response");
    } catch {
      for (const item of batch)
        lookups.set(item.id, unknownLookup("advisory-lookup-unavailable"));
      continue;
    }
    batch.forEach((item, index) => {
      const result = results[index];
      const vulns = object(result) ? (result.vulns ?? []) : null;
      if (
        !Array.isArray(vulns) ||
        result.next_page_token ||
        !identifiers(vulns.map((vuln) => vuln?.id))
      )
        lookups.set(item.id, unknownLookup("invalid-advisory-record"));
      else
        lookups.set(item.id, {
          ids: [...new Set(vulns.map((vuln) => vuln.id))].sort(),
        });
    });
  }
  const ids = [
    ...new Set([...lookups.values()].flatMap((item) => item.ids ?? [])),
  ].slice(0, limits.detailFetches);
  const details = new Map();
  let cursor = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(limits.concurrency, ids.length) },
      async () => {
        while (cursor < ids.length) {
          const id = ids[cursor++];
          try {
            const detail = await fetchJson(
              fetchImpl,
              OSV_VULN + encodeURIComponent(id),
              { method: "GET" },
              limits,
              signal,
            );
            if (detail?.id === id) details.set(id, detail);
          } catch {}
        }
      },
    ),
  );
  const byPackage = new Map(registry.map((item) => [item.id, item]));
  for (const [key, lookup] of lookups) {
    if (!lookup.ids) continue;
    const advisories = [];
    let complete = true;
    for (const id of lookup.ids) {
      const detail = details.get(id);
      if (!detail) complete = false;
      else {
        const record = classify(
          {
            id: detail.id,
            aliases: detail.aliases ?? [],
            withdrawn: detail.withdrawn,
            databaseSeverity: detail.database_specific?.severity,
            affected: (Array.isArray(detail.affected) ? detail.affected : [])
              .slice(0, 8)
              .map((affected) => ({
                package: affected?.package,
                ecosystemSeverity: affected?.ecosystem_specific?.severity,
              })),
          },
          byPackage.get(key),
        );
        if (record.status === "invalid") complete = false;
        else if (record.status === "active")
          advisories.push({
            id,
            malware: record.knownMalware,
            severity: record.severity,
          });
      }
    }
    lookups.set(key, {
      complete,
      reasons: complete ? [] : ["advisory-detail-unavailable"],
      advisories,
    });
  }
  return lookups;
}

async function hostedLookups(
  registry,
  { fetchImpl, signal, limits, serverUrl, lockBytes },
) {
  const origin = serverOrigin(serverUrl ?? DEFAULT_SERVER_URL);
  const lookups = new Map();
  const failAll = (reason) => {
    for (const item of registry) lookups.set(item.id, unknownLookup(reason));
    return lookups;
  };
  let body;
  try {
    body = await fetchJson(
      fetchImpl,
      `${origin}/api/dependency-screening`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: lockBytes,
      },
      limits,
      signal,
    );
  } catch (error) {
    return failAll(
      error?.status === 429
        ? "hosted-rate-limited"
        : error?.status
          ? `hosted-http-${error.status}`
          : "hosted-unavailable",
    );
  }
  if (
    !object(body) ||
    body.schemaVersion !== "1" ||
    body.coverage?.scope !== "exact-registry-identities" ||
    !Array.isArray(body.dependencies)
  )
    return failAll("hosted-invalid-response");
  const rows = new Map();
  for (const row of body.dependencies) {
    if (!object(row) || typeof row.spec !== "string" || rows.has(row.spec))
      return failAll("hosted-invalid-response");
    rows.set(row.spec, row);
  }
  const planned = new Set(registry.map((item) => item.id));
  const extraRows = [...rows.keys()].some((spec) => !planned.has(spec));
  for (const item of registry) {
    const row = rows.get(item.id);
    const records = Array.isArray(row?.advisories) ? row.advisories : null;
    const classified = (records ?? []).map((record) => classify(record, item));
    const settled =
      ["found", "none-reported"].includes(row?.status) && row.complete === true;
    let reason;
    if (!row) reason = "hosted-missing-identity";
    else if (
      row.name !== item.name ||
      row.version !== item.version ||
      row.integrityStatus !== "consistent" ||
      row.integrity !== item.integrity
    )
      reason = "hosted-identity-mismatch";
    else if (!settled)
      reason = identifiers([row.status])
        ? `hosted-${row.status}`
        : "hosted-invalid-response";
    else if (
      !records ||
      (row.status === "found") !== records.length > 0 ||
      classified.some((record) => record.status === "invalid")
    )
      reason = "hosted-invalid-advisory-record";
    else if (extraRows) reason = "hosted-plan-mismatch";
    // Valid advisories for the exact name@version stay as evidence even when coverage is incomplete; unknown still blocks the rest.
    const evidence =
      row?.name === item.name && row?.version === item.version
        ? activeFindings(classified)
        : [];
    if (reason) {
      lookups.set(item.id, unknownLookup(reason, evidence));
      continue;
    }
    lookups.set(item.id, {
      complete: true,
      reasons: [],
      advisories: activeFindings(classified),
    });
  }
  return lookups;
}

export async function screenPlan(
  plan,
  {
    source = "hosted",
    fetchImpl = globalThis.fetch,
    signal,
    policy = "strict",
    limits = GUARD_LIMITS,
    serverUrl,
    config,
    now = new Date(),
  } = {},
) {
  if (!Object.hasOwn(PROFILES, policy))
    throw new GuardError(
      "usage",
      "UNMASK_GUARD_POLICY must be strict, balanced or audit",
    );
  const profile = PROFILES[policy];
  if (!GUARD_SOURCES.includes(source))
    throw new GuardError("usage", "UNMASK_GUARD_SOURCE must be hosted or osv");
  const lifetime = AbortSignal.any([
    AbortSignal.timeout(limits.timeoutMs),
    ...(signal ? [signal] : []),
  ]);
  const registry = plan.packages.filter(
    (item) => item.binding === "registry-integrity",
  );
  const lookups = !registry.length
    ? new Map()
    : source === "osv"
      ? await osvLookups(registry, { fetchImpl, signal: lifetime, limits })
      : await hostedLookups(registry, {
          fetchImpl,
          signal: lifetime,
          limits,
          serverUrl,
          lockBytes: plan.lockBytes,
        });
  const threshold = SEVERITY.indexOf(profile.blockSeverity);
  const decisions = plan.packages.map((item) => {
    const lookup = lookups.get(item.id);
    const advisories = lookup?.advisories ?? [];
    const reasons = [];
    if (item.binding !== "registry-integrity")
      reasons.push(`unbound-identity:${item.binding}`);
    else if (!lookup) reasons.push("advisory-lookup-missing");
    else reasons.push(...lookup.reasons);
    const malware = advisories.filter((advisory) => advisory.malware);
    const severe = advisories.filter(
      (advisory) =>
        SEVERITY.indexOf(advisory.severity) >= threshold ||
        (advisory.severity === "unknown" &&
          profile.unknownDecision === "block"),
    );
    let decision = "allow";
    if (malware.length) {
      decision = "block";
      reasons.unshift("known-malware");
    } else if (reasons.length) decision = "unknown";
    else if (severe.length) {
      decision = "block";
      reasons.push(
        `advisory-severity:${[...new Set(severe.map((advisory) => (advisory.severity === "unknown" ? "unrated" : advisory.severity)))].join("/")}`,
      );
    } else if (advisories.length) {
      decision = "warn";
      reasons.push("advisory-reported");
    }
    // Exact expiring exceptions waive only a pure severity block on a registry-bound identity, never malware or unknown evidence.
    const exception =
      config &&
      decision === "block" &&
      !malware.length &&
      reasons.length === 1 &&
      reasons[0].startsWith("advisory-severity:") &&
      item.binding === "registry-integrity" &&
      activeExceptionFor(config, item, {
        now,
        knownMalware: malware.length > 0,
      });
    if (exception) {
      decision = "warn";
      reasons.push(`exception-until:${exception.expires}`);
    }
    return {
      id: item.id,
      decision,
      permitted:
        ["allow", "warn"].includes(decision) ||
        (profile.enforcement === "audit" && !malware.length),
      reasons,
      advisories: advisories.map((advisory) => advisory.id),
      paths: item.paths,
    };
  });
  const count = (decision) =>
    decisions.filter((item) => item.decision === decision).length;
  const summary = {
    allow: count("allow"),
    warn: count("warn"),
    block: count("block"),
    unknown: count("unknown"),
  };
  return {
    policy,
    source:
      source === "osv"
        ? "OSV (diagnostic direct query)"
        : "hosted dependency screening",
    registry: registry.length,
    decisions,
    summary,
    enforcement: profile.enforcement,
    blocked: decisions.some((item) => !item.permitted),
  };
}

function report(stream, plan, result) {
  const lines = [
    `unmask guard: ${plan.lockfile}: ${result.registry} exact registry identities in advisory screening via ${result.source}, ${plan.packages.length - result.registry} other entries (${result.policy} policy)`,
    `unmask guard: allow ${result.summary.allow}, warn ${result.summary.warn}, unknown ${result.summary.unknown}, block ${result.summary.block}`,
    ...(result.notices ?? []).map((notice) => `unmask guard: ${notice}`),
  ];
  if (result.enforcement === "audit")
    lines.push(
      "unmask guard: audit profile is nonenforcing; only known malware stops npm.",
    );
  const shown = result.decisions.filter((item) => item.decision !== "allow");
  for (const item of shown.slice(0, 25))
    lines.push(
      `  ${item.decision.padEnd(7)} ${item.id} ${item.reasons.join(",")}${item.advisories.length ? ` [${item.advisories.slice(0, 5).join(" ")}]` : ""}`,
    );
  if (shown.length > 25) lines.push(`  ... ${shown.length - 25} more`);
  lines.push(
    result.blocked
      ? "unmask guard: blocked; npm was not started."
      : "unmask guard: no blocking finding. Advisory screening only; this is not a safety verdict.",
  );
  stream.write(lines.join("\n") + "\n");
}

function runNpm(command, args, { cwd, env, capture = false, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...env, [GUARD_ACTIVE_ENV]: "1" },
      stdio: capture ? ["ignore", "pipe", "ignore"] : "inherit",
      shell: false,
      ...(timeoutMs ? { timeout: timeoutMs } : {}),
    });
    let output = "";
    child.stdout?.on("data", (chunk) => {
      if (output.length < 8192) output += chunk;
    });
    child.once("error", (error) => resolve({ error }));
    child.once("close", (code, signal) =>
      resolve({
        code: code ?? 128 + (os.constants.signals[signal] ?? 0),
        output: output.trim(),
      }),
    );
  });
}
async function probeNpmTarget(npm, cwd, env, limits) {
  const read = async (args) => {
    const outcome = await runNpm(npm, args, {
      cwd,
      env,
      capture: true,
      timeoutMs: limits.probeTimeoutMs,
    });
    if (outcome.error || outcome.code !== 0)
      throw new GuardError(
        "npm-unavailable",
        "npm could not report its effective configuration; nothing was installed",
      );
    return outcome.output;
  };
  const prefix = await read(["prefix"]);
  const global = await read(["config", "get", "global"]);
  const lock = await read(["config", "get", "package-lock"]);
  const target = await realpath(prefix).catch(() => null);
  if (target !== (await realpath(cwd)) || global !== "false" || lock !== "true")
    throw new GuardError(
      "npm-config-retarget",
      "npm's effective configuration targets another prefix, enables global mode or disables the lockfile, so it would not install the screened plan",
      "Remove global, prefix, location or package-lock settings from the .npmrc files that apply to this project.",
    );
}

async function projectSettings(cwd, now) {
  try {
    return await loadGuardSettings(cwd, { now });
  } catch (error) {
    throw new GuardError(
      "guard-config-invalid",
      `Project guard configuration could not be used (${typeof error?.code === "string" ? error.code : "unreadable"}): ${error?.message ?? "unknown error"}`,
      "Fix or remove .unmask.json with `unmask config`; the guard does not fall back to defaults when it is unusable.",
    );
  }
}
// Only an explicit invocation may select the nonenforcing audit profile; a project file requesting it falls back to strict.
function selectProfile(requested, settings) {
  const where = settings.source === "file" ? settings.file : "defaults";
  if (requested)
    return {
      profile: requested,
      notices: [`profile ${requested} selected by UNMASK_GUARD_POLICY`],
    };
  if (settings.config.profile === "audit")
    return {
      profile: "strict",
      notices: [
        `${where} requests the nonenforcing audit profile, which applies only with UNMASK_GUARD_POLICY=audit; strict is used`,
      ],
    };
  return {
    profile: settings.config.profile,
    notices: [`profile ${settings.config.profile} from ${where}`],
  };
}

export async function runInstallGuard(command, args, runtime = {}) {
  const env = runtime.env ?? process.env;
  const stderr = runtime.stderr ?? process.stderr;
  const cwd = runtime.cwd ?? process.cwd();
  const limits = runtime.limits ?? GUARD_LIMITS;
  const npm = runtime.npmCommand ?? "npm";
  try {
    if (env[GUARD_ACTIVE_ENV])
      throw new GuardError(
        "recursive-guard",
        "unmask install/ci was started from inside a guarded npm run",
        "Lifecycle scripts inside a guarded install use plain npm; the outer plan was already screened.",
      );
    if (command !== "ci")
      throw new GuardError(
        "install-unbindable",
        "npm install can re-resolve versions after screening, so unmask does not run it",
        `Update the lockfile without running package code with \`npm install --package-lock-only --ignore-scripts${args.length ? " " + args.join(" ") : ""}\`, review the diff, then run \`unmask ci\`.`,
      );
    inspectCiArguments(args);
    inspectNpmEnvironment(env);
    const plan = await readProjectPlan(cwd, limits);
    const now = runtime.now ? runtime.now() : new Date();
    const settings = await projectSettings(cwd, now);
    const selected = selectProfile(env.UNMASK_GUARD_POLICY, settings);
    const result = await screenPlan(plan, {
      source: env.UNMASK_GUARD_SOURCE || "hosted",
      fetchImpl: runtime.fetchImpl,
      signal: runtime.signal,
      policy: selected.profile,
      limits,
      serverUrl: env.UNMASK_SERVER_URL,
      config: settings.config,
      now,
    });
    result.notices = selected.notices;
    report(stderr, plan, result);
    if (result.blocked) return 3;
    await probeNpmTarget(npm, cwd, env, limits);
    if ((await readInputs(cwd, limits)).digest !== plan.digest)
      throw new GuardError(
        "plan-changed",
        `${plan.lockfile} or package.json changed after screening; npm was not started`,
        "Rerun `unmask ci` once the project files are stable.",
      );
    const outcome = await runNpm(npm, ["ci", ...args], { cwd, env });
    if (outcome.error) {
      stderr.write(
        "npm-unavailable: npm could not be started; nothing was installed by unmask.\n",
      );
      return 1;
    }
    const after = await readFile(path.join(cwd, plan.lockfile)).catch(
      () => null,
    );
    if (!after || sha256(after) !== plan.digest.split(":")[0])
      stderr.write(
        `unmask guard: warning: ${plan.lockfile} changed during npm ci.\n`,
      );
    return outcome.code;
  } catch (error) {
    if (error instanceof GuardError || error instanceof LocalInputError) {
      stderr.write(`${error.code}: ${error.message}\n`);
      if (error.remediation)
        stderr.write(`remediation: ${error.remediation}\n`);
      return 2;
    }
    stderr.write(
      "Internal guard error; npm was not started and no screening result is claimed.\n",
    );
    return 1;
  }
}
