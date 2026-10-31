import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  lstatSync,
  realpathSync,
  readdirSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkPackage } from "./check-package.mjs";
import { readiness } from "./release-readiness.mjs";
import { verifyBuild } from "./build.mjs";
import { createHash } from "node:crypto";
import { verifyAsset } from "./release-policy.mjs";

const digest = (bytes) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
function imageManifest(artifact, sha) {
  if (!artifact.build || artifact.build.commit !== sha || artifact.build.dirty)
    throw new Error("Candidate artifact has no clean matching build commit");
  return {
    version: artifact.build.version,
    commit: sha,
    packageDigest: artifact.digest,
    lockDigest: artifact.lockDigest,
    platform: "linux/amd64",
  };
}
export function createDockerContext(
  root,
  { archive, artifact, sha, dockerfile = "Dockerfile" },
) {
  const build = verifyBuild(root, { expectedSha: sha, requireClean: true });
  if (JSON.stringify(build) !== JSON.stringify(artifact.build))
    throw new Error("Candidate build identity changed before image creation");
  const bytes = readFileSync(archive);
  verifyAsset(bytes, artifact.digest);
  const lock = readFileSync(path.join(root, "package-lock.json"));
  verifyAsset(lock, artifact.lockDigest);
  const metadataBytes = execFileSync("tar", [
    "-xOf",
    archive,
    "package/package.json",
  ]);
  const metadata = JSON.parse(metadataBytes);
  const source = JSON.parse(readFileSync(path.join(root, "package.json")));
  for (const key of [
    "name",
    "version",
    "dependencies",
    "optionalDependencies",
    "devDependencies",
    "bin",
    "engines",
  ])
    if (JSON.stringify(metadata[key]) !== JSON.stringify(source[key]))
      throw new Error(`Packed package ${key} differs from pinned candidate`);
  if (
    path.isAbsolute(dockerfile) ||
    dockerfile.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("Dockerfile must be a trusted regular repository file");
  for (const name of [dockerfile, ".dockerignore"]) {
    const file = path.join(root, name),
      stat = lstatSync(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      !realpathSync(file).startsWith(`${realpathSync(root)}${path.sep}`)
    )
      throw new Error(
        "Docker context configuration must be a regular repository file",
      );
  }
  const manifest = imageManifest(artifact, sha);
  const snapshot = {
    "artifact.tgz": bytes,
    "package.json": metadataBytes,
    "package-lock.json": lock,
    Dockerfile: readFileSync(path.join(root, dockerfile)),
    ".dockerignore": readFileSync(path.join(root, ".dockerignore")),
    "candidate.json": Buffer.from(JSON.stringify(manifest) + "\n"),
  };
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "unmask-image-context-"),
  );
  const expected = new Map(
    Object.entries(snapshot).map(([name, value]) => [name, digest(value)]),
  );
  try {
    for (const [name, value] of Object.entries(snapshot))
      writeFileSync(path.join(directory, name), value, { mode: 0o600 });
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    directory,
    manifest,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
    verify() {
      if (
        JSON.stringify(readdirSync(directory).sort()) !==
        JSON.stringify([...expected.keys()].sort())
      )
        throw new Error("Candidate context inventory changed");
      for (const [name, hash] of expected) {
        if (
          !lstatSync(path.join(directory, name)).isFile() ||
          lstatSync(path.join(directory, name)).isSymbolicLink()
        )
          throw new Error("Candidate context contains unexpected file types");
        verifyAsset(readFileSync(path.join(directory, name)), hash);
      }
    },
  };
}
export function inspectCandidateImage(
  root,
  image,
  manifest,
  execute = execFileSync,
) {
  const [local] = JSON.parse(
    execute("docker", ["image", "inspect", image], {
      cwd: root,
      encoding: "utf8",
    }),
  );
  const labels = local.Config?.Labels ?? {};
  if (
    !/^sha256:[a-f0-9]{64}$/.test(local.Id || "") ||
    local.Os !== "linux" ||
    local.Architecture !== "amd64" ||
    labels["org.opencontainers.image.revision"] !== manifest.commit ||
    labels["org.opencontainers.image.version"] !== manifest.version ||
    labels["io.unmask.tarball.sha256"] !== manifest.packageDigest.slice(7) ||
    labels["io.unmask.lockfile.sha256"] !== manifest.lockDigest.slice(7)
  )
    throw new Error(
      "Candidate image platform/revision/version/tarball/lock identity differs",
    );
  return local.Id;
}
export function buildCandidateImage(
  root,
  {
    archive,
    artifact,
    sha,
    image,
    dockerfile = "Dockerfile",
    execute = execFileSync,
  },
) {
  const context = createDockerContext(root, {
    archive,
    artifact,
    sha,
    dockerfile,
  });
  try {
    context.verify();
    execute(
      "docker",
      [
        "buildx",
        "build",
        "--platform",
        "linux/amd64",
        "--load",
        "--build-arg",
        `TARBALL_SHA256=${artifact.digest.slice(7)}`,
        "--build-arg",
        `LOCKFILE_SHA256=${artifact.lockDigest.slice(7)}`,
        "--build-arg",
        `RELEASE_COMMIT=${sha}`,
        "--build-arg",
        `RELEASE_VERSION=${artifact.build.version}`,
        "--tag",
        image,
        context.directory,
      ],
      { cwd: root, stdio: "inherit" },
    );
    context.verify();
    return {
      imageId: inspectCandidateImage(root, image, context.manifest, execute),
      manifest: context.manifest,
    };
  } finally {
    context.cleanup();
  }
}

export function checkCandidate(
  root,
  { sha = process.env.GITHUB_SHA, execute = execFileSync } = {},
) {
  const result = readiness(root, { built: true });
  if (!result.ready)
    throw new Error(`Candidate blocked: ${result.reasons.join("; ")}`);
  if (!/^[a-f0-9]{40}$/.test(sha || ""))
    throw new Error("A full candidate SHA is required");
  const config = JSON.parse(
    readFileSync(path.join(root, "release.config.json")),
  );
  const destination = mkdtempSync(path.join(os.tmpdir(), "unmask-candidate-"));
  const image = `unmask-candidate:${sha}`;
  try {
    const artifact = checkPackage(root, destination, {
      requiredFiles: [config.cli, config.server, config.web],
      expectedSha: sha,
      requireClean: true,
    });
    const archive = path.join(destination, artifact.filename);
    const { imageId, manifest } = buildCandidateImage(root, {
      archive,
      artifact,
      sha,
      image,
      dockerfile: config.dockerfile,
      execute,
    });
    execute("npm", ["run", "test:release"], {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        RELEASE_IMAGE: image,
        RELEASE_PACKAGE: archive,
        RELEASE_LOCKFILE: path.join(root, "package-lock.json"),
        RELEASE_PACKAGE_SHA256: artifact.digest.slice(7),
        RELEASE_LOCKFILE_SHA256: artifact.lockDigest.slice(7),
        RELEASE_COMMIT: sha,
        RELEASE_VERSION: artifact.build.version,
        RELEASE_SMOKE_MODE: process.env.RELEASE_SMOKE_MODE ?? "live-public",
        RELEASE_SMOKE_PACKAGE:
          process.env.RELEASE_SMOKE_PACKAGE ?? "is-number@7.0.0",
      },
    });
    verifyAsset(readFileSync(archive), artifact.digest);
    verifyBuild(root, { expectedSha: sha, requireClean: true });
    if (inspectCandidateImage(root, image, manifest, execute) !== imageId)
      throw new Error("Candidate image changed during smoke test");
    return { sha, imageId, packageDigest: artifact.digest };
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
)
  console.log(JSON.stringify(checkCandidate(process.cwd()), null, 2));
