import { LocalInputError } from "../core/pipeline.mjs";
import { getHostedDetails, getHostedDetailsForReport } from "./hosted.mjs";
import { exactPackage, hostedOptions, terminalText, aiLines } from "./info.mjs";

const states = ["byte-identical", "changed", "artifact-only", "not-compared"];
const usage = () =>
  new LocalInputError(
    "usage",
    "Use files name@exact-version [--report ID] [--path TEXT] [--state STATE] [--limit 1..200] [--offset N]",
  );
function parse(args) {
  if (!args[0]) throw usage();
  exactPackage(args[0]);
  const options = {
    spec: args[0],
    path: "",
    state: "all",
    limit: 50,
    offset: 0,
  };
  const seen = new Set();
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      !["--path", "--state", "--limit", "--offset", "--report"].includes(
        flag,
      ) ||
      seen.has(flag) ||
      value === undefined
    )
      throw usage();
    seen.add(flag);
    if (flag === "--report") {
      if (!/^[a-f0-9]{32}$/.test(value)) throw usage();
      options.reportId = value;
    } else if (flag === "--path") {
      if (value.length > 1024) throw usage();
      options.path = value;
    } else if (flag === "--state") {
      if (!["all", ...states].includes(value)) throw usage();
      options.state = value;
    } else {
      if (
        !/^(0|[1-9][0-9]*)$/.test(value) ||
        !Number.isSafeInteger(Number(value))
      )
        throw usage();
      const number = Number(value);
      if (flag === "--limit" && (number < 1 || number > 200)) throw usage();
      options[flag.slice(2)] = number;
    }
  }
  return options;
}

function validateFiles(list) {
  const digest = (value) =>
    typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  if (
    list.items.some(
      (file) =>
        !(file.path === null || typeof file.path === "string") ||
        typeof file.originalPath !== "string" ||
        !states.includes(file.state) ||
        !Number.isSafeInteger(file.size) ||
        file.size < 0 ||
        !digest(file.artifactSha256) ||
        (file.sourceSha256 !== undefined && !digest(file.sourceSha256)),
    )
  )
    throw new LocalInputError(
      "hosted-details-invalid",
      "Hosted file inventory contains invalid paths, states, sizes or hashes.",
    );
}

export function renderFiles({ details, report, reportUrl }, options) {
  const reportId = new URL(reportUrl).pathname
    .split("/")[2]
    .replace(/\.json$/, "");
  const inventory = details.inventory;
  validateFiles(inventory.files);
  const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const files = inventory.files.items
    .filter(
      (file) =>
        (options.state === "all" || file.state === options.state) &&
        (file.path ?? file.originalPath).includes(options.path),
    )
    .sort(
      (a, b) =>
        order(a.path ?? "", b.path ?? "") ||
        order(a.originalPath, b.originalPath),
    );
  const page = files.slice(options.offset, options.offset + options.limit);
  const start = page.length ? options.offset + 1 : 0;
  const end = page.length ? options.offset + page.length : 0;
  const text = terminalText;
  const lines = [
    `UNMASK files ${text(options.spec)}`,
    "Scope: accepted artifact regular files; source-only paths and inert links are outside this list.",
    `Filters: path contains ${text(JSON.stringify(options.path))}; state=${text(options.state)}`,
    `Rows ${start}-${end} of ${files.length} matching returned records; hosted projected total=${inventory.files.total}.`,
    `Inventory complete: ${inventory.complete === true}; ${inventory.files.omitted} records omitted by hosted projection.`,
  ];
  if (inventory.files.omitted)
    lines.push(
      "Filtering and pagination cover returned records only; omitted records may also match.",
    );
  for (const file of page)
    lines.push(
      `${text(file.path ?? file.originalPath)} [${text(file.state)}] ${file.size} bytes`,
      `  artifact-sha256=${file.artifactSha256} source-sha256=${file.sourceSha256 ?? "unavailable"}`,
    );
  if (options.offset + page.length < files.length)
    lines.push(
      `Next offset: ${options.offset + page.length} (use the same filters and limit).`,
    );
  lines.push(...aiLines(report.model));
  lines.push(
    "This is not a safety verdict; byte-identical means only recorded byte correspondence.",
    `Report: ${text(reportUrl)}`,
    `Report ID: ${reportId}`,
    `Reuse this report for paging: --report ${reportId} (with the same exact package spec and filters; no new check).`,
  );
  return lines.join("\n") + "\n";
}

export async function filesCommand(args, runtime = {}) {
  const options = parse(args);
  const result = options.reportId
    ? await getHostedDetailsForReport(
        options.spec,
        options.reportId,
        hostedOptions(runtime),
      )
    : await getHostedDetails(options.spec, hostedOptions(runtime));
  (runtime.stdout ?? process.stdout).write(renderFiles(result, options));
  return 0;
}
