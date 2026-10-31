import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { createServer, createConnection } from "node:net";
import { constants } from "node:fs";
import {
  mkdir,
  readdir,
  lstat,
  chmod,
  realpath,
  open,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateReport } from "../core/report.mjs";
import { parsePackageSpec } from "../core/acquire.mjs";

const JOB_NAME = /^job-[a-f0-9]{32}$/;
const fail = (code) => new Error(code);
function boundedReport(report, cap) {
  validateReport(report);
  if (Buffer.byteLength(JSON.stringify(report)) > cap)
    throw fail("analysis-result-cap");
  return report;
}

function leasePath(root, name) {
  const rootHash = createHash("sha256").update(root).digest("hex").slice(0, 16);
  return `/tmp/um-${process.getuid()}-${rootHash}-${name.slice(4)}.sock`;
}
async function jobLease(root, name) {
  const filename = leasePath(root, name);
  const server = createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(filename, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const close = () =>
    new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  try {
    await chmod(filename, 0o600);
    // Node 24 exposes the listening descriptor here; the worker must inherit it.
    const fd = server._handle?.fd;
    if (!Number.isInteger(fd) || fd < 0)
      throw fail("analysis-lease-unavailable");
    server.unref();
    return { close, fd };
  } catch (error) {
    await close();
    throw error;
  }
}
async function abandonedLease(filename) {
  try {
    const stat = await lstat(filename);
    if (!stat.isSocket() || stat.uid !== process.getuid()) return false;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  return new Promise((resolve) => {
    const socket = createConnection(filename);
    let done = false;
    const timer = setTimeout(() => finish(false), 500);
    function finish(stale) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(stale);
    }
    socket.once("connect", () => finish(false));
    socket.on("error", (error) => finish(error.code === "ECONNREFUSED"));
  });
}

async function readResult(workDir, cap) {
  const handle = await open(
    path.join(workDir, "report.json"),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw fail("analysis-worker-invalid-result");
    if (stat.size > cap) throw fail("analysis-result-cap");
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!bytesRead) throw fail("analysis-worker-invalid-result");
      offset += bytesRead;
    }
    return boundedReport(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      cap,
    );
  } finally {
    await handle.close();
  }
}

function runWorker(workerURL, request, signal, deadline, leaseFd) {
  return new Promise((resolve, reject) => {
    let stopped, timer, child;
    const stop = (reason) => {
      stopped ||= reason;
      child?.kill("SIGKILL");
    };
    const abort = () => stop("analysis-aborted");
    if (signal?.aborted) return reject(fail("analysis-aborted"));
    try {
      child = spawn(process.execPath, ["--max-old-space-size=512", workerURL], {
        cwd: request.workDir,
        env: { LANG: "C.UTF-8", TMPDIR: request.workDir },
        stdio: ["pipe", "ignore", "ignore", leaseFd],
      });
    } catch {
      return reject(fail("analysis-worker-failed"));
    }
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => stop("analysis-timeout"), deadline);
    child.on("error", () => {
      stopped ||= "analysis-worker-failed";
    });
    child.stdin.on("error", () => stop("analysis-worker-failed"));
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (stopped || code !== 0)
        reject(fail(stopped || "analysis-worker-failed"));
      else resolve();
    });
    child.stdin.end(JSON.stringify(request));
    if (signal?.aborted) abort();
  });
}

async function explainReport(report, client, signal, cap) {
  const controller = new AbortController();
  let timer, abort;
  const cancellation = new Promise((resolve, reject) => {
    abort = () => {
      controller.abort();
      reject(fail("analysis-aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => {
      controller.abort();
      resolve({ status: "timeout" });
    }, 135000);
  });
  try {
    if (signal?.aborted) throw fail("analysis-aborted");
    const operation = Promise.resolve().then(() =>
      client.explain(structuredClone(report), { signal: controller.signal }),
    );
    let model;
    try {
      model = await Promise.race([operation, cancellation]);
      if (signal?.aborted) throw fail("analysis-aborted");
      return boundedReport({ ...report, model }, cap);
    } catch {
      if (signal?.aborted) throw fail("analysis-aborted");
      for (const model of [
        { status: "unavailable", reason: "model-failed" },
        { status: "unavailable" },
        { status: "failed" },
      ]) {
        const fallback = { ...report, model };
        if (Buffer.byteLength(JSON.stringify(fallback)) <= cap)
          return boundedReport(fallback, cap);
      }
      throw fail("analysis-result-cap");
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export async function createRunner({
  tempRoot,
  workerURL = new URL("./worker.mjs", import.meta.url),
  deterministicMs = 120000,
  maxResultBytes = 67108864,
  modelClient,
} = {}) {
  if (typeof tempRoot !== "string" || !path.isAbsolute(tempRoot))
    throw new TypeError("An absolute private tempRoot is required");
  if (
    !Number.isSafeInteger(deterministicMs) ||
    deterministicMs < 1 ||
    deterministicMs > 120000 ||
    !Number.isSafeInteger(maxResultBytes) ||
    maxResultBytes < 1 ||
    maxResultBytes > 67108864
  )
    throw new TypeError("Invalid runner limits");
  if (modelClient !== undefined && typeof modelClient.explain !== "function")
    throw new TypeError("Invalid model client");
  const filename =
    workerURL instanceof URL ? fileURLToPath(workerURL) : workerURL;
  if (typeof filename !== "string" || !path.isAbsolute(filename))
    throw new TypeError("Worker must be an absolute trusted module path");
  await mkdir(tempRoot, { recursive: true, mode: 0o700 });
  const rootStat = await lstat(tempRoot);
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    rootStat.uid !== process.getuid?.()
  )
    throw new TypeError("tempRoot must be a private directory");
  await chmod(tempRoot, 0o700);
  const privateRoot = await realpath(tempRoot);
  for (const entry of await readdir(privateRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !JOB_NAME.test(entry.name)) continue;
    const owner = leasePath(privateRoot, entry.name);
    if (await abandonedLease(owner)) {
      await rm(path.join(privateRoot, entry.name), {
        recursive: true,
        force: true,
      });
      await rm(owner, { force: true });
    }
  }
  let active = false;
  return async function runAnalysis(spec, { signal } = {}) {
    parsePackageSpec(spec);
    if (signal !== undefined && !(signal instanceof AbortSignal))
      throw new TypeError("Invalid analysis signal");
    if (active) throw fail("analysis-busy");
    active = true;
    let workDir, lease;
    try {
      if (signal?.aborted) throw fail("analysis-aborted");
      const owned = path.join(
        privateRoot,
        `job-${randomBytes(16).toString("hex")}`,
      );
      lease = await jobLease(privateRoot, path.basename(owned));
      await mkdir(owned, { mode: 0o700 });
      workDir = owned;
      if (signal?.aborted) throw fail("analysis-aborted");
      await runWorker(
        filename,
        { spec, workDir, maxResultBytes },
        signal,
        deterministicMs,
        lease.fd,
      );
      if (signal?.aborted) throw fail("analysis-aborted");
      const report = await readResult(workDir, maxResultBytes);
      if (signal?.aborted) throw fail("analysis-aborted");
      return modelClient
        ? await explainReport(report, modelClient, signal, maxResultBytes)
        : report;
    } finally {
      try {
        if (workDir) await rm(workDir, { recursive: true, force: true });
      } finally {
        try {
          if (lease) await lease.close();
        } finally {
          active = false;
        }
      }
    }
  };
}
