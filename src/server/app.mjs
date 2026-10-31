import { createServer } from "node:http";
import { buildPackageDetails } from "../core/package-details.mjs";
import { attachVulnerabilityCheck } from "./enrichment.mjs";
import { withAdvisoryResult } from "./advisory-result.mjs";
import { createQueue, resolveLimits, systemClock } from "./queue.mjs";
import { createReportStore } from "./store.mjs";
import { renderReport } from "../viewer/render.mjs";
import {
  renderHome,
  renderStatus,
  renderError,
  renderCompleted,
} from "../viewer/shell.mjs";

export function parseNameAtExactVersion(value) {
  if (typeof value !== "string" || value.length > 300 || value !== value.trim())
    return null;
  const match =
    /^(?<name>(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)@(?<version>(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/.exec(
      value,
    );
  if (
    !match ||
    match.groups.name.length > 214 ||
    ["node_modules", "favicon.ico"].includes(match.groups.name)
  )
    return null;
  const prerelease = match.groups.version
    .split("+")[0]
    .split("-")
    .slice(1)
    .join("-");
  if (prerelease.split(".").some((part) => /^0\d+$/.test(part))) return null;
  if (
    match.groups.version
      .split(/[.+-]/)
      .slice(0, 3)
      .some((part) => !Number.isSafeInteger(Number(part)))
  )
    return null;
  return `${match.groups.name}@${match.groups.version}`;
}

function bodyError(status) {
  return Object.assign(new Error("Request body rejected"), { status });
}
function readBody(req, limits) {
  return new Promise((resolve, reject) => {
    let size = 0,
      chunks = [],
      done = false;
    const timer = setTimeout(
      () => finish(bodyError(408)),
      limits.bodyTimeoutMs,
    );
    timer.unref();
    function finish(error) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.removeListener("data", data);
      req.removeListener("end", end);
      req.removeListener("error", fail);
      req.removeListener("aborted", fail);
      if (error) {
        chunks = [];
        req.on("error", () => {});
        req.resume();
        reject(error);
      } else resolve(Buffer.concat(chunks, size).toString("utf8"));
    }
    const data = (chunk) => {
      size += chunk.length;
      if (size > limits.maxBodyBytes) finish(bodyError(413));
      else chunks.push(chunk);
    };
    const end = () => finish();
    const fail = () => finish(bodyError(400));
    if (Number(req.headers["content-length"]) > limits.maxBodyBytes) {
      finish(bodyError(413));
      return;
    }
    req.on("data", data);
    req.on("end", end);
    req.on("error", fail);
    req.on("aborted", fail);
  });
}

export function createCacheKeyPrefix(versionInfo, limits) {
  return JSON.stringify([
    versionInfo.version,
    versionInfo.commit,
    versionInfo.tarballSha256,
    versionInfo.analyzerVersion,
    versionInfo.policyVersion,
    versionInfo.limitsVersion,
    versionInfo.modelConfigDigest,
    limits,
  ]);
}

export function createApp({
  runAnalysis,
  enrichJob,
  versionInfo,
  limits: overrides,
  clock = systemClock,
} = {}) {
  if (typeof runAnalysis !== "function")
    throw new TypeError("runAnalysis is required");
  if (
    !versionInfo ||
    ["version", "commit", "tarballSha256"].some(
      (key) => typeof versionInfo[key] !== "string",
    )
  )
    throw new TypeError(
      "versionInfo requires version, commit and tarballSha256 strings",
    );
  if (enrichJob !== undefined && typeof enrichJob !== "function")
    throw new TypeError("enrichJob must be a function");
  const limits = resolveLimits(overrides);
  const version = Object.fromEntries(
    ["version", "commit", "tarballSha256"].map((key) => [
      key,
      versionInfo[key],
    ]),
  );
  const store = createReportStore({
    maxEntries: limits.maxReports,
    maxBytes: limits.maxReportBytes,
    ttlMs: limits.reportTtlMs,
    clock,
  });
  const keyPrefix = createCacheKeyPrefix(versionInfo, limits);
  const queue = createQueue({
    runAnalysis,
    enrichJob,
    store,
    limits,
    clock,
    keyPrefix,
  });
  const server = createServer(
    { maxHeaderSize: 8192, headersTimeout: 10000, requestTimeout: 15000 },
    (req, res) => {
      function send(
        status,
        body,
        type = "text/html; charset=utf-8",
        headers = {},
      ) {
        if (res.destroyed || res.writableEnded) return;
        res.writeHead(status, {
          "content-type": type,
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "cache-control": "no-store",
          "x-frame-options": "DENY",
          ...headers,
        });
        res.end(body);
      }
      function json(status, value, headers) {
        send(
          status,
          JSON.stringify(value),
          "application/json; charset=utf-8",
          headers,
        );
      }
      function error(status, title, message, headers) {
        send(status, renderError({ title, message }), undefined, headers);
      }
      async function handle() {
        const path = req.url;
        if (path === "/check") {
          if (req.method !== "POST")
            return error(
              405,
              "Use the release form",
              "A check starts only when you submit the form.",
              { allow: "POST" },
            );
          if (
            req.headers.origin &&
            req.headers.origin !== `http://${req.headers.host}` &&
            req.headers.origin !== `https://${req.headers.host}`
          )
            return error(
              403,
              "Request origin rejected",
              "Open the release form on this site to start a check.",
            );
          if (req.headers["sec-fetch-site"] === "cross-site")
            return error(
              403,
              "Request origin rejected",
              "Open the release form on this site to start a check.",
            );
          if (
            !/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/i.test(
              req.headers["content-type"] || "",
            )
          )
            return error(
              415,
              "Use the release form",
              "Submit a package name and exact version with the release form.",
            );
          let body;
          try {
            body = await readBody(req, limits);
          } catch (e) {
            return error(
              e.status || 400,
              e.status === 413
                ? "Request too large"
                : "Request body unavailable",
              "Submit only a package name and exact version.",
            );
          }
          const params = new URLSearchParams(body);
          const value = params.get("package") || "";
          const name = params.size === 1 && parseNameAtExactVersion(value);
          if (!name)
            return send(
              400,
              renderHome({
                value: value.slice(0, 300),
                error:
                  "Enter an npm package name and exact version. Tags, ranges and URLs are not accepted.",
              }),
            );
          const result = queue.submit(name);
          if (!result.job)
            return send(
              429,
              renderHome({
                value,
                error:
                  "The shared global limit is six new checks per ten minutes, with one active check and one waiting slot.",
                retryAfter: result.retryAfter,
              }),
              undefined,
              { "retry-after": String(result.retryAfter) },
            );
          return send(303, "", "text/plain; charset=utf-8", {
            location: `/r/${result.job.id}`,
            "x-unmask-reused": String(result.reused),
          });
        }
        if (req.method !== "GET")
          return error(
            405,
            "Method unavailable",
            "Use the release form to start a check.",
            { allow: "GET" },
          );
        if (path === "/") return send(200, renderHome());
        if (path === "/healthz") return json(200, { status: "ok" });
        if (path === "/version") return json(200, version);
        const match = /^\/r\/([a-f0-9]{32})(\.details\.json|\.json)?$/.exec(
          path,
        );
        if (!match)
          return error(
            404,
            "Page unavailable",
            "Return to the release form to check a package.",
          );
        const job = queue.get(match[1]);
        if (!job)
          return error(
            404,
            "Report unavailable",
            "This report may have expired, been evicted or been lost in a restart. Submit the package again to request a new check.",
          );
        const pending = ["queued", "running"].includes(job.status);
        if (match[2]) {
          if (job.report)
            return json(
              200,
              match[2] === ".details.json"
                ? attachVulnerabilityCheck(
                    buildPackageDetails(job.report),
                    job.vulnerabilityCheck,
                  )
                : job.report,
              {
                "content-disposition":
                  match[2] === ".details.json"
                    ? 'attachment; filename="unmask-package-details.json"'
                    : 'attachment; filename="unmask-report.json"',
              },
            );
          const { key, ...publicJob } = job;
          return json(
            pending ? 202 : 200,
            publicJob,
            pending ? { "retry-after": "3" } : {},
          );
        }
        if (job.report)
          return send(200, renderCompleted(renderReport(job.report), job));
        return send(
          200,
          withAdvisoryResult(renderStatus(job), job),
          undefined,
          pending ? { "retry-after": "3" } : {},
        );
      }
      handle().catch(() =>
        error(
          500,
          "Request could not finish",
          "Return to the release form to try again.",
        ),
      );
    },
  );
  server.on("close", () => queue.close());
  return server;
}
