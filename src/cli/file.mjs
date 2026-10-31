import { isDeepStrictEqual } from "node:util";
import { LocalInputError } from "../core/pipeline.mjs";
import { getHostedDetailsForReport } from "./hosted.mjs";
import { exactPackage, hostedOptions, terminalText } from "./info.mjs";

const MAX_BYTES = 131072;
const fail = (code, message) => new LocalInputError(code, message);
const invalid = () =>
  fail(
    "file-evidence-invalid",
    "Recorded file evidence failed schema, report, file or evidence validation.",
  );
function parse(args) {
  const usage = () =>
    fail(
      "usage",
      "Use file name@exact-version --report REPORT_ID --file-id FILE_ID",
    );
  if (args.length !== 5) throw usage();
  exactPackage(args[0]);
  const options = { spec: args[0] };
  for (let index = 1; index < args.length; index += 2) {
    const key =
      args[index] === "--report"
        ? "reportId"
        : args[index] === "--file-id"
          ? "fileId"
          : null;
    if (!key || Object.hasOwn(options, key)) throw usage();
    options[key] = args[index + 1];
  }
  if (
    !/^[a-f0-9]{32}$/.test(options.reportId ?? "") ||
    !/^f-[A-Za-z0-9_-]{43}$/.test(options.fileId ?? "")
  )
    throw usage();
  return options;
}
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const range = (value, size) =>
  Array.isArray(value) &&
  value.length === 2 &&
  value.every(integer) &&
  value[0] <= value[1] &&
  value[1] <= size;

function validateEvidence(value, report, options) {
  const file = value?.file;
  if (
    value?.schemaVersion !== "1" ||
    value.reportId !== options.reportId ||
    value.scope !== "artifact-source" ||
    value.recordedOnly !== true ||
    file?.fileId !== options.fileId ||
    !Array.isArray(value.evidence) ||
    value.evidence.length > 32 ||
    !["recorded", "partial", "unavailable"].includes(value.evidenceStatus) ||
    !integer(value.evidenceOmitted) ||
    !integer(value.invalidEvidenceOmitted) ||
    !Array.isArray(value.limitations) ||
    value.limitations.length > 16 ||
    value.limitations.some(
      (item) => typeof item !== "string" || item.length > 4096,
    )
  )
    throw invalid();
  if (file.state === "removed") {
    if (
      file.comparisonState !== "source-only" ||
      !report.coverage.sourceOnly.includes(file.path) ||
      file.originalPath !== null ||
      file.artifactSha256 !== null ||
      file.size !== null ||
      (file.sourceSha256 !== null &&
        !report.evidence.some(
          (item) =>
            item.side === "source" &&
            item.path === file.path &&
            item.fileSha256 === file.sourceSha256 &&
            item.blobDigest === report.inputs.sourceArchive?.sha256,
        ))
    )
      throw invalid();
  } else {
    const raw = report.files.find(
      (item) =>
        item.path === file.path && item.originalPath === file.originalPath,
    );
    const states = {
      "byte-identical": "identical",
      changed: "changed",
      "artifact-only": "added",
      "not-compared": "not-compared",
    };
    if (
      !raw ||
      file.comparisonState !== raw.state ||
      file.state !== states[raw.state] ||
      file.size !== raw.size ||
      file.artifactSha256 !== raw.artifactSha256 ||
      file.sourceSha256 !== (raw.sourceSha256 ?? null)
    )
      throw invalid();
  }
  const status =
    value.evidence.length === 0
      ? "unavailable"
      : value.evidenceOmitted || value.invalidEvidenceOmitted
        ? "partial"
        : "recorded";
  if (value.evidenceStatus !== status) throw invalid();
  const known = new Map(report.evidence.map((item) => [item.id, item]));
  const seen = new Set();
  for (const item of value.evidence) {
    const raw = known.get(item?.id);
    if (
      !raw ||
      seen.has(item.id) ||
      item.path !== file.path ||
      ![
        "side",
        "path",
        "originalPath",
        "size",
        "fileSha256",
        "blobDigest",
        "range",
      ].every((key) => isDeepStrictEqual(item[key], raw[key])) ||
      item.fileSha256 !==
        (item.side === "artifact" ? file.artifactSha256 : file.sourceSha256) ||
      (item.side === "artifact" && item.originalPath !== file.originalPath)
    )
      throw invalid();
    seen.add(item.id);
    if (typeof item.excerptTruncated !== "boolean") throw invalid();
    if (item.excerpt === null) {
      if (
        !["not-recorded", "invalid-recorded-range"].includes(
          item.excerptStatus,
        ) ||
        item.excerptRange !== null
      )
        throw invalid();
    } else if (
      item.excerptStatus !== "recorded" ||
      typeof item.excerpt !== "string" ||
      typeof raw.excerpt !== "string" ||
      !raw.excerpt.startsWith(item.excerpt) ||
      Buffer.byteLength(item.excerpt) > 2048 ||
      !range(item.excerptRange, item.size) ||
      !isDeepStrictEqual(item.recordedExcerptRange, raw.excerptRange) ||
      item.excerptRange[0] !== raw.excerptRange?.[0] ||
      item.excerptRange[1] > raw.excerptRange?.[1] ||
      Buffer.byteLength(item.excerpt) !==
        item.excerptRange[1] - item.excerptRange[0]
    )
      throw invalid();
  }
}

async function fetchEvidence(url, runtime) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Math.min(runtime.hostedLimits?.requestTimeoutMs ?? 15000, 15000),
  );
  const signal = runtime.signal
    ? AbortSignal.any([runtime.signal, controller.signal])
    : controller.signal;
  let response;
  try {
    response = await (runtime.fetchImpl ?? globalThis.fetch)(url.href, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "manual",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal,
    });
    if (
      response.status !== 200 ||
      response.redirected ||
      (response.url && new URL(response.url).origin !== url.origin)
    )
      throw fail(
        "file-evidence-unavailable",
        `Stored file evidence is unavailable (HTTP ${response.status}); no new check was submitted.`,
      );
    const declared = response.headers.get("content-length");
    if (
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
        response.headers.get("content-type") ?? "",
      ) ||
      (declared !== null &&
        (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES))
    )
      throw invalid();
    let bytes = 0;
    const chunks = [];
    for await (const chunk of response.body ?? []) {
      bytes += chunk.byteLength;
      if (bytes > MAX_BYTES) throw invalid();
      chunks.push(chunk);
    }
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.concat(chunks, bytes),
        ),
      );
    } catch {
      throw invalid();
    }
  } catch (error) {
    if (error instanceof LocalInputError) throw error;
    throw fail(
      "file-evidence-unavailable",
      signal.aborted
        ? "Stored file evidence timed out or was cancelled; no new check was submitted."
        : "Stored file evidence could not be read; no new check was submitted.",
    );
  } finally {
    clearTimeout(timeout);
    try {
      await response?.body?.cancel();
    } catch {}
  }
}

function render(value, options) {
  const file = value.file,
    text = terminalText;
  const lines = [
    `UNMASK file ${text(options.spec)}`,
    `${text(file.path ?? file.originalPath)} [${text(file.state)}] ${file.size === null ? "size unavailable" : file.size + " bytes"}`,
    `Report ID: ${options.reportId}; File ID: ${options.fileId}`,
    `artifact-sha256=${text(file.artifactSha256 ?? "unavailable")} source-sha256=${text(file.sourceSha256 ?? "unavailable")}`,
    `Previously recorded evidence only: ${text(value.evidenceStatus)}; omitted=${value.evidenceOmitted}; invalid omitted=${value.invalidEvidenceOmitted}.`,
  ];
  for (const item of value.evidence) {
    lines.push(
      `  ${text(item.side)} ${text(item.id)} bytes [${item.range.join(", ")}]`,
      item.excerpt === null
        ? `    Excerpt: ${text(item.excerptStatus)}`
        : `    Excerpt [${item.excerptRange.join(", ")}]: ${text(item.excerpt)}`,
    );
    if (item.excerptTruncated)
      lines.push("    Recorded excerpt truncated by the API limit.");
  }
  for (const limitation of value.limitations)
    lines.push(`  ${text(limitation)}`);
  lines.push(
    "This is not a safety verdict. No file was opened, reconstructed or executed locally.",
  );
  return lines.join("\n") + "\n";
}

export async function fileCommand(args, runtime = {}) {
  const options = parse(args);
  const { report, reportUrl } = await getHostedDetailsForReport(
    options.spec,
    options.reportId,
    hostedOptions(runtime),
  );
  const url = new URL(`/r/${options.reportId}/file.json`, reportUrl);
  url.searchParams.set("fileId", options.fileId);
  const evidence = await fetchEvidence(url, runtime);
  validateEvidence(evidence, report, options);
  (runtime.stdout ?? process.stdout).write(render(evidence, options));
  return 0;
}
