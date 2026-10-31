import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { LocalInputError } from "../core/pipeline.mjs";

const DEFAULT_SERVER_URL = "https://unmask-386156642190.asia-south1.run.app";
const MAX_JSON_BYTES = 16384;
const fail = () =>
  new LocalInputError(
    "doctor-usage",
    "Use doctor [--offline] [--server-url ORIGIN] [--project DIR] [--json].",
  );
function parse(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (
      !["--offline", "--json", "--server-url", "--project"].includes(key) ||
      Object.hasOwn(result, key)
    )
      throw fail();
    if (["--offline", "--json"].includes(key)) result[key] = true;
    else {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw fail();
      result[key] = value;
    }
  }
  if (result["--offline"] && result["--server-url"]) throw fail();
  return result;
}
function serviceOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw fail();
  }
  if (
    value.length > 2048 ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
  )
    throw fail();
  return url.origin;
}
async function serviceJson(
  origin,
  route,
  { fetchImpl = globalThis.fetch, signal } = {},
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  let response;
  try {
    response = await fetchImpl(origin + route, {
      headers: { accept: "application/json" },
      redirect: "manual",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: signal
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal,
    });
    if (
      response.status !== 200 ||
      response.redirected ||
      (response.url && new URL(response.url).origin !== origin) ||
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
        response.headers.get("content-type") ?? "",
      )
    )
      throw new Error();
    const declared = response.headers.get("content-length");
    if (
      declared !== null &&
      (!/^\d+$/.test(declared) || Number(declared) > MAX_JSON_BYTES)
    )
      throw new Error();
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body ?? []) {
      size += chunk.byteLength;
      if (size > MAX_JSON_BYTES) throw new Error();
      chunks.push(chunk);
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks, size),
      ),
    );
  } finally {
    clearTimeout(timer);
    try {
      await response?.body?.cancel();
    } catch {}
  }
}
async function projectConfig(cwd) {
  const filename = path.join(cwd, ".unmask.json");
  let handle;
  try {
    const stat = await lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JSON_BYTES)
      throw new Error();
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const current = await handle.stat();
    if (
      current.dev !== stat.dev ||
      current.ino !== stat.ino ||
      current.size > MAX_JSON_BYTES
    )
      throw new Error();
    const bytes = Buffer.alloc(MAX_JSON_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_JSON_BYTES) throw new Error();
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, bytesRead),
      ),
    );
    if (
      !value ||
      Array.isArray(value) ||
      !["strict", "balanced", "audit"].includes(value.profile)
    )
      throw new Error();
    return {
      id: "config",
      status: "unknown",
      message:
        "Project config has a recognized profile; full guard schema validation requires the guard configuration command.",
      action:
        "Run unmask config show to validate the complete policy before enabling an install guard.",
    };
  } catch (error) {
    if (error?.code === "ENOENT")
      return {
        id: "config",
        status: "warning",
        message: "No project guard configuration found.",
        action: "Use unmask config to explicitly configure a guard policy.",
      };
    return {
      id: "config",
      status: "error",
      message:
        "Project guard configuration is unreadable, oversized, linked or invalid.",
      action:
        "Inspect the project guard config locally; do not store credentials in it.",
    };
  } finally {
    await handle?.close();
  }
}
export async function inspectDoctor({
  cwd = process.cwd(),
  nodeVersion = process.version,
  offline = false,
  serverUrl = DEFAULT_SERVER_URL,
  fetchImpl,
  signal,
} = {}) {
  const origin = serviceOrigin(serverUrl);
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(nodeVersion);
  const supported =
    match &&
    (Number(match[1]) > 24 ||
      (Number(match[1]) === 24 &&
        (Number(match[2]) > 22 ||
          (Number(match[2]) === 22 && Number(match[3]) >= 2))));
  const checks = [
    {
      id: "node",
      status: supported ? "ok" : "error",
      message: supported
        ? "Node meets the 24.22.2 minimum."
        : "Node does not meet the 24.22.2 minimum.",
      action:
        "Use the repository-pinned Node 24.22.2 for reproducible results.",
    },
    await projectConfig(cwd),
  ];
  const result = {
    schemaVersion: "1",
    checks,
    service: { origin },
    limitations: [
      "Diagnostics do not assess package safety or make a model request.",
      "Shell startup files and environment values are not read; active shell guard interception is unverified.",
    ],
  };
  if (offline)
    checks.push({
      id: "service",
      status: "skipped",
      message: "Hosted diagnostics skipped explicitly.",
      action: "Run doctor without --offline to check the service.",
    });
  else {
    try {
      const version = await serviceJson(origin, "/version", {
        fetchImpl,
        signal,
      });
      if (
        typeof version?.version !== "string" ||
        !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(version.version) ||
        version.version.length > 100 ||
        !/^[a-f0-9]{40}$/.test(version.commit) ||
        !/^[a-f0-9]{64}$/.test(version.tarballSha256)
      )
        throw new Error();
      result.service = {
        origin,
        version: version.version,
        commit: version.commit,
        tarballSha256: version.tarballSha256,
      };
      checks.push({
        id: "service",
        status: "ok",
        message: "Hosted version endpoint responded with valid metadata.",
        action:
          "A completed package check is still required to verify the analysis path.",
      });
    } catch {
      checks.push({
        id: "service",
        status: "error",
        message:
          "Hosted version diagnostics unavailable or invalid within bounded limits.",
        action:
          "Check connectivity and the explicit --server-url origin; retry doctor. No package was submitted.",
      });
    }
  }
  checks.push({
    id: "guard",
    status: "unknown",
    message:
      "Active shell guard integration cannot be verified from a child process.",
    action:
      "Use unmask enable to inspect explicit shell setup, then verify it in the invoking shell. Direct unmask install remains explicit.",
  });
  return result;
}
export async function doctorCommand(argv, runtime = {}) {
  const options = parse(argv);
  const result = await inspectDoctor({
    cwd: options["--project"] ?? runtime.cwd,
    nodeVersion: runtime.nodeVersion,
    offline: !!options["--offline"],
    serverUrl: options["--server-url"],
    fetchImpl: runtime.fetchImpl,
    signal: runtime.signal,
  });
  const stdout = runtime.stdout ?? process.stdout;
  stdout.write(
    options["--json"]
      ? JSON.stringify(result, null, 2) + "\n"
      : "UNMASK doctor\n" +
          result.checks
            .map(
              (check) =>
                `${check.id}: ${check.status} — ${check.message}\n  ${check.action}`,
            )
            .join("\n") +
          "\n" +
          result.limitations.join("\n") +
          "\n",
  );
  return result.checks.some((check) => check.status === "error") ? 1 : 0;
}
