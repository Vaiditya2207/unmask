import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

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
    if (!["schemaVersion", "profile", "overrides"].includes(key))
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
  return config;
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
