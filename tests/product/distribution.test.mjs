import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  chmod,
  symlink,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import tar from "tar-stream";
import { smokeTarball } from "../../scripts/smoke-candidate.mjs";
import { checkPackage } from "../../scripts/check-package.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
function command(program, args, cwd) {
  const result = spawnSync(program, args, {
    cwd,
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

test("built npm artifact runs its bin outside the source checkout and contains no private source notes", async (t) => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "unmask-distribution-"),
  );
  t.after(() => rm(temporary, { recursive: true, force: true }));
  command("npm", ["run", "build"], root);
  const packed = checkPackage(root, temporary, {
    requiredFiles: [
      "dist/cli/main.mjs",
      "dist/viewer/render.mjs",
      "dist/core/pipeline.mjs",
    ],
  });
  assert.ok(
    packed.files.every((name) => !/^(src|tests|scripts|research)\//.test(name)),
  );
  const install = path.join(temporary, "install");
  await mkdir(install);
  const archivePath = path.join(temporary, packed.filename);
  const packageBytes = command(
    "tar",
    ["-xOf", archivePath, "package/package.json"],
    root,
  );
  const metadata = JSON.parse(packageBytes);
  await writeFile(path.join(install, "package.json"), packageBytes);
  await writeFile(
    path.join(install, "package-lock.json"),
    await readFile(path.join(root, "package-lock.json")),
  );
  command(
    "npm",
    [
      "ci",
      "--offline",
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
    ],
    install,
  );
  const installedPackage = path.join(install, "node_modules", metadata.name);
  await mkdir(installedPackage, { recursive: true });
  command(
    "tar",
    ["-xzf", archivePath, "--strip-components=1", "-C", installedPackage],
    install,
  );
  const bin =
    typeof metadata.bin === "string" ? metadata.bin : metadata.bin.unmask;
  await chmod(path.join(installedPackage, bin), 0o755);
  const binDirectory = path.join(install, "node_modules/.bin");
  await mkdir(binDirectory, { recursive: true });
  await symlink(
    path.relative(binDirectory, path.join(installedPackage, bin)),
    path.join(binDirectory, "unmask"),
  );
  const archive = tar.pack(),
    chunks = [];
  const drain = (async () => {
    for await (const chunk of archive) chunks.push(chunk);
  })();
  archive.entry(
    { name: "package/package.json", mtime: new Date(0) },
    '{"name":"fixture","version":"1.0.0"}',
  );
  archive.entry(
    { name: "package/main.js", mtime: new Date(0) },
    "export const value = 42;",
  );
  archive.finalize();
  await drain;
  const artifact = path.join(temporary, "fixture.tgz");
  await writeFile(artifact, gzipSync(Buffer.concat(chunks)));
  const output = path.join(temporary, "result");
  command(
    path.join(install, "node_modules/.bin/unmask"),
    [
      "check",
      "--tarball",
      artifact,
      "--claim",
      "fixture@1.0.0",
      "--offline",
      "--cache-dir",
      path.join(temporary, "cache"),
      "--out",
      output,
    ],
    install,
  );
  const report = JSON.parse(await readFile(path.join(output, "report.json")));
  assert.equal(report.policy.exitCode, 0);
  assert.equal(report.inputs.claim.name, "fixture");
  assert.equal(report.coverage.inventory.files, 2);
  assert.equal(report.coverage.sourceAvailable, false);
  assert.match(
    await readFile(path.join(output, "report.html"), "utf8"),
    /fixture/,
  );
  const smoke = await smokeTarball({
    archive: path.join(temporary, packed.filename),
    lockfile: path.join(root, "package-lock.json"),
    packageDigest: packed.digest,
    lockDigest: packed.lockDigest,
    allowDirtyDiagnostic: true,
  });
  assert.equal(smoke.status, "passed");
  assert.equal(smoke.transport, "local-inert");
  assert.equal(smoke.policyExitCode, 3);
});
