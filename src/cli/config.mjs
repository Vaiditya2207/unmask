import {
  GUARD_SEMANTICS,
  GuardConfigError,
  PROFILES,
  SETTINGS,
  effectiveGuardSettings,
  readGuardConfig,
  validateSetting,
  writeGuardConfig,
} from "../core/guard-config.mjs";

const USAGE =
  "Use config show|profiles [--json] [--project DIR], config set KEY VALUE [--project DIR] or config unset KEY [--project DIR]";
const STRENGTH = { strict: 2, balanced: 1, audit: 0 };

export function parseCommandOptions(
  args,
  flags = ["--json"],
  values = ["--project"],
) {
  const positional = [];
  const options = { json: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const name = arg.slice(2);
    if (values.includes(arg)) {
      const value = args[++index];
      if (options[name] !== undefined || value === undefined || !value)
        throw new GuardConfigError(
          "missing-value",
          `${arg} requires exactly one value`,
        );
      options[name] = value;
    } else if (flags.includes(arg)) {
      if (options[name] === true)
        throw new GuardConfigError(
          "duplicate-option",
          "Each option may be supplied only once",
        );
      options[name] = true;
    } else if (arg.startsWith("--"))
      throw new GuardConfigError("unknown-option", "Unsupported option");
    else positional.push(arg);
  }
  return { positional, options };
}

function describe(loaded) {
  const { settings, sources } = effectiveGuardSettings(loaded.config);
  return {
    schemaVersion: loaded.config.schemaVersion,
    path: loaded.file,
    source: loaded.source,
    settings,
    sources,
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
    lines.push(`  ${key}: ${value} (${view.sources[key]})`);
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
      stdout.write(
        options.json ? JSON.stringify(view, null, 2) + "\n" : showText(view),
      );
      return 0;
    }
    if (options.json) throw new GuardConfigError("usage", USAGE);
    if (action === "set" && key && value !== undefined && !extra.length) {
      validateSetting(key, value);
      const loaded = await readGuardConfig(project);
      const before = effectiveGuardSettings(loaded.config).settings[key];
      const config = structuredClone(loaded.config);
      if (key === "profile") config.profile = value;
      else config.overrides = { ...config.overrides, [key]: value };
      const saved = await writeGuardConfig(project, config);
      stdout.write(`Updated ${key}: ${before} -> ${value} (${saved.file})\n`);
      if (key === "profile" && STRENGTH[value] < STRENGTH[before])
        stderr.write(
          `warning: profile ${value} is less restrictive than ${before}\n`,
        );
      return 0;
    }
    if (action === "unset" && key && value === undefined) {
      if (key === "profile")
        throw new GuardConfigError(
          "invalid-setting",
          "Profile cannot be unset; use config set profile NAME",
        );
      if (!Object.hasOwn(SETTINGS, key)) validateSetting(key, "");
      const loaded = await readGuardConfig(project);
      const config = structuredClone(loaded.config);
      const removed = config.overrides?.[key] !== undefined;
      if (config.overrides) delete config.overrides[key];
      const saved = removed ? await writeGuardConfig(project, config) : loaded;
      stdout.write(
        removed
          ? `Removed ${key} override; profile value applies (${saved.file})\n`
          : `No ${key} override was set (${saved.file})\n`,
      );
      return 0;
    }
    throw new GuardConfigError("usage", USAGE);
  } catch (error) {
    if (error instanceof GuardConfigError) {
      stderr.write(`${error.code}: ${error.message}\n`);
      return 2;
    }
    stderr.write("Guard configuration error; no change is claimed.\n");
    return 1;
  }
}
