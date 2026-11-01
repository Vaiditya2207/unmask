import { setTimeout as delay } from "node:timers/promises";
import { parsePackageSpec } from "../core/acquire.mjs";
import { LocalInputError } from "../core/pipeline.mjs";
import { validateReport } from "../core/report.mjs";

const DEFAULT_SERVER_URL = "https://unmask-386156642190.asia-south1.run.app";
const defaults = Object.freeze({
  totalTimeoutMs: 600000,
  requestTimeoutMs: 15000,
  maxBodyBytes: 64 * 1024 * 1024,
  pollMs: 3000,
});
const failure = (code, message) => new LocalInputError(code, message);
function serverOrigin(value) {
  if (!value)
    throw failure(
      "hosted-configuration",
      "UNMASK_SERVER_URL must be a nonempty service origin.",
    );
  let url;
  try {
    url = new URL(value);
  } catch {
    throw failure(
      "hosted-configuration",
      "UNMASK_SERVER_URL must be a service origin.",
    );
  }
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
  )
    throw failure(
      "hosted-configuration",
      "Use an HTTPS service origin, or loopback HTTP for local testing, without credentials, path, query or fragment.",
    );
  return url.origin;
}
async function discard(response) {
  try {
    await response.body?.cancel();
  } catch {}
}
async function readJson(response, maxBytes) {
  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
      response.headers.get("content-type") ?? "",
    )
  )
    throw failure("hosted-response", "The hosted service did not return JSON.");
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > maxBytes)
  )
    throw failure(
      "hosted-response",
      "The hosted response exceeds the body limit.",
    );
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > maxBytes)
      throw failure(
        "hosted-response",
        "The hosted response exceeds the body limit.",
      );
    chunks.push(chunk);
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks, size),
      ),
    );
  } catch {
    throw failure("hosted-response", "The hosted response is not valid JSON.");
  }
}
async function runHosted(
  spec,
  {
    serverUrl = DEFAULT_SERVER_URL,
    fetchImpl = globalThis.fetch,
    signal,
    limits: overrides = {},
  } = {},
  withDetails = false,
) {
  const claim = parsePackageSpec(spec);
  const origin = serverOrigin(serverUrl);
  const limits = { ...defaults, ...overrides };
  if (
    Object.keys(limits).some(
      (key) =>
        !Object.hasOwn(defaults, key) ||
        !Number.isSafeInteger(limits[key]) ||
        limits[key] < 1 ||
        limits[key] > defaults[key],
    )
  )
    throw failure(
      "hosted-configuration",
      "Hosted transport limits are invalid.",
    );
  const controller = new AbortController();
  const totalTimer = setTimeout(
    () => controller.abort(),
    limits.totalTimeoutMs,
  );
  const lifetime = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  async function request(url, options, consume) {
    const attempt = new AbortController();
    const timer = setTimeout(() => attempt.abort(), limits.requestTimeoutMs);
    let response;
    try {
      response = await fetchImpl(url, {
        ...options,
        redirect: "manual",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.any([lifetime, attempt.signal]),
      });
      if (
        response.redirected ||
        (response.url && new URL(response.url).origin !== origin)
      )
        throw failure(
          "hosted-response",
          "The hosted service returned an unexpected redirect.",
        );
      return await consume(response);
    } finally {
      clearTimeout(timer);
      if (response) await discard(response);
    }
  }
  try {
    const reportUrl = await request(
      origin + "/check",
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: new URLSearchParams({ package: spec }),
      },
      async (response) => {
        if (response.status !== 303)
          throw failure(
            "hosted-submit-failed",
            `The hosted service did not accept the check (HTTP ${response.status}). No local fallback was attempted.`,
          );
        const location = response.headers.get("location");
        let url;
        try {
          url = new URL(location, origin);
        } catch {}
        if (
          !location ||
          location.length > 2048 ||
          !url ||
          url.origin !== origin ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          !/^\/r\/[a-f0-9]{32}$/.test(url.pathname)
        )
          throw failure(
            "hosted-response",
            "The hosted service returned an invalid report location.",
          );
        return url.href + ".json";
      },
    );
    const id = new URL(reportUrl).pathname.slice(3, -5);
    for (;;) {
      const result = await request(
        reportUrl,
        { headers: { accept: "application/json" } },
        async (response) => {
          if (![200, 202].includes(response.status))
            throw failure(
              "hosted-report-failed",
              `The hosted report is unavailable (HTTP ${response.status}). No local fallback was attempted.`,
            );
          const value = await readJson(response, limits.maxBodyBytes);
          if (response.status === 202) {
            if (
              value?.id !== id ||
              !["queued", "running"].includes(value.status)
            )
              throw failure(
                "hosted-response",
                "The hosted service returned an invalid pending report.",
              );
            return null;
          }
          try {
            validateReport(value);
            if (
              value.inputs.claim?.name !== claim.name ||
              value.inputs.claim?.version !== claim.version ||
              ![0, 2, 3].includes(value.policy.exitCode)
            )
              throw new TypeError();
          } catch {
            throw failure(
              "hosted-report-invalid",
              "The hosted report failed schema, identity or deterministic policy validation.",
            );
          }
          return value;
        },
      );
      if (result) {
        if (!withDetails) return result;
        const detailsUrl = reportUrl.replace(/\.json$/, ".details.json");
        const details = await request(
          detailsUrl,
          { headers: { accept: "application/json" } },
          async (response) => {
            if (response.status !== 200)
              throw failure(
                "hosted-details-failed",
                `Hosted package details are unavailable (HTTP ${response.status}).`,
              );
            const value = await readJson(
              response,
              Math.min(limits.maxBodyBytes, 4194304),
            );
            validateDetails(value, result);
            return value;
          },
        );
        return { report: result, details, reportUrl, detailsUrl };
      }
      await delay(limits.pollMs, undefined, { signal: lifetime });
    }
  } catch (error) {
    if (error instanceof LocalInputError) throw error;
    if (
      lifetime.aborted ||
      error?.name === "AbortError" ||
      error?.name === "TimeoutError"
    )
      throw failure(
        "hosted-timeout",
        "The hosted check timed out or was cancelled. No local fallback was attempted.",
      );
    throw failure(
      "hosted-unavailable",
      "The hosted service could not be reached or its response could not be read. No local fallback was attempted.",
    );
  } finally {
    clearTimeout(totalTimer);
  }
}

function validateDetails(value, report) {
  const list = (entry) =>
    entry &&
    Array.isArray(entry.items) &&
    entry.items.length <= 20000 &&
    entry.items.every(
      (item) =>
        item !== null && typeof item === "object" && !Array.isArray(item),
    ) &&
    ["total", "returned", "omitted"].every(
      (key) => Number.isSafeInteger(entry[key]) && entry[key] >= 0,
    ) &&
    entry.returned === entry.items.length &&
    entry.total === entry.returned + entry.omitted;
  const identity = value?.identity?.items?.[0];
  if (
    value?.detailsVersion !== "1" ||
    value?.reportSchemaVersion !== report.schemaVersion ||
    !list(value.identity) ||
    identity?.requested?.name !== report.inputs.claim.name ||
    identity?.requested?.version !== report.inputs.claim.version ||
    identity?.artifactDigests?.sha256 !== report.inputs.artifact.sha256 ||
    !list(value.declarations?.fields) ||
    !list(value.scripts?.entries) ||
    !Array.isArray(value.dependencies?.categories) ||
    value.dependencies.categories.length > 6 ||
    value.dependencies.categories.some(
      (category) => !list(category?.entries),
    ) ||
    !list(value.provenance?.facts) ||
    !list(value.inventory?.files)
  )
    throw failure(
      "hosted-details-invalid",
      "Hosted details failed version, identity or inventory validation.",
    );
  const check = value.vulnerabilityCheck;
  if (
    check &&
    (check.source !== "OSV" ||
      ![
        "found",
        "none-reported",
        "incomplete",
        "unavailable",
        "not-assessed",
      ].includes(check.status) ||
      typeof check.complete !== "boolean" ||
      !Array.isArray(check.advisories) ||
      check.complete !== ["found", "none-reported"].includes(check.status) ||
      (check.status === "found" && check.advisories.length === 0) ||
      (check.status === "none-reported" && check.advisories.length !== 0) ||
      (check.package &&
        (check.package.ecosystem !== "npm" ||
          check.package.name !== report.inputs.claim.name ||
          check.package.version !== report.inputs.claim.version)) ||
      (check.complete &&
        (!check.package || !["found", "none-reported"].includes(check.status))))
  )
    throw failure(
      "hosted-details-invalid",
      "Hosted OSV details failed status or identity validation.",
    );
}

export async function checkHosted(spec, options) {
  return runHosted(spec, options);
}

export async function getHostedDetails(spec, options) {
  return runHosted(spec, options, true);
}
