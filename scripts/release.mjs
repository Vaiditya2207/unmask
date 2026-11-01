import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { planRelease, verifyAsset } from "./release-policy.mjs";
import { readiness } from "./release-readiness.mjs";
import {
  buildCandidateImage,
  inspectCandidateImage,
} from "./check-candidate.mjs";
import { verifyBuild } from "./build.mjs";
import path from "node:path";
import { checkPackage } from "./check-package.mjs";
import { publishNpm, verifyNpmReceipt } from "./npm-publication.mjs";
import { releaseDeploymentOutputs } from "./cloud-run-policy.mjs";
import { releaseNotes } from "./release-notes.mjs";

const mode = process.argv[2];
if (
  !["prepare", "build", "publish", "npm-preflight", "npm-publish"].includes(
    mode,
  )
)
  throw new Error(
    "Expected prepare, build, publish, npm-preflight or npm-publish",
  );
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
  (["prepare", "publish"].includes(mode) && !token) ||
  !actor ||
  !/^\d+$/.test(runId || "")
)
  throw new Error("Trusted GitHub Actions context is required");
const pkg = JSON.parse(readFileSync("package.json"));
const config = JSON.parse(readFileSync("release.config.json"));
const ready = readiness(process.cwd(), { built: true, expectedSha: sha });
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

async function requireImmutableReleases() {
  const settings = await api("immutable-releases", {
    credential: process.env.RELEASE_SETTINGS_TOKEN || token,
  });
  if (settings.enabled !== true)
    throw new Error(
      "GitHub release immutability must be enabled before publication",
    );
}

async function registryInspector() {
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
  return async function registryManifest(tag) {
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
  };
}

async function requireUnusedImageTags(registryManifest, plan) {
  for (const tag of [plan.tag, plan.imageTag]) {
    const existing = await registryManifest(tag);
    if (existing.status !== 404)
      throw new Error(
        `Image tag ${tag} unavailable for creation (${existing.status}); never overwrite`,
      );
  }
}

async function inventory(endpoint, field) {
  const names = [];
  for (let page = 1; page <= 100; page++) {
    const records = await api(`${endpoint}?per_page=100&page=${page}`);
    names.push(...records.map((record) => (field ? record[field] : record)));
    if (records.length < 100) return names;
  }
  throw new Error("Version inventory exceeded pagination limit");
}

const existingReleases = ["build", "npm-preflight", "npm-publish"].includes(
  mode,
)
  ? []
  : await inventory("releases");
const plan = planRelease({
  version: pkg.version,
  sha,
  ref,
  checks: process.env.CHECKS_RESULT,
  ready: ready.ready,
  tags: ["build", "npm-preflight", "npm-publish"].includes(mode)
    ? []
    : await inventory("tags", "name"),
  releases: existingReleases.map((release) => release.tag_name),
});
const image = `ghcr.io/${repository.toLowerCase()}`;
const imageRef = `${image}:${plan.imageTag}`;
mkdirSync("artifacts", { recursive: true });

if (mode === "prepare") {
  await requireImmutableReleases();
  await requireUnusedImageTags(await registryInspector(), plan);
  const artifact = checkPackage(process.cwd(), "artifacts", {
    expectedSha: sha,
    requireClean: true,
  });
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
} else if (mode === "build") {
  const prepared = JSON.parse(readFileSync("artifacts/release-plan.json"));
  if (
    prepared.sha !== sha ||
    prepared.version !== pkg.version ||
    prepared.imageRef !== imageRef
  )
    throw new Error("Prepared candidate binding differs");
  const result = buildCandidateImage(process.cwd(), {
    archive: path.resolve("artifacts", prepared.artifact.filename),
    artifact: prepared.artifact,
    sha,
    image: imageRef,
    dockerfile: config.dockerfile,
  });
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `image_id=${result.imageId}\npackage_sha256=${prepared.artifact.digest.slice(7)}\nlockfile_sha256=${prepared.artifact.lockDigest.slice(7)}\nversion=${pkg.version}\n`,
    );
  console.log(
    `Built exact npm artifact image for ${plan.tag}; nothing published`,
  );
} else if (mode === "npm-preflight") {
  if (config.npmPublishEnabled !== true)
    throw new Error("Npm publication preparation gate is closed");
  const prepared = JSON.parse(readFileSync("artifacts/release-plan.json"));
  if (
    prepared.sha !== sha ||
    prepared.version !== pkg.version ||
    prepared.imageRef !== imageRef
  )
    throw new Error("Prepared npm candidate differs");
  verifyAsset(
    readFileSync(path.join("artifacts", prepared.artifact.filename)),
    prepared.artifact.digest,
  );
  verifyAsset(readFileSync("package-lock.json"), prepared.artifact.lockDigest);
  const build = verifyBuild(process.cwd(), {
    expectedSha: sha,
    requireClean: true,
  });
  if (JSON.stringify(build) !== JSON.stringify(prepared.artifact.build))
    throw new Error("Prepared npm build identity changed");
  console.log(
    "Local npm artifact preflight passed; registry authentication and publication were not attempted",
  );
} else if (mode === "npm-publish") {
  const prepared = JSON.parse(readFileSync("artifacts/release-plan.json"));
  if (
    prepared.sha !== sha ||
    prepared.version !== pkg.version ||
    prepared.imageRef !== imageRef
  )
    throw new Error("Prepared npm candidate differs");
  const receipt = await publishNpm(process.cwd(), {
    prepared,
    archive: path.resolve("artifacts", prepared.artifact.filename),
  });
  writeFileSync(
    "artifacts/npm-publication.json",
    JSON.stringify(receipt, null, 2) + "\n",
  );
  console.log("Verified exact public npm version; publication receipt saved");
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
  let npmReceipt;
  if (config.npmPublishEnabled === true) {
    if (process.env.NPM_RESULT !== "success")
      throw new Error(
        "Exact npm publication step must succeed before the GitHub release",
      );
    npmReceipt = await verifyNpmReceipt(process.cwd(), {
      prepared,
      archive: path.resolve("artifacts", prepared.artifact.filename),
      receipt: JSON.parse(readFileSync("artifacts/npm-publication.json")),
    });
  }
  await requireImmutableReleases();
  const registryManifest = await registryInspector();
  await requireUnusedImageTags(registryManifest, plan);
  const testedId = inspectCandidateImage(process.cwd(), imageRef, {
    commit: sha,
    version: pkg.version,
    packageDigest: prepared.artifact.digest,
    lockDigest: prepared.artifact.lockDigest,
  });
  if (testedId !== process.env.CANDIDATE_IMAGE_ID)
    throw new Error("Tested candidate image identity differs");
  verifyAsset(readFileSync("package-lock.json"), prepared.artifact.lockDigest);
  verifyBuild(process.cwd(), { expectedSha: sha, requireClean: true });
  const commitNotes = await releaseNotes({
    repository,
    sha,
    releases: existingReleases,
    api,
  });
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
      registryPublished: Boolean(npmReceipt),
      ...(npmReceipt
        ? {
            registry: npmReceipt.registry,
            integrity: npmReceipt.integrity,
            metadataUrl: npmReceipt.metadataUrl,
          }
        : {}),
      filename: prepared.artifact.filename,
      digest: prepared.artifact.digest,
      size: bytes.length,
      lockDigest: prepared.artifact.lockDigest,
      sourceSha256: prepared.artifact.build.sourceSha256,
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
      body: `Commit: ${sha}\nImage: ${image}@${digest}\nChecks and candidate smoke: ${manifest.workflow}\n${process.env.PRODUCTION_DEPLOY === "true" ? "Production deployment follows in this workflow after complete GitHub and verified npm publication. See release-manifest.json for artifact integrity and the deploy job for serving evidence." : "Production deployment deferred: API and web production were not changed by this release. Only the release whose version equals productionDeployVersion in release.config.json is deployed. See release-manifest.json for artifact integrity."}\n\n${commitNotes}`,
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
  const sealedTag = await api(`git/ref/tags/${plan.tag}`);
  const deployment = releaseDeploymentOutputs({
    repository,
    manifest,
    published,
    sealedTag,
  });
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(deployment)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
    );
  console.log(
    `Published immutable ${plan.tag}: ${image}@${digest}; production deployment is handled by the dependent job`,
  );
}
