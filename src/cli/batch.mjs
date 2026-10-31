import { parsePackageSpec } from "../core/acquire.mjs";
import { LocalInputError } from "../core/pipeline.mjs";
import { checkHosted } from "./hosted.mjs";

const failure = (code, message) => new LocalInputError(code, message);
const MAX_ITEMS = 25;
const MAX_INPUT_BYTES = 16384;
const terminalValue = (value) =>
  JSON.stringify(value).replace(
    /[\u007f-\u009f\u2028\u2029]/gu,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

async function readInput(stdin, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  const lifetime = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  let onAbort;
  try {
    const aborted = new Promise((_resolve, reject) => {
      onAbort = () =>
        reject(
          failure(
            "batch-input-cancelled",
            "Batch stdin timed out or was cancelled before EOF.",
          ),
        );
      lifetime.addEventListener("abort", onAbort, { once: true });
      if (lifetime.aborted) onAbort();
    });
    const reading = (async () => {
      const chunks = [];
      let size = 0;
      for await (const chunk of stdin) {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        if (!(bytes instanceof Uint8Array))
          throw failure("batch-input", "Batch stdin must contain UTF-8 text.");
        size += bytes.byteLength;
        if (size > MAX_INPUT_BYTES)
          throw failure("batch-input-limit", "Batch stdin exceeds 16 KiB.");
        chunks.push(bytes);
      }
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.concat(chunks, size),
        );
      } catch {
        throw failure(
          "batch-input",
          "Batch stdin must contain valid UTF-8 text.",
        );
      }
    })();
    return await Promise.race([reading, aborted]);
  } catch (error) {
    if (error instanceof LocalInputError) throw error;
    throw failure("batch-input", "Batch stdin could not be read.");
  } finally {
    clearTimeout(timer);
    lifetime.removeEventListener("abort", onAbort);
    if (lifetime.aborted) stdin.destroy?.();
  }
}

async function inputs(argv, runtime) {
  const specs = [];
  const seen = new Set();
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      if (!["--stdin", "--json"].includes(arg) || seen.has(arg))
        throw failure(
          "usage",
          "Use batch exact-spec... [--stdin] [--json], with each option once.",
        );
      seen.add(arg);
    } else specs.push(arg);
  }
  if (specs.length > MAX_ITEMS || specs.some((spec) => spec.length > 512))
    throw failure(
      "batch-input-limit",
      "Batch accepts at most 25 inputs of at most 512 characters each.",
    );
  if (seen.has("--stdin")) {
    const text = await readInput(
      runtime.stdin ?? process.stdin,
      runtime.signal,
    );
    specs.push(...text.split(/\s+/u).filter(Boolean));
  }
  if (!specs.length)
    throw failure(
      "usage",
      "Batch requires explicit exact specs from args or --stdin.",
    );
  if (specs.length > MAX_ITEMS || specs.some((spec) => spec.length > 512))
    throw failure(
      "batch-input-limit",
      "Batch accepts at most 25 inputs of at most 512 characters each.",
    );
  return { specs, json: seen.has("--json") };
}

export async function runBatch(argv, runtime = {}) {
  const { specs, json } = await inputs(argv, runtime);
  const unique = new Map();
  for (const [index, spec] of specs.entries()) {
    if (!unique.has(spec)) unique.set(spec, { spec, inputIndexes: [] });
    unique.get(spec).inputIndexes.push(index);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 600000);
  const lifetime = runtime.signal
    ? AbortSignal.any([runtime.signal, controller.signal])
    : controller.signal;
  const items = [];
  let paused = false;
  try {
    for (const item of unique.values()) {
      const result = { ...item, occurrences: item.inputIndexes.length };
      try {
        parsePackageSpec(item.spec);
      } catch {
        items.push({
          ...result,
          status: "error",
          error: {
            code: "invalid-package-spec",
            message:
              "Use an exact public npm package name@version; ranges, tags and URLs are unsupported.",
          },
        });
        continue;
      }
      if (lifetime.aborted || paused) {
        items.push({
          ...result,
          status: "not-checked",
          error: {
            code: lifetime.aborted
              ? "batch-cancelled"
              : "batch-submission-paused",
            message: "No hosted request was submitted for this item.",
          },
        });
        continue;
      }
      try {
        const report = await checkHosted(item.spec, {
          serverUrl: (runtime.env ?? process.env).UNMASK_SERVER_URL,
          fetchImpl: runtime.fetchImpl,
          signal: lifetime,
          limits: runtime.hostedLimits,
        });
        items.push({
          ...result,
          status: "completed",
          policyExitCode: report.policy.exitCode,
          findingCount: report.policy.findings.length,
          model: {
            status: String(report.model?.status ?? "unavailable").slice(0, 80),
          },
        });
      } catch (error) {
        const known = error instanceof LocalInputError;
        items.push({
          ...result,
          status: "error",
          error: {
            code: known ? error.code : "batch-check-failed",
            message: known
              ? error.message
              : "Check failed; no completed result is claimed.",
          },
        });
        if (
          ["hosted-submit-failed", "hosted-report-failed"].includes(error?.code)
        )
          paused = true;
      }
    }
  } finally {
    clearTimeout(timer);
  }
  const result = {
    schemaVersion: "1",
    requestedCount: specs.length,
    uniqueCount: items.length,
    duplicateCount: specs.length - items.length,
    completedCount: items.filter((item) => item.status === "completed").length,
    errorCount: items.filter((item) => item.status === "error").length,
    notCheckedCount: items.filter((item) => item.status === "not-checked")
      .length,
    items,
  };
  const exitCode =
    result.errorCount || result.notCheckedCount
      ? 2
      : items.some((item) => item.policyExitCode === 3)
        ? 3
        : items.some((item) => item.policyExitCode === 2)
          ? 2
          : 0;
  const stdout = runtime.stdout ?? process.stdout;
  if (json) stdout.write(JSON.stringify({ ...result, exitCode }) + "\n");
  else {
    for (const item of items)
      stdout.write(
        `${terminalValue(item.spec)} x${item.occurrences}: ${item.status}${item.status === "completed" ? `; policy exit ${item.policyExitCode}; findings ${item.findingCount}; AI status ${terminalValue(item.model.status)}` : `; ${item.error.code}`}\n`,
      );
    stdout.write(
      `Batch: ${result.completedCount} completed, ${result.errorCount} errors, ${result.notCheckedCount} not checked; ${result.duplicateCount} duplicate inputs coalesced.\nNo findings do not establish safety.\n`,
    );
  }
  return exitCode;
}
