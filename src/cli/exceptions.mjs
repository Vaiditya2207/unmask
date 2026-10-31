import {
  GuardConfigError,
  activeExceptionFor,
  exactPackage,
  exceptionStatuses,
  newException,
  readGuardConfig,
  writeGuardConfig,
} from "../core/guard-config.mjs";
import { parseCommandOptions } from "./config.mjs";

const USAGE =
  "Use exceptions list [--json], exceptions check NAME@VERSION [--json], exceptions add NAME@VERSION --reason TEXT --expires YYYY-MM-DD, exceptions remove NAME@VERSION or exceptions prune; each accepts --project DIR";
const SCOPE =
  "Exceptions apply only to the exact name@version listed, only until expiry, never to ranges, tags or wildcards. In enforcing profiles (strict, balanced) they never waive known malware; the audit profile blocks nothing.";

const line = (entry) =>
  `${entry.name}@${entry.version} ${entry.status === "active" ? "active" : "EXPIRED (not applied)"} expires=${entry.expires} created=${entry.created} reason=${JSON.stringify(entry.reason)}`;

function audit(stdout, action, entry, file) {
  stdout.write(
    `audit: ${action} exception ${entry.name}@${entry.version} expires=${entry.expires} reason=${JSON.stringify(entry.reason)} file=${file}\n`,
  );
}

export async function runExceptions(args, runtime = {}) {
  const stdout = runtime.stdout ?? process.stdout;
  const stderr = runtime.stderr ?? process.stderr;
  const now = runtime.now ? runtime.now() : new Date();
  try {
    const { positional, options } = parseCommandOptions(
      args,
      ["--json"],
      ["--project", "--reason", "--expires"],
    );
    const [action, spec, ...extra] = positional;
    const project = options.project ?? runtime.cwd ?? process.cwd();
    const mutation =
      options.reason !== undefined || options.expires !== undefined;
    if (extra.length || (action !== "add" && mutation))
      throw new GuardConfigError("usage", USAGE);
    if (action === "list" && !spec) {
      const loaded = await readGuardConfig(project, { now });
      const entries = exceptionStatuses(loaded.config, now);
      if (options.json)
        stdout.write(
          JSON.stringify(
            {
              path: loaded.file,
              source: loaded.source,
              checkedAt: now.toISOString(),
              scope: SCOPE,
              exceptions: entries,
            },
            null,
            2,
          ) + "\n",
        );
      else
        stdout.write(
          [
            `Guard exceptions: ${loaded.file} (${entries.filter((e) => e.status === "active").length} active, ${entries.filter((e) => e.status === "expired").length} expired)`,
            ...entries.map((entry) => `  ${line(entry)}`),
            SCOPE,
          ].join("\n") + "\n",
        );
      return 0;
    }
    if (action === "prune" && !spec && !options.json) {
      const loaded = await readGuardConfig(project, { now });
      const current = loaded.config.exceptions ?? [];
      const expired = exceptionStatuses(loaded.config, now).filter(
        (entry) => entry.status === "expired",
      );
      const saved = expired.length
        ? await writeGuardConfig(
            project,
            {
              ...loaded.config,
              exceptions: current.filter(
                (entry) => Date.parse(entry.expires) > now.getTime(),
              ),
            },
            { now },
          )
        : loaded;
      for (const entry of expired) audit(stdout, "pruned", entry, saved.file);
      stdout.write(`Pruned ${expired.length} expired exception(s)\n`);
      return 0;
    }
    if (action === "check" && spec) {
      const identity = exactPackage(spec);
      const loaded = await readGuardConfig(project, { now });
      const entry = activeExceptionFor(loaded.config, identity, { now });
      const result = {
        package: `${identity.name}@${identity.version}`,
        exception: entry,
        knownMalwareWaived: false,
        scope: SCOPE,
      };
      stdout.write(
        options.json
          ? JSON.stringify(result, null, 2) + "\n"
          : `${entry ? `Active exception: ${line(entry)}` : `No active exception for ${result.package}`}\n${SCOPE}\n`,
      );
      return 0;
    }
    if (options.json || !spec) throw new GuardConfigError("usage", USAGE);
    if (action === "add") {
      if (options.reason === undefined || options.expires === undefined)
        throw new GuardConfigError(
          "usage",
          "Exceptions require --reason TEXT and --expires YYYY-MM-DD",
        );
      const entry = newException(spec, options.reason, options.expires, now);
      const loaded = await readGuardConfig(project, { now });
      const current = loaded.config.exceptions ?? [];
      if (
        current.some(
          (e) => e.name === entry.name && e.version === entry.version,
        )
      )
        throw new GuardConfigError(
          "duplicate-exception",
          `An exception for ${spec} already exists; remove it first`,
        );
      const saved = await writeGuardConfig(
        project,
        {
          ...loaded.config,
          exceptions: [...current, entry],
        },
        { now },
      );
      audit(stdout, "added", entry, saved.file);
      return 0;
    }
    if (action === "remove") {
      const { name, version } = exactPackage(spec);
      const loaded = await readGuardConfig(project, { now });
      const current = loaded.config.exceptions ?? [];
      const entry = current.find(
        (e) => e.name === name && e.version === version,
      );
      if (!entry)
        throw new GuardConfigError(
          "missing-exception",
          `No exception exists for ${name}@${version}`,
        );
      const saved = await writeGuardConfig(
        project,
        {
          ...loaded.config,
          exceptions: current.filter((e) => e !== entry),
        },
        { now },
      );
      audit(stdout, "removed", entry, saved.file);
      return 0;
    }
    throw new GuardConfigError("usage", USAGE);
  } catch (error) {
    if (error instanceof GuardConfigError) {
      stderr.write(`${error.code}: ${error.message}\n`);
      return 2;
    }
    stderr.write("Guard exception error; no change is claimed.\n");
    return 1;
  }
}
