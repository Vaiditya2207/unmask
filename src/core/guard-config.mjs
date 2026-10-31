import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

export const GUARD_CONFIG_SCHEMA = 1;
export const GUARD_CONFIG_FILE = ".unmask.json";
export const DEFAULT_PROFILE = "strict";
export const PROFILES = Object.freeze({
  strict: Object.freeze({
    unknownDecision: "block",
    blockSeverity: "medium",
    knownMalware: "block",
    aiSignals: "nonbinding",
    enforcement: "enforce",
  }),
  balanced: Object.freeze({
    unknownDecision: "unknown",
    blockSeverity: "high",
    knownMalware: "block",
    aiSignals: "nonbinding",
    enforcement: "enforce",
  }),
  audit: Object.freeze({
    unknownDecision: "unknown",
    blockSeverity: "critical",
    knownMalware: "block",
    aiSignals: "nonbinding",
    enforcement: "audit",
  }),
});
export const GUARD_SEMANTICS = Object.freeze([
  "Profile names and settings mirror the S07 guard evaluator; there are no per-setting overrides.",
  "strict blocks incomplete evidence and advisories of medium (moderate) severity or higher.",
  "balanced blocks high or critical advisories; incomplete evidence stays unknown and is not permitted.",
  "audit is nonenforcing: decisions are reported but nothing is blocked; a project-stored audit profile takes effect only when the invoking command explicitly opts in.",
  "Known malware is always a block decision, and AI signals are nonbinding.",
]);
export const SETTINGS = Object.freeze({ profile: Object.keys(PROFILES) });
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
    if (!["schemaVersion", "profile"].includes(key))
      fail("invalid-config", "Guard configuration contains an unknown field");
  if (value.schemaVersion !== GUARD_CONFIG_SCHEMA)
    fail("invalid-config", "Unsupported guard configuration schemaVersion");
  validateSetting("profile", value.profile);
  return { schemaVersion: GUARD_CONFIG_SCHEMA, profile: value.profile };
}

export function effectiveGuardSettings(config) {
  const settings = { profile: config.profile, ...PROFILES[config.profile] };
  const warnings =
    settings.enforcement === "audit"
      ? [
          "The audit profile is nonenforcing: nothing is blocked, and it applies only when the invoking command explicitly opts in.",
        ]
      : [];
  return { settings, warnings };
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
  const stat = await lstat(root).catch(() => null);
  if (!stat?.isDirectory())
    fail("invalid-project", "Project path must be a directory");
  return { root, file: path.join(root, GUARD_CONFIG_FILE) };
}

const unreadable = () =>
  fail("unreadable-config", "Guard configuration file cannot be read");

async function readBounded(handle) {
  const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
  let total = 0;
  while (total < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      total,
      buffer.length - total,
      null,
    );
    if (!bytesRead) break;
    total += bytesRead;
  }
  if (total > MAX_CONFIG_BYTES)
    fail("invalid-config", "Guard configuration file is too large");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      buffer.subarray(0, total),
    );
  } catch {
    fail("invalid-config", "Guard configuration is not valid UTF-8");
  }
}

export async function readGuardConfig(projectDir) {
  const location = await guardConfigLocation(projectDir);
  let before;
  try {
    before = await lstat(location.file);
  } catch (error) {
    if (error.code === "ENOENT")
      return { ...location, source: "default", config: defaultGuardConfig() };
    unreadable();
  }
  if (before.isSymbolicLink())
    fail("path-escape", "Guard configuration file must not be a symlink");
  if (!before.isFile())
    fail("invalid-config", "Guard configuration must be a regular file");
  let handle;
  try {
    handle = await open(
      location.file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (error.code === "ELOOP")
      fail("path-escape", "Guard configuration file must not be a symlink");
    unreadable();
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev)
      fail("invalid-config", "Guard configuration must be a regular file");
    if (stat.mode & 0o022)
      fail(
        "unsafe-permissions",
        "Guard configuration file is writable by other users",
      );
    if (stat.size > MAX_CONFIG_BYTES)
      fail("invalid-config", "Guard configuration file is too large");
    let text;
    try {
      text = await readBounded(handle);
    } catch (error) {
      if (error instanceof GuardConfigError) throw error;
      unreadable();
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
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
      warnings: loaded.warnings,
    };
  } catch (error) {
    return error instanceof GuardConfigError
      ? { status: "invalid", code: error.code, message: error.message }
      : {
          status: "invalid",
          code: "unreadable-config",
          message: "Guard configuration could not be inspected",
        };
  }
}
