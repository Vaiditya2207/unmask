import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildProduct, verifyBuild, declaredEntrypoints } from "./build.mjs";
import { validatePackageFiles, verifyAsset } from "./release-policy.mjs";

export function checkPackage(
  root,
  destination,
  { requiredFiles = [], expectedSha, requireClean = false } = {},
) {
  const source = JSON.parse(readFileSync(path.join(root, "package.json")));
  const declared = declaredEntrypoints(source);
  const build =
    declared.length || expectedSha !== undefined || requireClean
      ? verifyBuild(root, { expectedSha, requireClean })
      : undefined;
  const [packed] = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", destination],
      { cwd: root, encoding: "utf8" },
    ),
  );
  validatePackageFiles(packed.files.map((file) => file.path));
  for (const file of [...new Set([...declared, ...requiredFiles])]) {
    if (!packed.files.some((entry) => entry.path === file))
      throw new Error(`Entrypoint missing from npm artifact: ${file}`);
  }
  const archive = path.join(destination, packed.filename);
  const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
    .trim()
    .split("\n");
  if (entries.some((entry) => !entry.startsWith("package/")))
    throw new Error("Invalid archive root");
  validatePackageFiles(
    entries
      .filter((entry) => !entry.endsWith("/"))
      .map((entry) => entry.slice("package/".length)),
  );
  const metadata = JSON.parse(
    execFileSync("tar", ["-xOf", archive, "package/package.json"], {
      encoding: "utf8",
    }),
  );
  if (metadata.name !== source.name || metadata.version !== source.version)
    throw new Error("Archive package identity mismatch");
  if (build) {
    const packedBuild = JSON.parse(
      execFileSync("tar", ["-xOf", archive, "package/dist/version.json"], {
        encoding: "utf8",
      }),
    );
    if (JSON.stringify(packedBuild) !== JSON.stringify(build))
      throw new Error("Packed product build identity differs");
    for (const [name, record] of Object.entries(build.files)) {
      const packedBytes = execFileSync(
        "tar",
        ["-xOf", archive, `package/dist/${name}`],
        { maxBuffer: 16777216 },
      );
      verifyAsset(packedBytes, `sha256:${record.sha256}`);
    }
    verifyBuild(root, { expectedSha, requireClean });
  }
  const bytes = readFileSync(archive);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  verifyAsset(bytes, digest);
  return {
    filename: packed.filename,
    digest,
    size: bytes.length,
    files: packed.files.map((file) => file.path),
    ...(build ? { build, lockDigest: `sha256:${build.lockfileSha256}` } : {}),
  };
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  const args = process.argv.slice(2);
  if (args.includes("--build")) {
    buildProduct(process.cwd());
    args.splice(args.indexOf("--build"), 1);
  }
  if (args.length > 1 || args.some((arg) => arg.startsWith("--")))
    throw new Error("Usage: check-package.mjs [--build] [destination]");
  const temporary = !args[0];
  const destination =
    args[0] || mkdtempSync(path.join(os.tmpdir(), "unmask-pack-"));
  try {
    console.log(
      JSON.stringify(checkPackage(process.cwd(), destination), null, 2),
    );
  } finally {
    if (temporary) rmSync(destination, { recursive: true, force: true });
  }
}
