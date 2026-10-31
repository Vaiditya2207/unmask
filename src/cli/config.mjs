import {
  GUARD_SEMANTICS,
  GuardConfigError,
  PROFILES,
  effectiveGuardSettings,
  readGuardConfig,
  validateSetting,
  writeGuardConfig,
} from "../core/guard-config.mjs";

const USAGE =
  "Use config show|profiles [--json] [--project DIR] or config set profile strict|balanced|audit [--project DIR]";
const STRENGTH = { strict: 2, balanced: 1, audit: 0 };

export function parseCommandOptions(args, flags = ["--json"]) {
  const positional = [];
  const options = { project: undefined, json: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--project") {
      const value = args[++index];
      if (
        options.project !== undefined ||
        value === undefined ||
        !value ||
        value.startsWith("--")
      )
        throw new GuardConfigError(
          "missing-value",
          "--project requires one directory",
        );
      options.project = value;
    } else if (flags.includes(arg)) {
      if (options[arg.slice(2)] === true)
        throw new GuardConfigError(
          "duplicate-option",
          "Each option may be supplied only once",
        );
      options[arg.slice(2)] = true;
    } else if (arg.startsWith("--"))
      throw new GuardConfigError("unknown-option", "Unsupported option");
    else positional.push(arg);
  }
  return { positional, options };
}

function describe(loaded) {
  const { settings, warnings } = effectiveGuardSettings(loaded.config);
  return {
    schemaVersion: loaded.config.schemaVersion,
    path: loaded.file,
    source: loaded.source,
    settings,
    warnings,
    scope:
      "Applies to explicit UNMASK guard decisions only; check report policy and exit codes are unchanged.",
    semantics: GUARD_SEMANTICS,
  };
}

function showText(view) {
  const lines = [
    `Guard configuration: ${view.path} (${view.source === "file" ? "file" : "defaults, no file"})`,
  ];
  for (const [key, value] of Object.entries(view.settings))
    lines.push(`  ${key}: ${value}`);
  lines.push(view.scope, ...view.semantics);
  return lines.join("\n") + "\n";
}

export async function runConfig(args, runtime = {}) {
  const stdout = runtime.stdout ?? process.stdout;
  const stderr = runtime.stderr ?? process.stderr;
  try {
    const { positional, options } = parseCommandOptions(args);
    const [action, key, value, ...extra] = positional;
    const project = options.project ?? runtime.cwd ?? process.cwd();
    if (action === "profiles" && !key) {
      stdout.write(
        options.json
          ? JSON.stringify(
              { profiles: PROFILES, semantics: GUARD_SEMANTICS },
              null,
              2,
            ) + "\n"
          : Object.entries(PROFILES)
              .map(
                ([name, settings]) =>
                  `${name}: ${Object.entries(settings)
                    .map(([k, v]) => `${k}=${v}`)
                    .join(" ")}`,
              )
              .concat(GUARD_SEMANTICS)
              .join("\n") + "\n",
      );
      return 0;
    }
    if (action === "show" && !key) {
      const view = describe(await readGuardConfig(project));
      for (const warning of view.warnings)
        stderr.write(`warning: ${warning}\n`);
      stdout.write(
        options.json ? JSON.stringify(view, null, 2) + "\n" : showText(view),
      );
      return 0;
    }
    if (options.json) throw new GuardConfigError("usage", USAGE);
    if (action === "set" && key && value !== undefined && !extra.length) {
      validateSetting(key, value);
      const loaded = await readGuardConfig(project);
      const before = loaded.config.profile;
      const saved = await writeGuardConfig(project, {
        ...loaded.config,
        profile: value,
      });
      stdout.write(`Updated profile: ${before} -> ${value} (${saved.file})\n`);
      if (STRENGTH[value] < STRENGTH[before])
        stderr.write(
          `warning: profile ${value} is less restrictive than ${before}\n`,
        );
      return 0;
    }
    throw new GuardConfigError("usage", USAGE);
  } catch (error) {
    if (error instanceof GuardConfigError) {
      stderr.write(`${error.code}: ${error.message}\n`);
      return 2;
    }
    stderr.write(
      "unreadable-config: Guard configuration error; no change is claimed.\n",
    );
    return 1;
  }
}
