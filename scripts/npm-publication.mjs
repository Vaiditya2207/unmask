import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { verifyBuild } from "./build.mjs";
import { verifyAsset } from "./release-policy.mjs";

const registry = "https://registry.npmjs.org/";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const npmFailureCodes = new Set([
  "EOTP",
  "E401",
  "E403",
  "ENEEDAUTH",
  "EPUBLISHCONFLICT",
  "EPRIVATE",
  "E400",
  "E404",
  "E409",
  "E429",
  "EUSAGE",
  "ETIMEDOUT",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EINTEGRITY",
]);
function npmFailureCode(stderr) {
  if (typeof stderr !== "string" && !Buffer.isBuffer(stderr)) return null;
  const text = Buffer.isBuffer(stderr)
    ? stderr.subarray(0, 65536).toString("utf8")
    : stderr.slice(0, 65536);
  for (const match of text.matchAll(
    /^npm (?:ERR!|error) code (E[A-Z0-9_]+)\r?$/gm,
  ))
    if (npmFailureCodes.has(match[1])) return match[1];
  return null;
}

function candidate(root, prepared, archive) {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json")));
  const config = JSON.parse(
    readFileSync(path.join(root, "release.config.json")),
  );
  if (config.enabled !== true || config.npmPublishEnabled !== true)
    throw new Error("Npm publication gate is disabled");
  if (
    pkg.private !== false ||
    pkg.name !== config.approvedPackageName ||
    pkg.publishConfig?.registry !== registry ||
    pkg.publishConfig?.access !== "public" ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(pkg.version) ||
    pkg.version === "0.0.0"
  )
    throw new Error("Public npm candidate identity is not configured");
  if (
    prepared.version !== pkg.version ||
    !/^[a-f0-9]{40}$/.test(prepared.sha || "") ||
    path.basename(archive) !== prepared.artifact.filename
  )
    throw new Error("Prepared npm candidate differs");
  const build = verifyBuild(root, {
    expectedSha: prepared.sha,
    requireClean: true,
  });
  if (JSON.stringify(build) !== JSON.stringify(prepared.artifact.build))
    throw new Error("Prepared npm build identity changed");
  const bytes = readFileSync(archive);
  verifyAsset(bytes, prepared.artifact.digest);
  verifyAsset(
    readFileSync(path.join(root, "package-lock.json")),
    prepared.artifact.lockDigest,
  );
  return {
    pkg,
    size: bytes.length,
    digest: prepared.artifact.digest,
    tarballUrl: `${registry}${pkg.name}/-/${pkg.name.split("/").at(-1)}-${pkg.version}.tgz`,
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    url: `${registry}${encodeURIComponent(pkg.name)}/${pkg.version}`,
  };
}
async function registryBytes(url, fetchImpl, limit, absent = false) {
  const response = await fetchImpl(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(10000),
    headers: { accept: "application/json, application/octet-stream" },
  });
  if (absent && response.status === 404) {
    response.body?.cancel().catch(() => {});
    return null;
  }
  if (response.status !== 200 || response.redirected)
    throw new Error("Unexpected registry response");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Registry response missing");
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > limit)
        throw new Error("Registry response exceeds expected bytes");
      chunks.push(value);
    }
  } finally {
    reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes);
}
async function published(info, fetchImpl) {
  try {
    const bytes = await registryBytes(info.url, fetchImpl, 262144, true);
    if (bytes === null) return false;
    const metadata = JSON.parse(bytes);
    if (
      metadata.name !== info.pkg.name ||
      metadata.version !== info.pkg.version ||
      metadata.dist?.integrity !== info.integrity ||
      metadata.dist?.tarball !== info.tarballUrl
    )
      throw new Error("Registry identity/integrity mismatch");
    const archive = await registryBytes(info.tarballUrl, fetchImpl, info.size);
    if (archive.length !== info.size)
      throw new Error("Registry artifact size differs");
    verifyAsset(archive, info.digest);
    return true;
  } catch {
    throw new Error(
      "Public npm registry identity/integrity verification failed",
    );
  }
}
function receiptFor(info, prepared) {
  return {
    registryPublished: true,
    registry,
    name: info.pkg.name,
    version: info.pkg.version,
    commit: prepared.sha,
    digest: prepared.artifact.digest,
    integrity: info.integrity,
    metadataUrl: info.url,
    tarballUrl: info.tarballUrl,
  };
}
export async function publishNpm(
  root,
  {
    prepared,
    archive,
    env = process.env,
    execute = execFileSync,
    fetchImpl = globalThis.fetch,
    pause: wait = pause,
    now = () => performance.now(),
  },
) {
  if (
    env.GITHUB_EVENT_NAME !== "push" ||
    env.GITHUB_REF !== "refs/heads/main" ||
    env.GITHUB_SHA !== prepared.sha ||
    env.CHECKS_RESULT !== "success" ||
    env.SMOKE_RESULT !== "success"
  )
    throw new Error(
      "Npm publication requires main push context, successful checks and exact candidate smoke",
    );
  const info = candidate(root, prepared, archive);
  if (!env.NODE_AUTH_TOKEN || /[\s\x00-\x1f\x7f]/.test(env.NODE_AUTH_TOKEN))
    throw new Error("Npm publication token is unavailable");
  if (await published(info, fetchImpl)) {
    candidate(root, prepared, archive);
    return receiptFor(info, prepared);
  }
  let failed = false;
  let failureCode = null;
  try {
    execute(
      "npm",
      [
        "publish",
        archive,
        "--ignore-scripts",
        "--access",
        "public",
        "--registry",
        registry,
        "--tag",
        "latest",
      ],
      {
        cwd: root,
        env: { ...env, NPM_CONFIG_LOGLEVEL: "error" },
        stdio: ["ignore", "ignore", "pipe"],
        maxBuffer: 65536,
        timeout: 120000,
      },
    );
  } catch (error) {
    failed = true;
    failureCode = npmFailureCode(error.stderr);
  }
  const deadline = now() + 120000;
  for (let attempt = 0; attempt < 25; attempt++) {
    if (attempt > 0 && now() >= deadline) break;
    if (await published(info, fetchImpl)) {
      candidate(root, prepared, archive);
      return receiptFor(info, prepared);
    }
    const remaining = deadline - now();
    if (remaining <= 0 || attempt === 24) break;
    await wait(Math.min(5000, remaining));
  }
  throw new Error(
    failed
      ? `Npm publish failed${failureCode ? ` (${failureCode})` : ""}; no exact public registry version verified`
      : "Npm publish returned without a verified public registry version",
  );
}
export async function verifyNpmReceipt(
  root,
  { prepared, archive, receipt, fetchImpl = globalThis.fetch },
) {
  const info = candidate(root, prepared, archive);
  const expected = receiptFor(info, prepared);
  if (
    !receipt ||
    Object.entries(expected).some(([key, value]) => receipt[key] !== value)
  )
    throw new Error("Npm publication receipt binding differs");
  if (!(await published(info, fetchImpl)))
    throw new Error("Npm publication receipt has no verified registry version");
  return expected;
}
