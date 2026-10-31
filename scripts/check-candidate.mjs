import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkPackage } from "./check-package.mjs";
import { readiness } from "./release-readiness.mjs";
import { verifyAsset } from "./release-policy.mjs";

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
  function inspect() {
    const [local] = JSON.parse(
      execute("docker", ["image", "inspect", image], {
        cwd: root,
        encoding: "utf8",
      }),
    );
    if (
      !/^sha256:[a-f0-9]{64}$/.test(local.Id || "") ||
      local.Os !== "linux" ||
      local.Architecture !== "amd64" ||
      local.Config?.Labels?.["org.opencontainers.image.revision"] !== sha
    )
      throw new Error("Candidate image platform or revision differs");
    return local.Id;
  }
  try {
    const artifact = checkPackage(root, destination, {
      requiredFiles: [config.cli, config.server, config.web],
    });
    const archive = path.join(destination, artifact.filename);
    execute(
      "docker",
      [
        "buildx",
        "build",
        "--platform",
        "linux/amd64",
        "--load",
        "--file",
        config.dockerfile,
        "--label",
        `org.opencontainers.image.revision=${sha}`,
        "--tag",
        image,
        ".",
      ],
      { cwd: root, stdio: "inherit" },
    );
    const imageId = inspect();
    execute("npm", ["run", "test:release"], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, RELEASE_IMAGE: image, RELEASE_PACKAGE: archive },
    });
    verifyAsset(readFileSync(archive), artifact.digest);
    if (inspect() !== imageId)
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
