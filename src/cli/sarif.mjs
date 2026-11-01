import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { LocalInputError } from "../core/pipeline.mjs";
import { toSarif } from "../core/sarif.mjs";

const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const failure = (code, message) => new LocalInputError(code, message);

export function parseExportOptions(argv, allowed) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (!Object.hasOwn(allowed, key))
      throw failure(
        "unknown-option",
        `Only ${Object.keys(allowed).join(", ")} are supported`,
      );
    if (Object.hasOwn(options, allowed[key]))
      throw failure(
        "duplicate-option",
        "Each option may be supplied only once",
      );
    const value = argv[++index];
    if (!value || value.startsWith("--"))
      throw failure("missing-value", "An option is missing its value");
    options[allowed[key]] = value;
  }
  if (!options.report)
    throw failure(
      "usage",
      "Supply an existing UNMASK report with --report FILE",
    );
  return options;
}

export async function readJsonFile(filename, label) {
  let handle;
  try {
    handle = await open(filename, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_INPUT_BYTES)
      throw failure(
        "input-read-failed",
        `The ${label} must be a regular file of at most ${MAX_INPUT_BYTES} bytes`,
      );
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_INPUT_BYTES)
      throw failure("input-read-failed", `The ${label} exceeds the size limit`);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof LocalInputError) throw error;
    throw failure(
      "input-read-failed",
      `The ${label} could not be read as UTF-8 JSON`,
    );
  } finally {
    await handle?.close();
  }
}

export async function readExportInputs(options) {
  const report = await readJsonFile(options.report, "report");
  const details =
    options.details === undefined
      ? undefined
      : await readJsonFile(options.details, "details document");
  return { report, details };
}

export async function writeExclusive(filename, contents) {
  let handle;
  try {
    handle = await open(filename, "wx", 0o600);
    await handle.writeFile(contents);
  } catch {
    throw failure(
      "output-write-failed",
      "Output requires a writable path that does not already exist",
    );
  } finally {
    await handle?.close();
  }
}

export async function sarifCommand(argv, stdout = process.stdout) {
  const options = parseExportOptions(argv, {
    "--report": "report",
    "--details": "details",
    "--out": "out",
  });
  const { report, details } = await readExportInputs(options);
  const json = JSON.stringify(toSarif(report, details), null, 2) + "\n";
  if (options.out === undefined) stdout.write(json);
  else {
    await writeExclusive(options.out, json);
    stdout.write(`SARIF written to ${path.resolve(options.out)}\n`);
  }
  return 0;
}
