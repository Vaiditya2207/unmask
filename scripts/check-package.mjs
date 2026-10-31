import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validatePackageFiles, verifyAsset } from "./release-policy.mjs";

export function checkPackage(root, destination) {
  const [packed] = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", destination],
      { cwd: root, encoding: "utf8" },
    ),
  );
  validatePackageFiles(packed.files.map((file) => file.path));
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
  const source = JSON.parse(readFileSync(path.join(root, "package.json")));
  if (metadata.name !== source.name || metadata.version !== source.version)
    throw new Error("Archive package identity mismatch");
  const bytes = readFileSync(archive);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  verifyAsset(bytes, digest);
  return {
    filename: packed.filename,
    digest,
    size: bytes.length,
    files: packed.files.map((file) => file.path),
  };
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  const temporary = !process.argv[2];
  const destination =
    process.argv[2] || mkdtempSync(path.join(os.tmpdir(), "unmask-pack-"));
  try {
    console.log(
      JSON.stringify(checkPackage(process.cwd(), destination), null, 2),
    );
  } finally {
    if (temporary) rmSync(destination, { recursive: true, force: true });
  }
}
