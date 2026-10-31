import {
  DEFAULT_PROFILE,
  GUARD_CONFIG_SCHEMA,
  GuardConfigError,
  createGuardConfig,
  loadGuardSettings,
  validateSetting,
} from "../core/guard-config.mjs";
import { parseCommandOptions } from "./config.mjs";

const USAGE =
  "Use init [--profile strict|balanced|audit] [--project DIR]; it only creates a new .unmask.json and never installs or runs anything";

export async function runInit(args, runtime = {}) {
  const stdout = runtime.stdout ?? process.stdout;
  const stderr = runtime.stderr ?? process.stderr;
  const now = runtime.now ? runtime.now() : new Date();
  try {
    const { positional, options } = parseCommandOptions(
      args,
      [],
      ["--project", "--profile"],
    );
    if (positional.length) throw new GuardConfigError("usage", USAGE);
    const profile = validateSetting(
      "profile",
      options.profile ?? DEFAULT_PROFILE,
    );
    const project = options.project ?? runtime.cwd ?? process.cwd();
    const created = await createGuardConfig(
      project,
      { schemaVersion: GUARD_CONFIG_SCHEMA, profile },
      { now },
    );
    const loaded = await loadGuardSettings(project, { now });
    if (loaded.source !== "file" || loaded.settings.profile !== profile)
      throw new GuardConfigError(
        "verify-failed",
        "The created configuration did not read back as written",
      );
    stdout.write(
      `Created ${created.file} with profile ${profile} (enforcement ${loaded.settings.enforcement}).\nNext: unmask config show; add exact expiring exceptions only with unmask exceptions add.\n`,
    );
    for (const warning of loaded.warnings)
      stderr.write(`warning: ${warning}\n`);
    return 0;
  } catch (error) {
    if (error instanceof GuardConfigError) {
      stderr.write(`${error.code}: ${error.message}\n`);
      return 2;
    }
    stderr.write(
      "init-failed: Guard configuration could not be created; no file is claimed.\n",
    );
    return 1;
  }
}
