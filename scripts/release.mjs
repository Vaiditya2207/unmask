import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { planRelease, verifyAsset } from "./release-policy.mjs";
import { readiness } from "./release-readiness.mjs";
import { checkPackage } from "./check-package.mjs";

const mode = process.argv[2];
if (!["prepare", "publish"].includes(mode))
  throw new Error("Expected prepare or publish");
const {
  GITHUB_REPOSITORY: repository,
  GITHUB_SHA: sha,
  GITHUB_REF: ref,
  GITHUB_TOKEN: token,
  GITHUB_ACTOR: actor,
  GITHUB_RUN_ID: runId,
} = process.env;
if (
  !/^[\w.-]+\/[\w.-]+$/.test(repository || "") ||
  !token ||
  !actor ||
  !/^\d+$/.test(runId || "")
)
  throw new Error("Trusted GitHub Actions context is required");
const pkg = JSON.parse(readFileSync("package.json"));
const config = JSON.parse(readFileSync("release.config.json"));
const ready = readiness(process.cwd(), { built: true });
if (!ready.ready)
  throw new Error(`Release blocked: ${ready.reasons.join("; ")}`);
if (
  execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() !==
  sha
)
  throw new Error("Checkout SHA differs from candidate");

async function api(
  endpoint,
  { method = "GET", body, credential = token } = {},
) {
  const response = await fetch(
    `https://api.github.com/repos/${repository}/${endpoint}`,
    {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${credential}`,
        "X-GitHub-Api-Version": "2026-03-10",
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
  if (!response.ok)
    throw new Error(
      `GitHub ${method} ${endpoint.split("?")[0]} failed (${response.status})`,
    );
  return response.json();
}

async function inventory(endpoint, field) {
  const names = [];
  for (let page = 1; page <= 100; page++) {
    const records = await api(`${endpoint}?per_page=100&page=${page}`);
    names.push(...records.map((record) => record[field]));
    if (records.length < 100) return names;
  }
  throw new Error("Version inventory exceeded pagination limit");
}

const plan = planRelease({
  version: pkg.version,
  sha,
  ref,
  checks: process.env.CHECKS_RESULT,
  ready: ready.ready,
  tags: await inventory("tags", "name"),
  releases: await inventory("releases", "tag_name"),
});
const image = `ghcr.io/${repository.toLowerCase()}`;
const imageRef = `${image}:${plan.imageTag}`;
mkdirSync("artifacts", { recursive: true });

if (mode === "prepare") {
  const artifact = checkPackage(process.cwd(), "artifacts");
  for (const entry of [config.cli, config.server, config.web]) {
    if (!artifact.files.includes(entry))
      throw new Error(`Entrypoint missing from npm artifact: ${entry}`);
  }
  writeFileSync(
    "artifacts/release-plan.json",
    JSON.stringify({ ...plan, image, imageRef, artifact }, null, 2) + "\n",
  );
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `image=${imageRef}\npackage=artifacts/${artifact.filename}\ndockerfile=${config.dockerfile}\n`,
    );
  console.log(`Prepared ${plan.tag} at ${sha}; nothing published`);
} else {
  if (process.env.SMOKE_RESULT !== "success")
    throw new Error(
      "Exact candidate smoke test must succeed before publishing",
    );
  const prepared = JSON.parse(readFileSync("artifacts/release-plan.json"));
  if (
    prepared.sha !== sha ||
    prepared.version !== pkg.version ||
    prepared.imageRef !== imageRef
  )
    throw new Error("Prepared candidate binding differs");
  const bytes = readFileSync(`artifacts/${prepared.artifact.filename}`);
  verifyAsset(bytes, prepared.artifact.digest);
  const settings = await api("immutable-releases", {
    credential: process.env.RELEASE_SETTINGS_TOKEN || token,
  });
  if (settings.enabled !== true)
    throw new Error(
      "GitHub release immutability must be enabled before publication",
    );
  const registryAuth = await fetch(
    `https://ghcr.io/token?service=ghcr.io&scope=repository:${repository.toLowerCase()}:pull`,
    {
      headers: {
        Authorization: `Basic ${Buffer.from(`${actor}:${token}`).toString("base64")}`,
      },
    },
  );
  if (!registryAuth.ok)
    throw new Error(`GHCR authentication failed (${registryAuth.status})`);
  const registryToken = (await registryAuth.json()).token;
  if (!registryToken) throw new Error("GHCR token missing");
  async function registryManifest(tag) {
    return fetch(
      `https://ghcr.io/v2/${repository.toLowerCase()}/manifests/${tag}`,
      {
        method: "HEAD",
        headers: {
          Authorization: `Bearer ${registryToken}`,
          Accept:
            "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
        },
      },
    );
  }
  for (const tag of [plan.tag, plan.imageTag]) {
    const existing = await registryManifest(tag);
    if (existing.status !== 404)
      throw new Error(
        `Image tag ${tag} unavailable for creation (${existing.status}); never overwrite`,
      );
  }
  const [local] = JSON.parse(
    execFileSync("docker", ["image", "inspect", imageRef], {
      encoding: "utf8",
    }),
  );
  if (
    local.Id !== process.env.CANDIDATE_IMAGE_ID ||
    local.Os !== "linux" ||
    local.Architecture !== "amd64" ||
    local.Config.Labels?.["org.opencontainers.image.revision"] !== sha
  )
    throw new Error("Image platform or revision differs from tested candidate");
  const reserved = await api("git/refs", {
    method: "POST",
    body: { ref: `refs/tags/${plan.tag}`, sha },
  });
  if (reserved.object?.sha !== sha)
    throw new Error("Reserved release tag differs from candidate");
  execFileSync(
    "docker",
    ["login", "ghcr.io", "--username", actor, "--password-stdin"],
    { input: token, stdio: ["pipe", "ignore", "ignore"] },
  );
  execFileSync("docker", ["tag", imageRef, `${image}:${plan.tag}`], {
    stdio: "inherit",
  });
  for (const tag of [plan.imageTag, plan.tag])
    execFileSync("docker", ["push", `${image}:${tag}`], { stdio: "inherit" });
  const results = await Promise.all([
    registryManifest(plan.tag),
    registryManifest(plan.imageTag),
  ]);
  const digest = results[0].headers.get("docker-content-digest");
  if (
    results.some(
      (response) =>
        !response.ok ||
        response.headers.get("docker-content-digest") !== digest,
    ) ||
    !/^sha256:[a-f0-9]{64}$/.test(digest || "")
  )
    throw new Error("Published image digest mismatch");
  const manifest = {
    version: plan.version,
    tag: plan.tag,
    commit: sha,
    workflow: `https://github.com/${repository}/actions/runs/${runId}`,
    package: {
      name: pkg.name,
      registryPublished: false,
      filename: prepared.artifact.filename,
      digest: prepared.artifact.digest,
      size: bytes.length,
    },
    image: { reference: `${image}@${digest}`, digest, platform: "linux/amd64" },
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync("artifacts/release-manifest.json", manifestBytes);
  const draft = await api("releases", {
    method: "POST",
    body: {
      tag_name: plan.tag,
      target_commitish: sha,
      name: plan.tag,
      draft: true,
      body: `Commit: ${sha}\nImage: ${image}@${digest}\nChecks and candidate smoke: ${manifest.workflow}\nDeploy manually by digest in DigitalOcean App Platform. See release-manifest.json for npm asset integrity.`,
    },
  });
  for (const [name, content] of [
    [prepared.artifact.filename, bytes],
    ["release-manifest.json", manifestBytes],
  ]) {
    const uploadUrl = new URL(draft.upload_url.split("{")[0]);
    if (uploadUrl.origin !== "https://uploads.github.com")
      throw new Error("Unexpected release upload host");
    uploadUrl.searchParams.set("name", name);
    const response = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
        "X-GitHub-Api-Version": "2026-03-10",
      },
      body: content,
    });
    if (!response.ok)
      throw new Error(`Asset upload failed (${response.status})`);
    const asset = await response.json();
    if (asset.state !== "uploaded" || asset.size !== content.length)
      throw new Error("Uploaded asset metadata differs");
    verifyAsset(content, asset.digest);
  }
  const tag = await api(`git/ref/tags/${plan.tag}`);
  if (tag.object?.type !== "commit" || tag.object.sha !== sha)
    throw new Error("Release tag changed before publication");
  const published = await api(`releases/${draft.id}`, {
    method: "PATCH",
    body: { draft: false },
  });
  if (published.immutable !== true)
    throw new Error("Published release immutability was not confirmed");
  console.log(
    `Published immutable ${plan.tag}: ${image}@${digest}; deployment remains manual`,
  );
}
