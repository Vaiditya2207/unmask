import { createHash } from "node:crypto";
import { watch as fsWatch } from "node:fs";
import path from "node:path";
import { LocalInputError } from "../core/pipeline.mjs";
import {
  formatPreflight,
  hostedChecker,
  lockIdentities,
  parseCount,
  preflight,
  readLockText,
} from "./preflight.mjs";

const DEFAULT_DEBOUNCE_MS = 750;
const failure = (code, message) => new LocalInputError(code, message);
const digest = (text) => createHash("sha256").update(text).digest("hex");

export function watchLockfile({
  lockfile,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  maxChecks,
  check = true,
  checkPackage,
  signal,
  onEvent = () => {},
  watchFactory = (directory, listener) => fsWatch(directory, listener),
  readText = readLockText,
}) {
  const target = path.basename(lockfile);
  let baselineText = null;
  let lastHash = null;
  let timer = null;
  let running = null;
  let pending = false;
  let runs = 0;

  async function evaluate() {
    let text;
    try {
      text = await readText(lockfile);
    } catch (error) {
      onEvent({ type: "lockfile-unreadable", code: error.code ?? "unknown" });
      return;
    }
    const hash = digest(text);
    if (hash === lastHash) return;
    lastHash = hash;
    try {
      lockIdentities(text);
    } catch (error) {
      onEvent({ type: "lockfile-invalid", code: error.code });
      return;
    }
    if (baselineText === null) {
      baselineText = text;
      onEvent({ type: "baseline", sha256: hash, audited: false });
      return;
    }
    runs++;
    const result = await preflight({
      baselineText,
      lockfileText: text,
      check,
      maxChecks,
      checkPackage,
      signal,
    });
    onEvent({ type: "result", sha256: hash, result });
    if (!result.cancelled) baselineText = text;
  }

  function trigger() {
    if (signal?.aborted) return;
    if (running) {
      pending = true;
      return;
    }
    running = (async () => {
      do {
        pending = false;
        try {
          await evaluate();
        } catch {
          lastHash = null;
          try {
            onEvent({ type: "run-error" });
          } catch {}
        }
      } while (pending && !signal?.aborted);
    })().finally(() => (running = null));
  }

  let watcher;
  try {
    watcher = watchFactory(path.dirname(lockfile), (_type, filename) => {
      if (filename && path.basename(String(filename)) !== target) return;
      clearTimeout(timer);
      timer = setTimeout(trigger, debounceMs);
    });
  } catch {
    throw failure(
      "watch-unavailable",
      "The lockfile directory cannot be watched.",
    );
  }
  trigger();
  return new Promise((resolve) => {
    let stopped = false;
    const stop = async (failed = false) => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      watcher.close();
      const interrupted = running !== null;
      await running;
      resolve({ runs, interrupted, failed });
    };
    watcher.on?.("error", () => {
      onEvent({ type: "watch-error" });
      stop(true);
    });
    if (signal?.aborted) stop();
    else signal?.addEventListener("abort", () => stop(), { once: true });
  });
}

function describe(event) {
  if (event.type === "baseline")
    return `watch baseline recorded (sha256 ${event.sha256.slice(0, 12)}); the baseline itself is not audited (use unmask audit); waiting for changes\n`;
  if (event.type === "lockfile-invalid")
    return `watch ${event.code}: lockfile is not a complete npm lockfile yet; no check run, baseline kept\n`;
  if (event.type === "run-error")
    return "watch run-error: this run failed unexpectedly; no result is claimed and the baseline is unchanged\n";
  if (event.type === "watch-error")
    return "watch-error: the file watcher failed; watching stopped\n";
  if (event.type === "lockfile-unreadable")
    return `watch ${event.code}: lockfile could not be read; no check run\n`;
  return formatPreflight(event.result);
}

function parseArgs(argv) {
  const options = { lockfile: "package-lock.json", check: true, json: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (seen.has(key))
      throw failure(
        "duplicate-option",
        "Each option may be supplied only once",
      );
    seen.add(key);
    if (key === "--json") options.json = true;
    else if (key === "--no-check") options.check = false;
    else if (["--lockfile", "--debounce-ms", "--max-checks"].includes(key)) {
      const value = argv[++index];
      if (!value || value.startsWith("--"))
        throw failure("missing-value", "An option is missing its value");
      options[key.slice(2)] = value;
    } else
      throw failure(
        "unknown-option",
        "Only the documented watch options are supported",
      );
  }
  const debounce = options["debounce-ms"] ?? String(DEFAULT_DEBOUNCE_MS);
  if (!/^\d{2,5}$/.test(debounce) || +debounce < 50 || +debounce > 60000)
    throw failure("invalid-value", "--debounce-ms must be from 50 to 60000.");
  options.debounceMs = Number(debounce);
  if (options["max-checks"] !== undefined)
    options.maxChecks = parseCount(options["max-checks"], "--max-checks");
  return options;
}

export async function watchMain(argv, runtime = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.code}: ${error.message}\n`);
    return 2;
  }
  const controller = new AbortController();
  const signal = runtime.signal
    ? AbortSignal.any([runtime.signal, controller.signal])
    : controller.signal;
  const onSigint = () => controller.abort();
  process.once("SIGINT", onSigint);
  process.stdout.write(
    `watching ${path.resolve(options.lockfile)}; press Ctrl-C to stop\n`,
  );
  try {
    const summary = await watchLockfile({
      ...options,
      checkPackage: runtime.checkPackage ?? hostedChecker(runtime),
      signal,
      watchFactory: runtime.watchFactory,
      onEvent: (event) =>
        process.stdout.write(
          options.json ? JSON.stringify(event) + "\n" : describe(event),
        ),
    });
    process.stdout.write(
      summary.interrupted
        ? `watch stopped after ${summary.runs} run(s); the in-progress run was cancelled and claims no result\n`
        : `watch stopped after ${summary.runs} run(s)\n`,
    );
    return summary.failed ? 2 : 130;
  } catch (error) {
    process.stderr.write(
      error instanceof LocalInputError
        ? `${error.code}: ${error.message}\n`
        : "Internal watch error; no result is claimed.\n",
    );
    return error instanceof LocalInputError ? 2 : 1;
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}
