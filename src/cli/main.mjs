#!/usr/bin/env node
import { mkdir, open, unlink } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeLocal, LocalInputError } from "../core/pipeline.mjs";
import { renderReport } from "../viewer/render.mjs";
import { parsePackageSpec, AcquisitionError } from "../core/acquire.mjs";
import { addConfiguredModel } from "../core/online.mjs";
import { modelClientFromEnv } from "../model/config.mjs";
import { getHostedDetails } from "./hosted.mjs";
import { infoCommand } from "./info.mjs";
import {
  createProgress,
  renderCheckSummary,
  renderError,
  terminalStyle,
} from "./terminal.mjs";

const names = {
  "--tarball": "tarballPath",
  "--source-archive": "sourceArchivePath",
  "--commit": "commit",
  "--source-root": "sourceRoot",
  "--source-dir": "sourceDir",
  "--cache-dir": "cacheDir",
  "--out": "out",
  "--claim": "claim",
};
function exactClaim(spec) {
  try {
    return parsePackageSpec(spec);
  } catch (error) {
    if (error instanceof AcquisitionError)
      throw new LocalInputError(error.code, error.message);
    throw error;
  }
}
function parse(argv) {
  if (argv[0] !== "check")
    throw new LocalInputError(
      "usage",
      "Use check name@version or an explicit local tarball with --offline",
    );
  const options = {};
  let start = 1;
  if (argv[1] && !argv[1].startsWith("--")) {
    exactClaim(argv[1]);
    options.registrySpec = argv[1];
    start = 2;
  }
  const seen = new Set();
  for (let index = start; index < argv.length; index++) {
    const key = argv[index];
    if (seen.has(key))
      throw new LocalInputError(
        "duplicate-option",
        "Each option may be supplied only once",
      );
    seen.add(key);
    if (key === "--offline") {
      options.offline = true;
      continue;
    }
    if (key === "--allow-model") {
      options.allowModel = true;
      continue;
    }
    if (!Object.hasOwn(names, key))
      throw new LocalInputError(
        "unknown-option",
        "Only the documented check options are supported",
      );
    const value = argv[++index];
    if (
      value === undefined ||
      value.startsWith("--") ||
      (!value && key !== "--source-dir")
    )
      throw new LocalInputError(
        "missing-value",
        "An option is missing its value",
      );
    options[names[key]] = value;
  }
  if (options.registrySpec) {
    if (
      options.offline ||
      options.allowModel ||
      [
        "tarballPath",
        "sourceArchivePath",
        "commit",
        "sourceRoot",
        "sourceDir",
        "claim",
      ].some((key) => Object.hasOwn(options, key))
    )
      throw new LocalInputError(
        "conflicting-mode",
        "Hosted checks cannot be combined with local, offline or --allow-model options",
      );
  } else if (!options.offline)
    throw new LocalInputError(
      "usage",
      "Local tarball check requires --offline",
    );
  if (!options.registrySpec && !options.cacheDir)
    throw new LocalInputError(
      "usage",
      "Offline check requires --cache-dir DIR",
    );
  if (options.claim !== undefined) options.claim = exactClaim(options.claim);
  return options;
}
async function writeReports(directory, report) {
  const json = JSON.stringify(report, null, 2) + "\n";
  const html = renderReport(report);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const created = [];
  const handles = [];
  try {
    for (const filename of ["report.json", "report.html"]) {
      const destination = path.join(directory, filename);
      const handle = await open(destination, "wx", 0o600);
      handles.push(handle);
      created.push(destination);
    }
    await handles[0].writeFile(json);
    await handles[1].writeFile(html);
  } catch (error) {
    await Promise.allSettled(handles.map((handle) => handle.close()));
    handles.length = 0;
    await Promise.allSettled(created.map((filename) => unlink(filename)));
    if (typeof error.code === "string" && /^E[A-Z]+$/.test(error.code))
      throw new LocalInputError(
        "output-write-failed",
        "Output requires a writable directory without existing report files",
      );
    throw error;
  } finally {
    await Promise.allSettled(handles.map((handle) => handle.close()));
  }
}

async function configuredModel(allowModel, runtime) {
  if (!allowModel) return undefined;
  if (Object.hasOwn(runtime, "model")) return runtime.model ?? null;
  try {
    const factory = runtime.modelFactory ?? modelClientFromEnv;
    const client = await factory(runtime.env ?? process.env);
    if (client === undefined || client === null) return null;
    if (typeof client.explain !== "function")
      throw new TypeError("Invalid model client");
    return (report) =>
      client.explain(report, { allowLocal: true, signal: runtime.signal });
  } catch {
    process.stderr.write(
      "model-configuration-invalid: Model configuration is invalid; deterministic analysis will continue.\n",
    );
    return async () => ({
      status: "unavailable",
      reason: "configuration-invalid",
    });
  }
}

export async function main(argv = process.argv.slice(2), runtime = {}) {
  const stdout = runtime.stdout ?? process.stdout;
  const stderr = runtime.stderr ?? process.stderr;
  const env = runtime.env ?? process.env;
  const errorStyle = terminalStyle(stderr, env);
  let progress;
  try {
    if (argv[0] === "info") return await infoCommand(argv.slice(1), runtime);
    const { out, offline, allowModel, registrySpec, ...options } = parse(argv);
    progress = createProgress(stderr, { env, subject: registrySpec });
    let report, details;
    if (registrySpec)
      ({ report, details } = await getHostedDetails(registrySpec, {
        serverUrl: env.UNMASK_SERVER_URL,
        fetchImpl: runtime.fetchImpl,
        signal: runtime.signal,
        limits: runtime.hostedLimits,
        optionalDetails: true,
        onStatus: progress.update,
      }));
    else {
      const model = await configuredModel(allowModel, runtime);
      progress.update("local");
      report = await analyzeLocal({ ...options, limits: runtime.limits });
      if (allowModel) progress.update("model");
      if (allowModel) report = await addConfiguredModel(report, model);
      if (!allowModel)
        report = {
          ...report,
          model: { status: "not-sent", reason: "consent-required" },
        };
    }
    const outDir = out === undefined ? undefined : path.resolve(out);
    if (outDir) progress.update("writing");
    if (outDir) await writeReports(outDir, report);
    progress.stop();
    stdout.write(
      renderCheckSummary(report, {
        details,
        outDir,
        style: terminalStyle(stdout, env),
      }),
    );
    return report.policy.exitCode;
  } catch (error) {
    progress?.stop();
    if (error instanceof LocalInputError) {
      stderr.write(renderError(error.code, error.message, errorStyle));
      return 2;
    }
    stderr.write(
      renderError(
        "internal",
        "Internal analysis error; no completed result is claimed.",
        errorStyle,
      ),
    );
    return 1;
  }
}

function isEntrypoint(filename) {
  if (!filename) return false;
  try {
    return (
      realpathSync(fileURLToPath(import.meta.url)) === realpathSync(filename)
    );
  } catch {
    return false;
  }
}

if (isEntrypoint(process.argv[1])) process.exitCode = await main();
