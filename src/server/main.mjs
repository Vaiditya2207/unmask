import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { createApp } from "./app.mjs";
import { createRunner } from "./runner.mjs";
import { modelClientFromEnv } from "../model/config.mjs";
export { modelClientFromEnv };

export async function loadVersionInfo({
  metadataURL = new URL("../version.json", import.meta.url),
  tarballSha256 = process.env.UNMASK_TARBALL_SHA256,
} = {}) {
  const metadata = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  let commit = "unknown";
  try {
    const build = JSON.parse(await readFile(metadataURL, "utf8"));
    if (
      build.version !== metadata.version ||
      typeof build.dirty !== "boolean" ||
      !/^(?:[a-f0-9]{40}|unknown)$/.test(build.commit) ||
      !/^[a-f0-9]{64}$/.test(build.sourceSha256)
    )
      throw new TypeError("Invalid build version metadata");
    if (!build.dirty) commit = build.commit;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (tarballSha256 !== undefined && !/^[a-f0-9]{64}$/.test(tarballSha256))
    throw new TypeError("Invalid tarball digest");
  return {
    version: metadata.version,
    commit,
    tarballSha256: tarballSha256 || "unknown",
  };
}

export async function startServer({
  host = process.env.HOST || "127.0.0.1",
  port = Number(process.env.PORT || 3000),
  tempRoot = path.join(
    os.tmpdir(),
    `unmask-server-${process.getuid?.() ?? "local"}`,
  ),
  runnerOptions = {},
  versionInfo,
  modelClient,
  enrichJob,
} = {}) {
  if (
    typeof host !== "string" ||
    !host ||
    !Number.isSafeInteger(port) ||
    port < 0 ||
    port > 65535
  )
    throw new TypeError("Invalid server address");
  const client =
    modelClient === null
      ? undefined
      : modelClient === undefined
        ? await modelClientFromEnv()
        : modelClient;
  const enrichment =
    enrichJob === null
      ? undefined
      : enrichJob === undefined
        ? (await import("../core/advisory-cache.mjs")).createAdvisoryCache({
            exposeStats: process.env.UNMASK_ADVISORY_CACHE_STATS === "1",
          }).lookup
        : enrichJob;
  if (enrichment !== undefined && typeof enrichment !== "function")
    throw new TypeError("enrichJob must be a function or null");
  const run = await createRunner({
    ...runnerOptions,
    tempRoot,
    modelClient: client,
  });
  const shutdown = new AbortController();
  const pending = new Set();
  const runAnalysis = (spec, { signal } = {}) => {
    const operation = run(spec, {
      signal: signal
        ? AbortSignal.any([signal, shutdown.signal])
        : shutdown.signal,
    });
    pending.add(operation);
    operation.finally(() => pending.delete(operation)).catch(() => {});
    return operation;
  };
  const server = createApp({
    runAnalysis,
    enrichJob:
      enrichment === undefined
        ? undefined
        : (spec, { signal }) =>
            enrichment(spec, {
              signal: AbortSignal.any([signal, shutdown.signal]),
            }),
    advisoryLookup:
      enrichment === undefined
        ? undefined
        : (spec, { signal } = {}) =>
            enrichment(spec, {
              signal: signal
                ? AbortSignal.any([signal, shutdown.signal])
                : shutdown.signal,
            }),
    versionInfo: {
      ...(versionInfo || (await loadVersionInfo())),
      modelConfigDigest:
        client?.configHash || versionInfo?.modelConfigDigest || "disabled",
    },
  });
  let closing;
  function close() {
    closing ||= (async () => {
      shutdown.abort();
      const stopped = new Promise((resolve, reject) => {
        server.close((error) =>
          error && error.code !== "ERR_SERVER_NOT_RUNNING"
            ? reject(error)
            : resolve(),
        );
      });
      server.closeIdleConnections();
      await Promise.all([
        stopped,
        ...Array.from(pending, (operation) => operation.catch(() => {})),
      ]);
    })();
    return closing;
  }
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  } catch (error) {
    await close();
    throw error;
  }
  return { server, close };
}

async function main() {
  const runtime = await startServer();
  const stop = async () => {
    try {
      await runtime.close();
    } catch {
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const address = runtime.server.address();
  console.log(`UNMASK listening on ${address.address}:${address.port}`);
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
)
  main().catch(() => {
    console.error("UNMASK server could not start");
    process.exitCode = 1;
  });
