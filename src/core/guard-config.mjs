import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { AcquisitionError, parsePackageSpec } from "./acquire.mjs";

export const GUARD_CONFIG_SCHEMA = 1;
export const GUARD_CONFIG_FILE = ".unmask.json";
export const DEFAULT_PROFILE = "strict";
export const SEVERITIES = Object.freeze([
  "low",
  "moderate",
  "high",
  "critical",
  "none",
]);
export const PROFILES = Object.freeze({
  strict: Object.freeze({
    unknown: "block",
    blockAtSeverity: "moderate",
    knownMalware: "block",
    aiSignals: "nonbinding",
    enforcement: "enforcing",
  }),
  balanced: Object.freeze({
    unknown: "warn",
    blockAtSeverity: "high",
    knownMalware: "block",
    aiSignals: "nonbinding",
    enforcement: "enforcing",
  }),
  audit: Object.freeze({
    unknown: "warn",
    blockAtSeverity: "none",
    knownMalware: "warn",
    aiSignals: "nonbinding",
    enforcement: "nonenforcing",
  }),
});
export const GUARD_SEMANTICS = Object.freeze([
  "blockAtSeverity blocks advisories at or above that severity (moderate is also called medium).",
  "unknown=warn only changes presentation; incomplete evidence is never reported as permitted.",
  "audit is nonenforcing: decisions are reported but never block installation.",
  "AI signals are nonbinding and never permit or block on their own.",
]);
export const SETTINGS = Object.freeze({
  profile: Object.keys(PROFILES),
  unknown: ["block", "warn"],
  blockAtSeverity: SEVERITIES,
});
const MAX_CONFIG_BYTES = 64 * 1024;
export const MAX_EXCEPTIONS = 200;
export const MAX_EXCEPTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const SECRET_LIKE =
  /(npm_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN|xox[abpr]-[A-Za-z0-9-]{10,})/u;

export class GuardConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GuardConfigError";
    this.code = code;
    this.exitCode = 2;
  }
}
const fail = (code, message) => {
  throw new GuardConfigError(code, message);
};
const plainObject = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

export function validateSetting(key, value) {
  if (!Object.hasOwn(SETTINGS, key))
    fail(
      "invalid-setting",
      `Unknown guard setting; expected one of ${Object.keys(SETTINGS).join(", ")}`,
    );
  if (typeof value !== "string" || !SETTINGS[key].includes(value))
    fail(
      "invalid-value",
      `Invalid ${key}; expected one of ${SETTINGS[key].join(", ")}`,
    );
  return value;
}

export function defaultGuardConfig() {
  return { schemaVersion: GUARD_CONFIG_SCHEMA, profile: DEFAULT_PROFILE };
}

export function validateGuardConfig(value) {
  if (!plainObject(value))
    fail("invalid-config", "Guard configuration must be a JSON object");
  for (const key of Object.keys(value))
    if (!["schemaVersion", "profile", "overrides", "exceptions"].includes(key))
      fail("invalid-config", "Guard configuration contains an unknown field");
  if (value.schemaVersion !== GUARD_CONFIG_SCHEMA)
    fail("invalid-config", "Unsupported guard configuration schemaVersion");
  validateSetting("profile", value.profile);
  const config = { schemaVersion: GUARD_CONFIG_SCHEMA, profile: value.profile };
  if (value.overrides !== undefined) {
    if (!plainObject(value.overrides))
      fail("invalid-config", "Guard configuration overrides must be an object");
    const overrides = {};
    for (const [key, setting] of Object.entries(value.overrides)) {
      if (key === "profile")
        fail("invalid-config", "Profile cannot be an override");
      overrides[key] = validateSetting(key, setting);
    }
    if (Object.keys(overrides).length) config.overrides = overrides;
  }
  if (value.exceptions !== undefined) {
    if (
      !Array.isArray(value.exceptions) ||
      value.exceptions.length > MAX_EXCEPTIONS
    )
      fail(
        "invalid-config",
        `Guard exceptions must be an array of at most ${MAX_EXCEPTIONS}`,
      );
    const seen = new Set();
    const exceptions = value.exceptions.map(validateException);
    for (const entry of exceptions) {
      const key = `${entry.name}@${entry.version}`;
      if (seen.has(key))
        fail("duplicate-exception", `Duplicate exception for ${key}`);
      seen.add(key);
    }
    if (exceptions.length) config.exceptions = exceptions;
  }
  return config;
}

export function exactPackage(spec) {
  try {
    return parsePackageSpec(spec);
  } catch (error) {
    if (error instanceof AcquisitionError)
      fail(
        "invalid-package-spec",
        "Exceptions require one exact name@version; ranges, tags and wildcards are refused",
      );
    throw error;
  }
}

function timestamp(value, field) {
  if (
    typeof value !== "string" ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    fail("invalid-config", `Exception ${field} must be an ISO UTC timestamp`);
  return Date.parse(value);
}

export function validateReason(reason) {
  if (
    typeof reason !== "string" ||
    reason.trim().length < 3 ||
    reason.length > 200 ||
    /[\0-\x1f\x7f]/u.test(reason)
  )
    fail(
      "invalid-reason",
      "Exception reason must be 3-200 printable characters",
    );
  if (SECRET_LIKE.test(reason))
    fail("invalid-reason", "Exception reason looks like a credential");
  return reason;
}

export function validateException(value) {
  if (!plainObject(value))
    fail("invalid-config", "Each guard exception must be an object");
  for (const key of Object.keys(value))
    if (!["name", "version", "reason", "expires", "created"].includes(key))
      fail("invalid-config", "Guard exception contains an unknown field");
  if (typeof value.name !== "string" || typeof value.version !== "string")
    fail("invalid-package-spec", "Exception requires exact name and version");
  const { name, version } = exactPackage(`${value.name}@${value.version}`);
  if (name !== value.name || version !== value.version)
    fail("invalid-package-spec", "Exception identity must be exact");
  const created = timestamp(value.created, "created");
  const expires = timestamp(value.expires, "expires");
  if (expires <= created || expires - created > MAX_EXCEPTION_DAYS * DAY_MS)
    fail(
      "invalid-expiry",
      `Exception expiry must be after creation and within ${MAX_EXCEPTION_DAYS} days`,
    );
  return {
    name,
    version,
    reason: validateReason(value.reason),
    expires: value.expires,
    created: value.created,
  };
}

export function newException(spec, reason, expires, now = new Date()) {
  const { name, version } = exactPackage(spec);
  const day = /^\d{4}-\d{2}-\d{2}$/u.test(expires ?? "")
    ? `${expires}T00:00:00.000Z`
    : expires;
  if (typeof day !== "string" || Number.isNaN(Date.parse(day)))
    fail(
      "invalid-expiry",
      "Exception requires --expires YYYY-MM-DD or an ISO timestamp",
    );
  const expiry = Date.parse(day);
  if (expiry <= now.getTime())
    fail("expired-exception", "Exception expiry must be in the future");
  if (expiry - now.getTime() > MAX_EXCEPTION_DAYS * DAY_MS)
    fail(
      "invalid-expiry",
      `Exception expiry must be within ${MAX_EXCEPTION_DAYS} days`,
    );
  return validateException({
    name,
    version,
    reason,
    expires: new Date(expiry).toISOString(),
    created: now.toISOString(),
  });
}

export function exceptionStatuses(config, now = new Date()) {
  return (config.exceptions ?? []).map((entry) => ({
    ...entry,
    status: Date.parse(entry.expires) > now.getTime() ? "active" : "expired",
  }));
}

export function activeExceptionFor(
  config,
  identity,
  { now = new Date(), knownMalware = false } = {},
) {
  if (knownMalware) return null;
  return (
    exceptionStatuses(config, now).find(
      (entry) =>
        entry.status === "active" &&
        entry.name === identity?.name &&
        entry.version === identity?.version,
    ) ?? null
  );
}

export function effectiveGuardSettings(config) {
  const base = PROFILES[config.profile];
  const settings = { profile: config.profile };
  const sources = { profile: "config" };
  for (const [key, value] of Object.entries(base)) {
    const override = config.overrides?.[key];
    settings[key] = override ?? value;
    sources[key] = override === undefined ? "profile" : "override";
  }
  return { settings, sources };
}

export async function guardConfigLocation(projectDir) {
  if (
    typeof projectDir !== "string" ||
    !projectDir ||
    projectDir.includes("\0")
  )
    fail("invalid-project", "Project directory must be a non-empty path");
  let root;
  try {
    root = await realpath(path.resolve(projectDir));
  } catch {
    fail("invalid-project", "Project directory does not exist");
  }
  if (!(await lstat(root)).isDirectory())
    fail("invalid-project", "Project path must be a directory");
  return { root, file: path.join(root, GUARD_CONFIG_FILE) };
}

export async function readGuardConfig(projectDir) {
  const location = await guardConfigLocation(projectDir);
  let handle;
  try {
    handle = await open(
      location.file,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (error.code === "ENOENT")
      return { ...location, source: "default", config: defaultGuardConfig() };
    if (error.code === "ELOOP")
      fail("path-escape", "Guard configuration file must not be a symlink");
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile())
      fail("invalid-config", "Guard configuration must be a regular file");
    if (stat.mode & 0o022)
      fail(
        "unsafe-permissions",
        "Guard configuration file is writable by other users",
      );
    if (stat.size > MAX_CONFIG_BYTES)
      fail("invalid-config", "Guard configuration file is too large");
    let parsed;
    try {
      parsed = JSON.parse(await handle.readFile("utf8"));
    } catch {
      fail("invalid-config", "Guard configuration is not valid JSON");
    }
    return { ...location, source: "file", config: validateGuardConfig(parsed) };
  } finally {
    await handle.close();
  }
}

export async function writeGuardConfig(projectDir, config) {
  const valid = validateGuardConfig(config);
  const location = await guardConfigLocation(projectDir);
  const existing = await lstat(location.file).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing?.isSymbolicLink() || (existing && !existing.isFile()))
    fail("path-escape", "Guard configuration file must be a regular file");
  const temporary = path.join(
    location.root,
    `${GUARD_CONFIG_FILE}.${randomBytes(8).toString("hex")}.tmp`,
  );
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(valid, null, 2) + "\n");
    await handle.sync();
    await handle.close();
    await rename(temporary, location.file);
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return { ...location, source: "file", config: valid };
}

export async function loadGuardSettings(projectDir) {
  const loaded = await readGuardConfig(projectDir);
  return { ...loaded, ...effectiveGuardSettings(loaded.config) };
}

export async function inspectGuardConfig(projectDir) {
  try {
    const loaded = await loadGuardSettings(projectDir);
    return {
      status: loaded.source === "file" ? "ok" : "default",
      file: loaded.file,
      settings: loaded.settings,
    };
  } catch (error) {
    if (!(error instanceof GuardConfigError)) throw error;
    return { status: "invalid", code: error.code, message: error.message };
  }
}
