import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  readFileSync,
  readdirSync,
  lstatSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tar from "tar-stream";

export const PREVIEW = Object.freeze({
  project: "unmask-513319",
  region: "asia-south1",
  service: "unmask-web-preview",
  repository: "Vaiditya2207/unmask",
  repositoryId: "1440901935",
  ownerId: "145288107",
  image: "asia-south1-docker.pkg.dev/unmask-513319/unmask-preview/web",
  apiURL: "https://unmask-386156642190.asia-south1.run.app",
  runtimeSA: "unmask-web-preview@unmask-513319.iam.gserviceaccount.com",
  deploySA: "unmask-preview-deploy@unmask-513319.iam.gserviceaccount.com",
  provider:
    "projects/386156642190/locations/global/workloadIdentityPools/unmask-preview/providers/github",
});
export const ARTIFACT_LIMITS = Object.freeze({
  imageBytes: 1073741824,
  metadataBytes: 16384,
  entries: 20000,
});
const sha = (value) => /^[a-f0-9]{40}$/.test(value ?? "");
const digest = (value) => /^sha256:[a-f0-9]{64}$/.test(value ?? "");
const integer = (value) =>
  Number.isSafeInteger(Number(value)) && Number(value) > 0;
const canonical = (value) =>
  JSON.stringify(value, (_, item) =>
    item && !Array.isArray(item) && typeof item === "object"
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : item,
  );
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
export const ALLOWED_HEAD_REPOSITORIES = Object.freeze({
  "Vaiditya2207/unmask": { id: "1440901935", ownerId: "145288107" },
  "Pranay0083/unmask": { id: "1441129169", ownerId: "149870314" },
  "visheshrao17/unmask": { id: "1441129131", ownerId: "151499332" },
});
const repository = (value) =>
  String(value?.id) === PREVIEW.repositoryId &&
  value.full_name === PREVIEW.repository &&
  String(value.owner?.id) === PREVIEW.ownerId;
const allowedHead = (value) => {
  const expected = ALLOWED_HEAD_REPOSITORIES[value?.full_name];
  return (
    expected &&
    integer(value.id) &&
    integer(value.owner?.id) &&
    String(value.id) === expected.id &&
    String(value.owner.id) === expected.ownerId
  );
};
const version = (value) =>
  typeof value === "string" &&
  value.length <= 100 &&
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
    value,
  );

export function previewContext(env, mode) {
  assert(
    ["deploy", "cleanup"].includes(mode) &&
      env.GITHUB_EVENT_NAME ===
        (mode === "deploy" ? "workflow_run" : "pull_request_target") &&
      env.GITHUB_REF === "refs/heads/main" &&
      env.GITHUB_REPOSITORY === PREVIEW.repository &&
      env.GITHUB_REPOSITORY_ID === PREVIEW.repositoryId &&
      env.GITHUB_REPOSITORY_OWNER_ID === PREVIEW.ownerId &&
      env.PREVIEW_ENVIRONMENT === "preview" &&
      env.GITHUB_WORKFLOW_REF ===
        `${PREVIEW.repository}/.github/workflows/web-preview-${mode}.yml@refs/heads/main`,
    "Preview requires trusted main workflow, repository and preview environment",
  );
  return PREVIEW;
}
export function validatePull(pull, state = "open") {
  assert(
    integer(pull?.number) &&
      pull.state === state &&
      allowedHead(pull.head?.repo) &&
      repository(pull.base?.repo) &&
      pull.base.ref === "main" &&
      sha(pull.head.sha),
    "Preview requires current allowlisted-head PR targeting main",
  );
  return pull;
}
function validateRunIdentity(run, expected) {
  assert(
    Number(run.id) === Number(expected.runId) &&
      Number(run.run_attempt) === Number(expected.attempt) &&
      Number(run.workflow_id) === Number(expected.workflowId) &&
      run.event === "pull_request" &&
      run.status === "completed" &&
      run.conclusion === "success" &&
      run.path === ".github/workflows/web-preview-build.yml" &&
      repository(run.repository) &&
      allowedHead(run.head_repository) &&
      sha(run.head_sha) &&
      Array.isArray(run.pull_requests) &&
      run.pull_requests.length <= 1,
    "Build run, workflow or repository identity differs",
  );
}
export function validateBuildRun(run, pull, expected) {
  validatePull(pull);
  validateRunIdentity(run, expected);
  const associated = run.pull_requests[0];
  const commit = associated?.head.sha ?? expected.commit;
  assert(
    commit === pull.head.sha &&
      String(run.head_repository.id) === String(pull.head.repo.id) &&
      run.head_repository.full_name === pull.head.repo.full_name &&
      (!associated ||
        (associated.number === pull.number &&
          String(associated.head.repo.id) === String(pull.head.repo.id))) &&
      (expected.pr === undefined || Number(expected.pr) === pull.number) &&
      [pull.head.sha, pull.merge_commit_sha].includes(run.head_sha),
    "Build run PR or current exact head differs",
  );
  return {
    schemaVersion: "1",
    pr: pull.number,
    commit,
    runId: Number(run.id),
    attempt: Number(run.run_attempt),
    workflowId: Number(run.workflow_id),
    headRepository: pull.head.repo.full_name,
    headRepositoryId: String(pull.head.repo.id),
    tag: `pr-${pull.number}`,
    artifactName: `web-preview-${run.id}-${run.run_attempt}`,
  };
}
export function validateImage(image, metadata) {
  assert(
    digest(metadata.imageId) &&
      image?.Id === metadata.imageId &&
      image.Os === "linux" &&
      image.Architecture === "amd64" &&
      image.Config?.Labels?.["org.opencontainers.image.revision"] ===
        metadata.commit &&
      image.Config.Labels["org.opencontainers.image.version"] ===
        metadata.version,
    "Image ID, platform or release labels differ",
  );
}
const routes = (service) =>
  (service.status?.traffic ?? [])
    .filter((item) => item.percent > 0)
    .map(({ revisionName, percent }) => ({ revisionName, percent }))
    .sort((a, b) => (a.revisionName < b.revisionName ? -1 : 1));
const tags = (service, except) =>
  (service.status?.traffic ?? [])
    .filter((item) => item.tag && item.tag !== except)
    .map(({ tag, revisionName, url }) => ({ tag, revisionName, url }))
    .sort((a, b) => (a.tag < b.tag ? -1 : 1));
export function verifyRouting(before, after, tag) {
  assert(
    canonical(routes(before)) === canonical(routes(after)) &&
      canonical(tags(before, tag)) === canonical(tags(after, tag)),
    "Baseline traffic or unrelated preview tags changed",
  );
}
export function cleanupCandidates(service, revisions, pr) {
  assert(integer(pr), "Invalid cleanup PR");
  const used = new Set(
    (service.status?.traffic ?? [])
      .filter((item) => item.percent > 0 || item.tag)
      .map((item) => item.revisionName),
  );
  return revisions.filter(
    (revision) =>
      new RegExp(
        `^${PREVIEW.service}-pr-${pr}-[1-9][0-9]*-[1-9][0-9]*$|^${PREVIEW.service}-pr-${pr}-[1-9][0-9]*$`,
      ).test(revision.metadata?.name ?? "") &&
      revision.metadata.labels?.["serving.knative.dev/service"] ===
        PREVIEW.service &&
      revision.metadata.labels?.["unmask-preview-owner"] === "github" &&
      revision.metadata.labels?.["unmask-preview-pr"] === String(pr) &&
      revision.metadata.name !== service.status?.latestCreatedRevisionName &&
      !used.has(revision.metadata.name),
  );
}
function assertRuntime(spec, annotations = {}) {
  const container = spec?.containers?.[0];
  assert(
    spec?.containers?.length === 1 &&
      spec.serviceAccountName === PREVIEW.runtimeSA &&
      ["1", "1000m"].includes(container?.resources?.limits?.cpu) &&
      container.resources.limits.memory === "512Mi" &&
      canonical(container.env) ===
        canonical([{ name: "UNMASK_API_URL", value: PREVIEW.apiURL }]) &&
      !spec.volumes?.length &&
      annotations["run.googleapis.com/cpu-throttling"] !== "false" &&
      (annotations["autoscaling.knative.dev/minScale"] ?? "0") === "0",
    "Preview runtime identity, environment, secrets, resources or request CPU differs",
  );
}
function assertService(service) {
  assert(
    service?.metadata?.name === PREVIEW.service &&
      service.status?.conditions?.some(
        (item) => item.type === "Ready" && item.status === "True",
      ) &&
      routes(service).reduce((sum, item) => sum + item.percent, 0) === 100 &&
      !(service.spec?.traffic ?? []).some(
        (item) => item.percent > 0 && item.latestRevision,
      ),
    "Dedicated preview service requires ready fixed baseline traffic",
  );
  assertRuntime(
    service.spec.template.spec,
    service.spec.template.metadata?.annotations,
  );
  assert(
    (service.metadata.annotations?.["run.googleapis.com/maxScale"] ??
      service.spec.template.metadata?.annotations?.[
        "autoscaling.knative.dev/maxScale"
      ]) === "1" &&
      (service.metadata.annotations?.["run.googleapis.com/minScale"] ?? "0") ===
        "0",
    "Preview min/max scaling differs",
  );
}
function origin(value) {
  const url = new URL(value);
  assert(
    url.protocol === "https:" &&
      url.hostname.endsWith(".run.app") &&
      !url.port &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash,
    "Preview URL must be an observed Cloud Run HTTPS origin",
  );
  return url.origin;
}
async function boundedJSON(response, cap = 4194304, expectedStatus = 200) {
  assert(response.status === expectedStatus, "Preview API request failed");
  const reader = response.body?.getReader();
  assert(reader, "Missing API response");
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      assert(size <= cap, "Preview API response exceeds cap");
      chunks.push(value);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
}
export function githubAPI({ token, fetchImpl = globalThis.fetch }) {
  return async (route, options = {}) => {
    const method = options.method ?? "GET";
    const baseRoute = route.startsWith(`/repos/${PREVIEW.repository}/`);
    const forkContent =
      /^\/repos\/(?:Pranay0083\/unmask|visheshrao17\/unmask)\/contents\/package\.json\?ref=[a-f0-9]{40}$/u.test(
        route,
      ) && !/\s/u.test(route);
    const commentWrite =
      method === "POST"
        ? /^\/repos\/Vaiditya2207\/unmask\/issues\/[1-9][0-9]*\/comments$/u.test(
            route,
          )
        : method === "PATCH" &&
          /^\/repos\/Vaiditya2207\/unmask\/issues\/comments\/[1-9][0-9]*$/u.test(
            route,
          );
    assert(
      (method === "GET" ? baseRoute || forkContent : commentWrite) &&
        !route.includes(".."),
      "Unexpected GitHub API route or method",
    );
    if (method !== "GET")
      assert(
        options.body &&
          Object.keys(options.body).length === 1 &&
          typeof options.body.body === "string" &&
          Buffer.byteLength(options.body.body) <= 16000,
        "Invalid preview comment body",
      );
    for (let attempt = 0; attempt < (method === "GET" ? 2 : 1); attempt++) {
      let response;
      try {
        response = await fetchImpl(`https://api.github.com${route}`, {
          method,
          redirect: "error",
          signal: AbortSignal.timeout(30000),
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token}`,
            "x-github-api-version": "2022-11-28",
            connection: "close",
            ...(method === "GET" ? {} : { "content-type": "application/json" }),
          },
          ...(method === "GET" ? {} : { body: JSON.stringify(options.body) }),
        });
        return await boundedJSON(
          response,
          4194304,
          method === "POST" ? 201 : 200,
        );
      } catch (caught) {
        const error =
          caught instanceof Error
            ? caught
            : new Error("Preview GitHub request failed");
        if (method !== "GET") {
          response?.body?.cancel().catch(() => {});
          error.previewWriteUncertain =
            !response || response.status < 400 || response.status >= 500;
          throw error;
        }
        if (
          attempt !== 0 ||
          !["UND_ERR_SOCKET", "ECONNRESET", "EPIPE"].includes(
            error?.cause?.code,
          )
        )
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  };
}
export const PREVIEW_COMMENT_MARKER = "<!-- unmask:web-preview:v1 -->";
export async function upsertPreviewComment({ receipt, runId, api }) {
  assert(
    receipt?.status === "verified" &&
      receipt.service === PREVIEW.service &&
      integer(receipt.pr) &&
      sha(receipt.commit) &&
      version(receipt.version) &&
      !/\s/u.test(receipt.version) &&
      integer(runId) &&
      /^[1-9][0-9]*$/u.test(String(runId)),
    "Comment requires verified deployment identity",
  );
  const url = origin(receipt.url);
  assert(
    new URL(url).hostname.startsWith(`pr-${receipt.pr}---${PREVIEW.service}-`),
    "Comment URL is not the exact PR preview service tag",
  );
  const base = `/repos/${PREVIEW.repository}`;
  const issueURL = `https://api.github.com${base}/issues/${receipt.pr}`;
  const owned = (item) =>
    integer(item?.id) &&
    item.user?.login === "github-actions[bot]" &&
    item.user.type === "Bot" &&
    typeof item.body === "string" &&
    item.body.startsWith(PREVIEW_COMMENT_MARKER + "\n") &&
    (item.issue_url === undefined || item.issue_url === issueURL);
  const current = async () => {
    const pull = validatePull(await api(`${base}/pulls/${receipt.pr}`));
    assert(
      pull.number === receipt.pr && pull.head.sha === receipt.commit,
      "Comment tested head is stale",
    );
  };
  await current();
  const matches = [];
  for (let page = 1; page <= 5; page++) {
    const comments = await api(
      `${base}/issues/${receipt.pr}/comments?per_page=100&page=${page}`,
    );
    assert(
      Array.isArray(comments) && comments.length <= 100,
      "Invalid PR comment listing",
    );
    matches.push(...comments.filter(owned));
    if (comments.length < 100) break;
    assert(page < 5, "Preview comment pagination limit reached");
  }
  assert(matches.length <= 1, "Ambiguous owned preview comments");
  const body = `${PREVIEW_COMMENT_MARKER}\n**Frontend preview:** [Open preview](${url})\n\nTested commit: \`${receipt.commit}\`\n\nVersion: \`${receipt.version}\`\n\n[Verified deployment run](https://github.com/${PREVIEW.repository}/actions/runs/${runId})`;
  const existing = matches[0];
  if (existing)
    assert(
      owned(await api(`${base}/issues/comments/${existing.id}`)),
      "Preview comment ownership changed",
    );
  await current();
  if (existing?.body === body)
    return { status: "unchanged", commentId: existing.id };
  const operation = existing ? "update" : "create";
  try {
    const result = await api(
      existing
        ? `${base}/issues/comments/${existing.id}`
        : `${base}/issues/${receipt.pr}/comments`,
      { method: existing ? "PATCH" : "POST", body: { body } },
    );
    if (
      !owned(result) ||
      result.body !== body ||
      (existing && result.id !== existing.id)
    )
      return { status: "uncertain", operation };
    return { status: existing ? "updated" : "created", commentId: result.id };
  } catch (error) {
    return {
      status: error?.previewWriteUncertain ? "uncertain" : "failed",
      operation,
    };
  }
}
export async function preparePreview({ event, api, metadata }) {
  const trigger = event.workflow_run;
  assert(
    event.action === "completed" &&
      integer(trigger?.id) &&
      integer(trigger.run_attempt),
    "Expected completed build run event",
  );
  const run = await api(
    `/repos/${PREVIEW.repository}/actions/runs/${trigger.id}`,
  );
  const workflow = await api(
    `/repos/${PREVIEW.repository}/actions/workflows/web-preview-build.yml`,
  );
  assert(
    workflow.path === ".github/workflows/web-preview-build.yml" &&
      workflow.state === "active",
    "Build workflow identity differs",
  );
  const expected = {
    workflowId: workflow.id,
    runId: trigger.id,
    attempt: trigger.run_attempt,
  };
  validateRunIdentity(run, expected);
  let plan = {
    schemaVersion: "1",
    runId: Number(run.id),
    attempt: Number(run.run_attempt),
    workflowId: Number(workflow.id),
    runHead: run.head_sha,
    headRepository: run.head_repository.full_name,
    headRepositoryId: String(run.head_repository.id),
    artifactName: `web-preview-${run.id}-${run.run_attempt}`,
  };
  if (metadata) {
    assert(
      integer(metadata.pr) &&
        sha(metadata.commit) &&
        metadata.headRepository === plan.headRepository &&
        String(metadata.headRepositoryId) === plan.headRepositoryId,
      "Artifact head repository or PR identity differs",
    );
    const pull = await api(`/repos/${PREVIEW.repository}/pulls/${metadata.pr}`);
    plan = validateBuildRun(run, pull, {
      ...expected,
      commit: metadata.commit,
      pr: metadata.pr,
    });
    const content = await api(
      `/repos/${plan.headRepository}/contents/package.json?ref=${plan.commit}`,
    );
    assert(
      content.encoding === "base64" && content.size <= 65536,
      "Package version source exceeds bound",
    );
    plan.version = JSON.parse(
      Buffer.from(content.content, "base64").toString("utf8"),
    ).version;
    assert(version(plan.version), "Invalid root package version");
  }
  const artifacts = await api(
    `/repos/${PREVIEW.repository}/actions/runs/${plan.runId}/artifacts?per_page=100`,
  );
  assert(artifacts.total_count <= 100, "Artifact listing exceeds bound");
  const matches = artifacts.artifacts.filter(
    (item) => item.name === plan.artifactName,
  );
  assert(
    matches.length === 1 &&
      integer(matches[0].id) &&
      matches[0].expired === false &&
      matches[0].size_in_bytes > 0 &&
      matches[0].size_in_bytes <= ARTIFACT_LIMITS.imageBytes + 32768 &&
      Number(matches[0].workflow_run?.id) === plan.runId,
    "Exact unexpired build artifact missing or exceeds bound",
  );
  plan.artifactId = matches[0].id;
  return plan;
}
async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
export async function validateArtifact(directory, plan) {
  const names = readdirSync(directory).sort();
  assert(
    canonical(names) === canonical(["SHA256SUMS", "image.tar", "preview.json"]),
    "Artifact must contain exactly three expected files",
  );
  for (const name of names) {
    const stat = lstatSync(path.join(directory, name));
    assert(
      stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.nlink === 1 &&
        stat.size > 0 &&
        stat.size <=
          (name === "image.tar"
            ? ARTIFACT_LIMITS.imageBytes
            : name === "preview.json"
              ? ARTIFACT_LIMITS.metadataBytes
              : 512),
      "Artifact file type, size or hard links rejected",
    );
  }
  const metadata = JSON.parse(
    readFileSync(path.join(directory, "preview.json"), "utf8"),
  );
  assert(
    metadata.schemaVersion === "1" &&
      metadata.repository === PREVIEW.repository &&
      metadata.headRepository === plan.headRepository &&
      String(metadata.headRepositoryId) === plan.headRepositoryId &&
      metadata.commit === plan.commit &&
      metadata.version === plan.version &&
      Number(metadata.pr) === plan.pr &&
      Number(metadata.runId) === plan.runId &&
      Number(metadata.attempt) === plan.attempt &&
      digest(metadata.imageId),
    "Artifact identity differs from current exact build",
  );
  const imageHash = await hashFile(path.join(directory, "image.tar"));
  const metadataHash = await hashFile(path.join(directory, "preview.json"));
  assert(
    readFileSync(path.join(directory, "SHA256SUMS"), "utf8") ===
      `${imageHash}  image.tar\n${metadataHash}  preview.json\n` &&
      metadata.imageSha256 === imageHash,
    "Artifact checksum mismatch",
  );
  const extract = tar.extract();
  let entries = 0,
    manifest;
  const archiveFiles = new Map();
  const descriptorJSON = new Map();
  extract.on("entry", (header, stream, next) => {
    stream.on("error", () => {});
    const name = header.name.replace(/\/$/u, "");
    if (
      ++entries > ARTIFACT_LIMITS.entries ||
      !["file", "directory"].includes(header.type) ||
      !name ||
      name.startsWith("/") ||
      /[\\\0]/u.test(name) ||
      name.split("/").some((part) => !part || part === "." || part === "..") ||
      header.size > ARTIFACT_LIMITS.imageBytes
    ) {
      stream.resume();
      extract.destroy(new Error("Unsafe image archive entry"));
      return;
    }
    const chunks = [];
    let size = 0;
    const fileHash = createHash("sha256");
    stream.on("data", (chunk) => {
      fileHash.update(chunk);
      if (
        header.name === "manifest.json" ||
        (header.size <= 16384 &&
          (name === "index.json" ||
            /^blobs\/sha256\/[a-f0-9]{64}$/u.test(name)))
      ) {
        size += chunk.length;
        if (size > 16384)
          extract.destroy(new Error("Image manifest too large"));
        else chunks.push(chunk);
      }
    });
    stream.on("end", () => {
      if (header.type === "file") {
        if (archiveFiles.has(name))
          extract.destroy(new Error("Duplicate image archive file"));
        else archiveFiles.set(name, fileHash.digest("hex"));
      }
      if (header.type === "file" && name !== "manifest.json" && chunks.length) {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (value?.schemaVersion === 2 && (value.manifests || value.config)) {
            if (descriptorJSON.size >= 128)
              extract.destroy(new Error("OCI descriptor limit exceeded"));
            else descriptorJSON.set(name, value);
          }
        } catch {}
      }
      if (header.name === "manifest.json") {
        if (manifest !== undefined)
          extract.destroy(new Error("Duplicate image manifest"));
        else {
          try {
            manifest = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            extract.destroy(new Error("Invalid image manifest"));
          }
        }
      }
      next();
    });
    stream.resume();
  });
  await new Promise((resolve, reject) => {
    const input = createReadStream(path.join(directory, "image.tar"));
    input.on("error", reject);
    extract.on("error", (error) => {
      input.destroy();
      reject(error);
    });
    extract.on("finish", resolve);
    input.pipe(extract);
  });
  assert(
    Array.isArray(manifest) &&
      manifest.length === 1 &&
      canonical(manifest[0].RepoTags) ===
        canonical([`unmask-web-preview-build:${plan.commit}`]),
    "Image archive must contain exactly the expected tagged image",
  );
  assert(
    typeof manifest[0].Config === "string" &&
      archiveFiles.has(manifest[0].Config) &&
      Array.isArray(manifest[0].Layers) &&
      manifest[0].Layers.every(
        (name) => typeof name === "string" && archiveFiles.has(name),
      ),
    "Image archive config or layer references differ",
  );
  const configDigest = `sha256:${archiveFiles.get(manifest[0].Config)}`;
  if (configDigest !== metadata.imageId) {
    const index = descriptorJSON.get("index.json");
    assert(
      index?.manifests?.length === 1 &&
        index.manifests[0].digest === metadata.imageId,
      "OCI top-level image identity differs",
    );
    const rootName = `blobs/sha256/${metadata.imageId.slice(7)}`;
    assert(
      archiveFiles.get(rootName) === metadata.imageId.slice(7),
      "OCI root descriptor digest differs",
    );
    const root = descriptorJSON.get(rootName);
    let selected = root;
    let runtimeDigest = metadata.imageId;
    if (Array.isArray(root?.manifests)) {
      const runtime = root.manifests.filter(
        (item) =>
          item.platform?.os === "linux" &&
          item.platform?.architecture === "amd64",
      );
      assert(
        runtime.length === 1 &&
          root.manifests.every(
            (item) =>
              item === runtime[0] ||
              (item.platform?.os === "unknown" &&
                item.platform?.architecture === "unknown" &&
                item.annotations?.["vnd.docker.reference.type"] ===
                  "attestation-manifest"),
          ),
        "OCI image must contain one linux amd64 runtime manifest",
      );
      runtimeDigest = runtime[0].digest;
      assert(digest(runtimeDigest), "Invalid OCI runtime digest");
      const name = `blobs/sha256/${runtimeDigest.slice(7)}`;
      assert(
        archiveFiles.get(name) === runtimeDigest.slice(7),
        "OCI runtime manifest digest differs",
      );
      selected = descriptorJSON.get(name);
    }
    assert(
      selected?.config?.digest === configDigest &&
        Array.isArray(selected.layers) &&
        canonical(selected.layers.map((item) => item.digest)) ===
          canonical(
            manifest[0].Layers.map(
              (name) => `sha256:${archiveFiles.get(name)}`,
            ),
          ),
      "OCI runtime config or layers differ from Docker manifest",
    );
    return { ...metadata, runtimeManifestDigest: runtimeDigest };
  }
  return metadata;
}
function commandRunner(execute) {
  return (binary, args) => {
    try {
      return String(
        execute(binary, args, {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          maxBuffer: 4194304,
          timeout: binary === "docker" ? 600000 : 120000,
        }),
      );
    } catch {
      throw new Error(
        `Preview ${binary} command failed; raw output suppressed`,
      );
    }
  };
}
const suffix = [
  "--project",
  PREVIEW.project,
  "--region",
  PREVIEW.region,
  "--quiet",
  "--format=json",
];
export async function mutatePreview({
  mode,
  event,
  plan,
  metadata,
  api,
  execute = execFileSync,
  fetchImpl = globalThis.fetch,
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  assert(["deploy", "cleanup"].includes(mode), "Unknown preview mutation mode");
  const command = commandRunner(execute);
  const json = (args) => JSON.parse(command("gcloud", args));
  const describe = () =>
    json(["run", "services", "describe", PREVIEW.service, ...suffix]);
  assert(
    command("gcloud", [
      "auth",
      "list",
      "--filter=status:ACTIVE",
      "--format=value(account)",
    ]).trim() === PREVIEW.deploySA,
    "Preview deploy service account differs",
  );
  const before = describe();
  assertService(before);
  const pr = mode === "deploy" ? plan.pr : event.pull_request?.number;
  async function current() {
    const pull = validatePull(
      await api(`/repos/${PREVIEW.repository}/pulls/${pr}`),
      mode === "deploy" ? "open" : "closed",
    );
    if (mode === "deploy")
      assert(pull.head.sha === plan.commit, "Stale preview head");
    return pull;
  }
  await current();
  if (mode === "cleanup") {
    assert(
      event.action === "closed" &&
        event.number === pr &&
        allowedHead(event.pull_request?.head?.repo) &&
        repository(event.pull_request?.base?.repo),
      "Cleanup requires exact closed allowlisted-head PR event",
    );
    const tag = `pr-${pr}`;
    if (before.status.traffic.some((item) => item.tag === tag)) {
      await current();
      command("gcloud", [
        "run",
        "services",
        "update-traffic",
        PREVIEW.service,
        "--remove-tags",
        tag,
        ...suffix,
      ]);
    }
    let after = describe();
    verifyRouting(before, after, tag);
    assert(
      !after.status.traffic.some((item) => item.tag === tag),
      "Closed PR tag remains",
    );
    const revisions = json([
      "run",
      "revisions",
      "list",
      "--service",
      PREVIEW.service,
      ...suffix,
    ]);
    const removed = [];
    for (const candidate of cleanupCandidates(after, revisions, pr)) {
      await current();
      after = describe();
      verifyRouting(before, after, tag);
      const revision = json([
        "run",
        "revisions",
        "describe",
        candidate.metadata.name,
        ...suffix,
      ]);
      if (cleanupCandidates(after, [revision], pr).length !== 1) continue;
      assertRuntime(revision.spec, revision.metadata.annotations);
      assert(
        revision.spec.containers[0].image.startsWith(
          `${PREVIEW.image}@sha256:`,
        ),
        "Cleanup image is not preview-owned",
      );
      command("gcloud", [
        "run",
        "revisions",
        "delete",
        revision.metadata.name,
        ...suffix,
      ]);
      removed.push(revision.metadata.name);
    }
    verifyRouting(before, describe(), tag);
    return { status: "cleaned", service: PREVIEW.service, pr, removed };
  }
  assert(
    metadata &&
      metadata.commit === plan.commit &&
      metadata.version === plan.version,
    "Verified image metadata missing",
  );
  command("gcloud", [
    "auth",
    "configure-docker",
    `${PREVIEW.region}-docker.pkg.dev`,
    "--quiet",
  ]);
  const imageTag = `${PREVIEW.image}:pr-${pr}-${plan.runId}-${plan.attempt}`;
  command("docker", ["tag", metadata.imageId, imageTag]);
  await current();
  command("docker", ["push", imageTag]);
  const imageResult = json([
    "artifacts",
    "docker",
    "images",
    "describe",
    imageTag,
    "--project",
    PREVIEW.project,
    "--format=json",
  ]);
  const imageDigest = imageResult.image_summary?.digest;
  assert(digest(imageDigest), "Preview pushed image digest missing");
  const image = `${PREVIEW.image}@${imageDigest}`;
  const revisionName = `${PREVIEW.service}-pr-${pr}-${plan.runId}-${plan.attempt}`;
  assert(revisionName.length <= 63, "Preview revision name exceeds limit");
  const unchanged = describe();
  verifyRouting(before, unchanged, plan.tag);
  await current();
  command("gcloud", [
    "run",
    "services",
    "update",
    PREVIEW.service,
    "--image",
    image,
    "--revision-suffix",
    `pr-${pr}-${plan.runId}-${plan.attempt}`,
    "--no-traffic",
    "--tag",
    plan.tag,
    "--service-account",
    PREVIEW.runtimeSA,
    "--cpu",
    "1",
    "--memory",
    "512Mi",
    "--min",
    "0",
    "--max",
    "1",
    "--cpu-throttling",
    "--set-env-vars",
    `UNMASK_API_URL=${PREVIEW.apiURL}`,
    "--clear-secrets",
    "--update-labels",
    `unmask-preview-owner=github,unmask-preview-pr=${pr}`,
    ...suffix,
  ]);
  let after;
  for (let attempt = 0; attempt < 40; attempt++) {
    after = describe();
    if (
      after.status?.latestReadyRevisionName === revisionName &&
      after.status?.traffic?.some(
        (item) => item.tag === plan.tag && item.revisionName === revisionName,
      )
    )
      break;
    await pause(3000);
  }
  assertService(after);
  verifyRouting(before, after, plan.tag);
  const target = after.status.traffic.find(
    (item) => item.tag === plan.tag && item.revisionName === revisionName,
  );
  assert(
    target && !(target.percent > 0),
    "Preview tag target is missing or receives baseline traffic",
  );
  const revision = json([
    "run",
    "revisions",
    "describe",
    revisionName,
    ...suffix,
  ]);
  assert(
    cleanupCandidates({ status: { traffic: [] } }, [revision], pr).length === 1,
    "Preview revision ownership labels differ",
  );
  assertRuntime(revision.spec, revision.metadata.annotations);
  assert(
    [
      image,
      ...(metadata.runtimeManifestDigest
        ? [`${PREVIEW.image}@${metadata.runtimeManifestDigest}`]
        : []),
    ].includes(revision.spec.containers[0].image) &&
      [
        imageDigest,
        image,
        metadata.runtimeManifestDigest,
        metadata.runtimeManifestDigest
          ? `${PREVIEW.image}@${metadata.runtimeManifestDigest}`
          : null,
      ]
        .filter(Boolean)
        .includes(revision.status?.imageDigest),
    "Serving preview digest differs",
  );
  const url = origin(target.url);
  const observed = await boundedJSON(
    await fetchImpl(`${url}/version`, {
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    }),
    65536,
  );
  assert(
    observed.commit === plan.commit && observed.version === plan.version,
    "Observed preview /version differs",
  );
  const home = await fetchImpl(`${url}/`, {
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  try {
    assert(home.status === 200, "Preview home did not return 200");
  } finally {
    home.body?.cancel().catch(() => {});
  }
  await current();
  verifyRouting(before, describe(), plan.tag);
  return {
    status: "verified",
    service: PREVIEW.service,
    pr,
    commit: plan.commit,
    version: plan.version,
    revision: revisionName,
    image,
    url,
  };
}
function outputs(values) {
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(values)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
    );
}
async function main() {
  const stage = process.argv[2];
  const mode = stage === "cleanup" ? "cleanup" : "deploy";
  previewContext(process.env, mode);
  const command = commandRunner(execFileSync);
  assert(
    command("git", ["rev-parse", "HEAD"]).trim() ===
      command("git", ["rev-parse", "refs/remotes/origin/main"]).trim(),
    "Privileged tooling checkout is not main",
  );
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const api = githubAPI({ token: process.env.GITHUB_TOKEN });
  const state = process.env.PREVIEW_PLAN;
  if (stage === "prepare") {
    const plan = await preparePreview({ event, api });
    writeFileSync(state, JSON.stringify(plan));
    outputs({
      artifact_id: plan.artifactId,
      run_id: plan.runId,
      project_id: PREVIEW.project,
      service_account: PREVIEW.deploySA,
      workload_identity_provider: PREVIEW.provider,
    });
  } else if (stage === "verify") {
    const plan = JSON.parse(readFileSync(state, "utf8"));
    const fresh = await preparePreview({ event, api });
    assert(canonical(plan) === canonical(fresh), "Preview plan became stale");
    const metadataFile = path.join(
      process.env.PREVIEW_ARTIFACT,
      "preview.json",
    );
    const stat = lstatSync(metadataFile);
    assert(
      stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.nlink === 1 &&
        stat.size <= ARTIFACT_LIMITS.metadataBytes,
      "Unsafe metadata file",
    );
    const input = JSON.parse(readFileSync(metadataFile, "utf8"));
    const fullPlan = await preparePreview({ event, api, metadata: input });
    const metadata = await validateArtifact(
      process.env.PREVIEW_ARTIFACT,
      fullPlan,
    );
    command("docker", [
      "load",
      "--input",
      path.join(process.env.PREVIEW_ARTIFACT, "image.tar"),
    ]);
    const images = JSON.parse(
      command("docker", ["image", "inspect", metadata.imageId]),
    );
    assert(images.length === 1, "Expected exactly one inspected image");
    validateImage(images[0], metadata);
    writeFileSync(
      state,
      JSON.stringify({ ...fullPlan, verified: true, metadata }),
    );
  } else if (stage === "deploy" || stage === "cleanup") {
    let plan, metadata;
    if (stage === "deploy") {
      const saved = JSON.parse(readFileSync(state, "utf8"));
      const { verified, metadata: data, ...original } = saved;
      const fresh = await preparePreview({ event, api, metadata: data });
      assert(
        verified === true && canonical(fresh) === canonical(original),
        "Verified plan differs from current build",
      );
      plan = original;
      metadata = data;
    }
    const result = await mutatePreview({ mode, event, plan, metadata, api });
    if (stage === "deploy")
      writeFileSync(`${state}.deployment.json`, JSON.stringify(result));
    outputs({ url: result.url ?? "", revision: result.revision ?? "" });
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `Frontend preview ${result.status}\n\n${result.url ? `[Open PR preview](${result.url})\n\n` : ""}\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n`,
      );
    console.log(JSON.stringify(result));
  } else if (stage === "comment") {
    let result;
    try {
      const plan = JSON.parse(readFileSync(state, "utf8"));
      const receipt = JSON.parse(
        readFileSync(`${state}.deployment.json`, "utf8"),
      );
      assert(
        plan.verified === true &&
          receipt.pr === plan.pr &&
          receipt.commit === plan.commit &&
          receipt.version === plan.version,
        "Comment receipt differs from verified plan",
      );
      result = await upsertPreviewComment({
        receipt,
        runId: process.env.GITHUB_RUN_ID,
        api,
      });
    } catch {
      result = {
        status: "failed",
        reason: "comment-precondition-or-read-failed",
      };
    }
    outputs({
      comment_status: result.status,
      comment_id: result.commentId ?? "",
    });
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `\nPreview PR comment: ${result.status}. Deployment verification is reported separately.\n`,
      );
    if (!["created", "updated", "unchanged"].includes(result.status))
      process.exitCode = 1;
    console.log(JSON.stringify({ previewComment: result }));
  } else
    throw new Error(
      "Usage: web-preview.mjs prepare|verify|deploy|comment|cleanup",
    );
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
