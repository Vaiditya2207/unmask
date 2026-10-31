import { createHash } from "node:crypto";

export function planRelease({
  version,
  sha,
  ref,
  checks,
  ready,
  tags,
  releases,
}) {
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) ||
    version === "0.0.0"
  )
    throw new Error("A positive stable release version is required");
  if (!/^[a-f0-9]{40}$/.test(sha))
    throw new Error("A full commit SHA is required");
  if (ref !== "refs/heads/main") throw new Error("Releases require main");
  if (checks !== "success") throw new Error("Required checks did not succeed");
  if (ready !== true) throw new Error("Application is not release ready");
  if (!Array.isArray(tags) || !Array.isArray(releases))
    throw new Error("Existing version inventory is required");
  const tag = `v${version}`;
  if (tags.includes(tag) || releases.includes(tag))
    throw new Error(`Version ${tag} already exists; choose a new version`);
  return { version, tag, sha, imageTag: `sha-${sha}` };
}

export function verifyAsset(bytes, expected) {
  const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (actual !== expected) throw new Error("Asset digest mismatch");
  return actual;
}

export function validatePackageFiles(files) {
  if (!files.length || !files.includes("package.json"))
    throw new Error("Package metadata missing");
  for (const file of files) {
    const parts = file.split("/");
    const internal = parts.some(
      (part) =>
        part.startsWith(".") ||
        /^(internal|research|node_modules|tests|scripts)$/i.test(part) ||
        /\.internal\./i.test(part),
    );
    if (
      internal ||
      file.includes("\\") ||
      (!["package.json", "README.md", "LICENSE"].includes(file) &&
        !file.startsWith("dist/"))
    )
      throw new Error(`Package file not allowed: ${file}`);
  }
}
