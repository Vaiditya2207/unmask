import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import tar from "tar-stream";
import { readArchive } from "../src/core/archive.mjs";
import { validatePackageFiles, verifyAsset } from "./release-policy.mjs";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function identityValid(value) {
  return (
    value &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value.version) &&
    /^[a-f0-9]{40}$/.test(value.commit) &&
    /^[a-f0-9]{64}$/.test(value.tarballSha256)
  );
}
async function fixtureArchive(prefix, files) {
  const stream = tar.pack(),
    chunks = [];
  const drain = (async () => {
    for await (const chunk of stream) chunks.push(chunk);
  })();
  for (const [name, body] of Object.entries(files))
    stream.entry({ name: `${prefix}/${name}`, mtime: new Date(0) }, body);
  stream.finalize();
  await drain;
  return gzipSync(Buffer.concat(chunks));
}
export async function smokeTarball({
  archive,
  lockfile,
  packageDigest,
  lockDigest,
  identity,
  allowDirtyDiagnostic = false,
}) {
  const bytes = readFileSync(archive),
    lockBytes = readFileSync(lockfile);
  verifyAsset(bytes, packageDigest);
  verifyAsset(lockBytes, lockDigest);
  const inventory = await readArchive(bytes, { kind: "artifact" });
  if (
    !inventory.complete ||
    inventory.entries.some(
      (e) =>
        !["file", "directory"].includes(e.type) ||
        (e.type === "file" && (!e.path || !e.content)),
    )
  )
    throw new Error("Candidate package cannot be safely inspected");
  validatePackageFiles(
    inventory.entries.filter((e) => e.type === "file").map((e) => e.path),
  );
  const metadata = JSON.parse(
    inventory.entries.find((e) => e.path === "dist/version.json")?.content ??
      "null",
  );
  const pkg = JSON.parse(
    inventory.entries.find((e) => e.path === "package.json")?.content ?? "null",
  );
  const lock = JSON.parse(lockBytes);
  if (
    !metadata ||
    !pkg ||
    lock.name !== pkg.name ||
    lock.version !== pkg.version ||
    metadata.version !== pkg.version ||
    metadata.lockfileSha256 !== lockDigest.slice(7)
  )
    throw new Error("Candidate archive/lock identity mismatch");
  if (
    !allowDirtyDiagnostic &&
    (!identityValid(identity) ||
      metadata.dirty ||
      metadata.commit !== identity.commit ||
      metadata.version !== identity.version ||
      identity.tarballSha256 !== packageDigest.slice(7))
  )
    throw new Error(
      "Candidate release version/commit/tarball identity mismatch",
    );
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.unmask;
  if (!bin || !inventory.entries.some((e) => e.path === bin))
    throw new Error("Candidate CLI entrypoint missing");
  const root = mkdtempSync(path.join(os.tmpdir(), "unmask-installed-smoke-"));
  try {
    const installed = path.join(root, "installed");
    mkdirSync(installed);
    for (const e of inventory.entries.filter((e) => e.type === "file")) {
      const file = path.join(installed, e.path);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, e.content, { mode: 0o600 });
    }
    writeFileSync(path.join(installed, "package-lock.json"), lockBytes);
    const env = { ...process.env, UNMASK_MODEL: "off" };
    for (const name of [
      "GEMINI_API_KEY",
      "UNMASK_MODEL_KEY",
      "NPM_TOKEN",
      "NODE_AUTH_TOKEN",
      "GITHUB_TOKEN",
    ])
      delete env[name];
    execFileSync(
      "npm",
      [
        "ci",
        "--omit=dev",
        "--ignore-scripts",
        "--offline",
        "--no-audit",
        "--no-fund",
      ],
      { cwd: installed, env, stdio: "ignore", timeout: 30000 },
    );
    const manifest = { name: "unmask-smoke-fixture", version: "1.0.0" };
    const artifact = await fixtureArchive("package", {
      "package.json": JSON.stringify({
        ...manifest,
        scripts: { install: "node SHOULD_NEVER_EXECUTE" },
      }),
      "main.js": "export default 42;",
    });
    const source = await fixtureArchive("smoke-source", {
      "package.json": JSON.stringify(manifest),
      "main.js": "export default 42;",
    });
    writeFileSync(path.join(root, "artifact.tgz"), artifact);
    writeFileSync(path.join(root, "source.tgz"), source);
    const result = spawnSync(
      process.execPath,
      [
        path.join(installed, bin),
        "check",
        "--tarball",
        path.join(root, "artifact.tgz"),
        "--claim",
        "unmask-smoke-fixture@1.0.0",
        "--source-archive",
        path.join(root, "source.tgz"),
        "--commit",
        "a".repeat(40),
        "--source-root",
        "smoke-source",
        "--offline",
        "--cache-dir",
        path.join(root, "cache"),
        "--out",
        path.join(root, "result"),
      ],
      { cwd: root, env, encoding: "utf8", timeout: 30000 },
    );
    if (result.status !== 3)
      throw new Error(
        "Installed candidate CLI did not return the expected lifecycle review result",
      );
    const report = JSON.parse(
      readFileSync(path.join(root, "result/report.json")),
    );
    if (
      report.policy.exitCode !== 3 ||
      !report.policy.findings.some(
        (f) => f.ruleId === "lifecycle-source-absent",
      ) ||
      report.model.status !== "not-sent" ||
      report.model.reason !== "consent-required" ||
      !readFileSync(path.join(root, "result/report.html"), "utf8").includes(
        "unmask-smoke-fixture",
      )
    )
      throw new Error(
        "Installed candidate CLI evidence/lifecycle result differs",
      );
    return {
      status: "passed",
      transport: "local-inert",
      policyExitCode: 3,
      diagnostic: allowDirtyDiagnostic,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
export async function smokeHttpCandidate({
  baseURL,
  identity,
  packageSpec,
  mode,
  fetchImpl = globalThis.fetch,
  now = () => performance.now(),
  pause: wait = pause,
}) {
  const base = new URL(baseURL);
  if (
    !identityValid(identity) ||
    !["recorded", "live-public"].includes(mode) ||
    !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+@\d+\.\d+\.\d+$/.test(
      packageSpec || "",
    ) ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash ||
    !(
      base.protocol === "https:" ||
      (base.protocol === "http:" &&
        ["127.0.0.1", "[::1]", "localhost"].includes(base.hostname))
    )
  )
    throw new Error(
      "Explicit candidate identity, transport mode and exact package are required",
    );
  const deadline = now() + 150000;
  async function request(route, options = {}) {
    if (now() >= deadline)
      throw new Error("Candidate HTTP smoke deadline exceeded");
    const response = await fetchImpl(new URL(route, base).href, {
      redirect: "manual",
      signal: AbortSignal.timeout(
        Math.max(1, Math.min(10000, deadline - now())),
      ),
      ...options,
    });
    const reader = response.body?.getReader(),
      chunks = [];
    let length = 0;
    if (reader)
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > 8388608)
            throw new Error("Candidate HTTP response exceeds smoke budget");
          chunks.push(value);
        }
      } finally {
        reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    return { response, body: Buffer.concat(chunks, length).toString("utf8") };
  }
  let health;
  for (let i = 0; i < 100; i++) {
    try {
      health = await request("/healthz");
      if (health.response.status === 200) break;
    } catch {}
    await wait(100);
  }
  if (health?.response.status !== 200)
    throw new Error("Candidate health could not be verified");
  const version = await request("/version");
  const actual = JSON.parse(version.body);
  if (
    version.response.status !== 200 ||
    Object.entries(identity).some(([key, value]) => actual[key] !== value)
  )
    throw new Error("Candidate HTTP version/commit/tarball identity differs");
  const home = await request("/");
  if (home.response.status !== 200 || !home.body.includes("<form"))
    throw new Error("Candidate normal entrypoint is unavailable");
  const submitted = await request("/check", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: base.origin,
    },
    body: new URLSearchParams({ package: packageSpec }).toString(),
  });
  const location = submitted.response.headers.get("location");
  if (
    submitted.response.status !== 303 ||
    !/^\/r\/[a-f0-9]{32}$/.test(location || "")
  )
    throw new Error("Candidate normal POST did not create a report");
  let report;
  while (now() < deadline) {
    const polled = await request(`${location}.json`);
    if (polled.response.status === 202) {
      await wait(250);
      continue;
    }
    report = JSON.parse(polled.body);
    if (
      polled.response.status !== 200 ||
      !/^[a-f0-9]{64}$/.test(report.inputs?.artifact?.sha256 || "") ||
      `${report.inputs?.claim?.name}@${report.inputs?.claim?.version}` !==
        packageSpec ||
      ![0, 3].includes(report.policy?.exitCode) ||
      !["disabled", "not-sent"].includes(report.model?.status)
    )
      throw new Error(
        "Candidate did not persist a complete deterministic report for the submitted package",
      );
    break;
  }
  if (!report) throw new Error("Candidate report did not complete");
  const html = await request(location);
  if (
    html.response.status !== 200 ||
    !html.body.includes(report.inputs.artifact.sha256)
  )
    throw new Error("Candidate HTML does not show the persisted report");
  const followup = await request(`${location}.json`);
  const persisted = JSON.parse(followup.body);
  if (
    followup.response.status !== 200 ||
    persisted.inputs?.artifact?.sha256 !== report.inputs.artifact.sha256 ||
    persisted.policy?.exitCode !== report.policy.exitCode
  )
    throw new Error("Candidate follow-up lost persisted report identity");
  return {
    status: "passed",
    transport: mode,
    packageSpec,
    policyExitCode: report.policy.exitCode,
    modelAcceptance: "not-tested",
  };
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  const archive = process.env.RELEASE_PACKAGE,
    lockfile = process.env.RELEASE_LOCKFILE;
  const identity = {
    version: process.env.RELEASE_VERSION,
    commit: process.env.RELEASE_COMMIT,
    tarballSha256: process.env.RELEASE_PACKAGE_SHA256,
  };
  const cli = await smokeTarball({
    archive,
    lockfile,
    packageDigest: `sha256:${identity.tarballSha256}`,
    lockDigest: `sha256:${process.env.RELEASE_LOCKFILE_SHA256}`,
    identity,
  });
  let container,
    baseURL = process.env.RELEASE_CANDIDATE_URL;
  try {
    if (!baseURL && process.env.RELEASE_IMAGE) {
      container = execFileSync(
        "docker",
        [
          "run",
          "--detach",
          "--rm",
          "--read-only",
          "--tmpfs",
          "/tmp:rw,noexec,nosuid,size=768m",
          "--publish",
          "127.0.0.1::8080",
          "--env",
          "UNMASK_MODEL=off",
          process.env.RELEASE_IMAGE,
        ],
        { encoding: "utf8" },
      ).trim();
      if (!/^[a-f0-9]{12,64}$/.test(container))
        throw new Error("Candidate container identity unavailable");
      const address = execFileSync("docker", ["port", container, "8080/tcp"], {
        encoding: "utf8",
      }).trim();
      if (!/^127\.0\.0\.1:\d+$/.test(address))
        throw new Error("Candidate container port unavailable");
      baseURL = `http://${address}/`;
    }
    if (!baseURL)
      throw new Error(
        "HTTP verification blocked: no running candidate URL/image supplied",
      );
    const http = await smokeHttpCandidate({
      baseURL,
      identity,
      packageSpec: process.env.RELEASE_SMOKE_PACKAGE,
      mode: process.env.RELEASE_SMOKE_MODE,
    });
    console.log(
      JSON.stringify({ cli, http, modelAcceptance: "not-tested" }, null, 2),
    );
  } finally {
    if (container)
      try {
        execFileSync("docker", ["rm", "--force", container], {
          stdio: "ignore",
        });
      } catch {}
  }
}
