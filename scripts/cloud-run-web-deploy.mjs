import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const project = "unmask-513319";
const region = "asia-south1";
const serviceName = "unmask-web";
const repository = `${region}-docker.pkg.dev/${project}/unmask/web`;
const apiURL = "https://unmask-386156642190.asia-south1.run.app";
const runtimeSA = `unmask-web@${project}.iam.gserviceaccount.com`;
const deploySA = `unmask-github-deploy@${project}.iam.gserviceaccount.com`;
const provider =
  "projects/386156642190/locations/global/workloadIdentityPools/unmask-github/providers/github";
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const canonical = (value) =>
  JSON.stringify(value, (_, item) =>
    item && !Array.isArray(item) && typeof item === "object"
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : item,
  );
const isReady = (value) =>
  value?.status?.conditions?.some(
    (c) => c.type === "Ready" && c.status === "True",
  );
function routes(value) {
  const totals = new Map();
  for (const t of value.status?.traffic ?? [])
    if (t.percent > 0)
      totals.set(t.revisionName, (totals.get(t.revisionName) ?? 0) + t.percent);
  return [...totals]
    .map(([revisionName, percent]) => ({ revisionName, percent }))
    .sort((a, b) =>
      a.revisionName < b.revisionName
        ? -1
        : a.revisionName > b.revisionName
          ? 1
          : 0,
    );
}
function assertRuntime(spec) {
  const c = spec?.containers?.[0];
  if (
    spec?.containers?.length !== 1 ||
    spec.serviceAccountName !== runtimeSA ||
    !["1", "1000m"].includes(c?.resources?.limits?.cpu) ||
    c.resources.limits.memory !== "512Mi" ||
    canonical(c.env) !== canonical([{ name: "UNMASK_API_URL", value: apiURL }])
  )
    throw new Error(
      "Web runtime SA, environment or 1CPU/512Mi configuration differs",
    );
}
function fingerprint(service) {
  const copy = structuredClone({
    annotations: service.metadata?.annotations ?? {},
    template: service.spec?.template,
  });
  for (const annotations of [
    copy.annotations,
    copy.template?.metadata?.annotations ?? {},
  ])
    for (const key of [
      "run.googleapis.com/client-name",
      "run.googleapis.com/client-version",
      "run.googleapis.com/operation-id",
      "serving.knative.dev/lastModifier",
    ])
      delete annotations[key];
  delete copy.annotations["run.googleapis.com/urls"];
  if (copy.template?.metadata?.labels)
    delete copy.template.metadata.labels["client.knative.dev/nonce"];
  for (const c of copy.template?.spec?.containers ?? []) delete c.image;
  return canonical(copy);
}
function origin(value) {
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    !u.hostname.endsWith(".run.app") ||
    u.port ||
    u.username ||
    u.password ||
    u.pathname !== "/" ||
    u.search ||
    u.hash
  )
    throw new Error("Observed web URL is not a Cloud Run HTTPS origin");
  return u.origin;
}
export function webInputs(env = process.env) {
  if (
    env.GITHUB_EVENT_NAME !== "push" ||
    env.GITHUB_REF !== "refs/heads/main" ||
    env.DEPLOY_ENVIRONMENT !== "production" ||
    env.DEPLOY_REPOSITORY_ID !== "1440901935" ||
    env.DEPLOY_OWNER_ID !== "145288107" ||
    env.GITHUB_REPOSITORY !== "Vaiditya2207/unmask" ||
    env.GITHUB_WORKFLOW_REF !==
      `${env.GITHUB_REPOSITORY}/.github/workflows/release.yml@refs/heads/main` ||
    env.RELEASE_COMPLETE !== "true" ||
    env.RELEASE_NPM_PUBLISHED !== "true" ||
    !/^[a-f0-9]{40}$/.test(env.RELEASE_COMMIT ?? "") ||
    env.GITHUB_SHA !== env.RELEASE_COMMIT ||
    !/^[1-9][0-9]{0,19}$/.test(env.GITHUB_RUN_ID ?? "") ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(
      env.RELEASE_VERSION ?? "",
    ) ||
    env.RELEASE_VERSION === "0.0.0"
  )
    throw new Error(
      "Web deployment requires the exact completed main release and production identity",
    );
  return {
    commit: env.RELEASE_COMMIT,
    version: env.RELEASE_VERSION,
    imageTag: `${repository}:sha-${env.RELEASE_COMMIT}`,
    tag: `web-${env.RELEASE_COMMIT.slice(0, 12)}-${env.GITHUB_RUN_ID}`,
  };
}
export async function smokeWeb({
  baseURL,
  commit,
  version,
  full,
  fetchImpl = globalThis.fetch,
}) {
  const base = origin(baseURL);
  const deadline = Date.now() + 60000;
  async function request(route, options = {}) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Web smoke deadline exceeded");
    const response = await fetchImpl(new URL(route, base).href, {
      ...options,
      redirect: "manual",
      signal: AbortSignal.timeout(Math.min(20000, remaining)),
    });
    const reader = response.body?.getReader();
    if (!reader) return { response, text: "" };
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 4194304)
          throw new Error("Web smoke response exceeds byte limit");
        chunks.push(value);
      }
    } finally {
      reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    return { response, text: Buffer.concat(chunks, size).toString("utf8") };
  }
  const versionResponse = await request("/version");
  const observed = JSON.parse(versionResponse.text);
  if (
    versionResponse.response.status !== 200 ||
    observed.commit !== commit ||
    observed.version !== version
  )
    throw new Error("Web release version/commit differs");
  if (!full) return { status: "passed" };
  const home = await request("/");
  if (
    home.response.status !== 200 ||
    !/<form\b[^>]*action=["']\/check["']/i.test(home.text) ||
    !/name=["']package["']/.test(home.text)
  )
    throw new Error("Web home does not expose the normal package form");
  const submitted = await request("/check", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ package: "is-number@7.0.0" }).toString(),
  });
  const target = new URL(
    submitted.response.headers.get("location") ?? "/",
    base,
  );
  if (
    submitted.response.status !== 303 ||
    target.origin !== base ||
    !/^\/r\/[a-f0-9]{32}$/.test(target.pathname) ||
    target.search ||
    target.hash
  )
    throw new Error("Web normal POST did not link a backend job");
  const id = target.pathname.split("/").at(-1);
  const linked = await request(`/api/reports/${id}`);
  const body = JSON.parse(linked.text);
  const spec =
    body.nameAtExactVersion ??
    `${body.inputs?.claim?.name}@${body.inputs?.claim?.version}`;
  if (
    ![200, 202].includes(linked.response.status) ||
    spec !== "is-number@7.0.0" ||
    (body.id !== undefined && body.id !== id) ||
    (!body.schemaVersion &&
      !["queued", "running", "completed"].includes(body.status))
  )
    throw new Error("Web report proxy did not preserve backend job identity");
  return { status: "passed", reportPath: target.pathname };
}
export async function deployWeb({
  env = process.env,
  execute = execFileSync,
  fetchImpl = globalThis.fetch,
  smoke = smokeWeb,
  pause: wait = pause,
  source,
  root = process.cwd(),
} = {}) {
  const input = webInputs(env);
  const deadline = Date.now() + 900000;
  function command(binary, args) {
    if (Date.now() >= deadline)
      throw new Error("Web deployment deadline exceeded");
    try {
      return String(
        execute(binary, args, {
          cwd: root,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          maxBuffer: 4194304,
          timeout: Math.max(
            1,
            Math.min(
              binary === "docker" ? 600000 : 120000,
              deadline - Date.now(),
            ),
          ),
        }),
      );
    } catch {
      throw new Error(
        `Web deployment ${binary} command failed; raw output suppressed`,
      );
    }
  }
  function output(binary, args) {
    try {
      return JSON.parse(command(binary, args));
    } catch {
      throw new Error(
        `Web deployment ${binary} observation failed; raw output suppressed`,
      );
    }
  }
  const json = (args) => output("gcloud", args);
  if (
    command("git", ["rev-parse", "HEAD"]).trim() !== input.commit ||
    command("git", ["status", "--porcelain", "--untracked-files=all"]).trim()
  )
    throw new Error("Web build requires a clean exact release checkout");
  source ??= {
    version: JSON.parse(readFileSync(path.join(root, "package.json"))).version,
    dockerfile: [
      "web/Dockerfile",
      "web/.dockerignore",
      "web/package-lock.json",
      "web/app/version/route.ts",
    ].every((file) => existsSync(path.join(root, file))),
  };
  if (source.version !== input.version || source.dockerfile !== true)
    throw new Error(
      "Web release source version or standalone Docker/version dependency missing",
    );
  command("gcloud", [
    "auth",
    "configure-docker",
    `${region}-docker.pkg.dev`,
    "--quiet",
  ]);
  command("docker", [
    "build",
    "--platform",
    "linux/amd64",
    "--build-arg",
    `RELEASE_COMMIT=${input.commit}`,
    "--build-arg",
    `RELEASE_VERSION=${input.version}`,
    "--label",
    `org.opencontainers.image.revision=${input.commit}`,
    "--label",
    `org.opencontainers.image.version=${input.version}`,
    "--tag",
    input.imageTag,
    "--file",
    "web/Dockerfile",
    "web",
  ]);
  function inspect() {
    return output("docker", ["image", "inspect", input.imageTag])[0];
  }
  const built = inspect();
  if (
    built?.Config?.Labels?.["org.opencontainers.image.revision"] !==
      input.commit ||
    built?.Config?.Labels?.["org.opencontainers.image.version"] !==
      input.version
  )
    throw new Error("Built web image release labels differ");
  command("docker", ["push", input.imageTag]);
  const remote = json([
    "artifacts",
    "docker",
    "images",
    "describe",
    input.imageTag,
    "--project",
    project,
    "--format=json",
  ]);
  const digest = remote.image_summary?.digest;
  const image = `${repository}@${digest}`;
  const pushed = inspect();
  if (
    !digestPattern.test(digest ?? "") ||
    pushed.Id !== built.Id ||
    !pushed.RepoDigests?.includes(image)
  )
    throw new Error(
      "Resolved GAR digest is not the exact locally built and pushed web image",
    );
  const raw = command("docker", [
    "buildx",
    "imagetools",
    "inspect",
    "--raw",
    image,
  ]);
  const manifestBytes = [raw, raw.replace(/\n$/, "")].find(
    (value) =>
      `sha256:${createHash("sha256").update(value).digest("hex")}` === digest,
  );
  if (manifestBytes === undefined)
    throw new Error("Pushed web manifest bytes do not match the GAR digest");
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes);
  } catch {
    throw new Error("Pushed web manifest is not valid JSON");
  }
  const imageTypes = [
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
  ];
  const indexTypes = [
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
  ];
  let resolvedDigest = digest;
  if (manifest.schemaVersion !== 2)
    throw new Error("Unsupported web manifest schema");
  if (indexTypes.includes(manifest.mediaType)) {
    const children = Array.isArray(manifest.manifests)
      ? manifest.manifests.filter(
          (item) =>
            item.platform?.os === "linux" &&
            item.platform?.architecture === "amd64",
        )
      : [];
    if (
      children.length !== 1 ||
      !imageTypes.includes(children[0].mediaType) ||
      !digestPattern.test(children[0].digest ?? "")
    )
      throw new Error("Web index must bind exactly one Linux AMD64 image");
    resolvedDigest = children[0].digest;
  } else if (!imageTypes.includes(manifest.mediaType))
    throw new Error("Unsupported web manifest media type");
  const resolvedImageDigest = `${repository}@${resolvedDigest}`;
  const suffix = ["--project", project, "--region", region, "--format=json"];
  const describe = () =>
    json(["run", "services", "describe", serviceName, ...suffix]);
  const before = describe();
  assertRuntime(before.spec?.template?.spec);
  const annotations = before.spec.template.metadata?.annotations ?? {};
  const min =
    before.metadata?.annotations?.["run.googleapis.com/minScale"] ??
    annotations["autoscaling.knative.dev/minScale"] ??
    "0";
  const max =
    before.metadata?.annotations?.["run.googleapis.com/maxScale"] ??
    annotations["autoscaling.knative.dev/maxScale"];
  if (
    before.metadata?.name !== serviceName ||
    !isReady(before) ||
    min !== "0" ||
    max !== "1" ||
    (annotations["run.googleapis.com/cpu-throttling"] ?? "true") !== "true"
  )
    throw new Error(
      "Web service must be ready with request CPU and min 0/max 1",
    );
  const previous = routes(before),
    preserved = fingerprint(before),
    publicURL = origin(before.status.url);
  if (
    !previous.length ||
    previous.reduce((n, t) => n + t.percent, 0) !== 100 ||
    previous.some(
      (t) =>
        !/^unmask-web-[a-z0-9-]+$/.test(t.revisionName ?? "") ||
        !Number.isInteger(t.percent),
    )
  )
    throw new Error(
      "Previous web traffic cannot be restored to explicit revisions",
    );
  const updated = json([
    "run",
    "services",
    "update",
    serviceName,
    "--image",
    image,
    "--no-traffic",
    "--tag",
    input.tag,
    "--quiet",
    ...suffix,
  ]);
  const revisionName = updated.status?.latestCreatedRevisionName;
  if (!/^unmask-web-[a-z0-9-]{1,51}$/.test(revisionName ?? ""))
    throw new Error("Web candidate revision identity unavailable");
  async function until(read, verify) {
    let last;
    for (let i = 0; i < 30; i++) {
      if (Date.now() >= deadline)
        throw new Error("Web deployment deadline exceeded");
      last = read();
      if (verify(last)) return last;
      if (i < 29) await wait(2000);
    }
    throw new Error("Web candidate readiness or traffic verification failed");
  }
  await until(
    () => json(["run", "revisions", "describe", revisionName, ...suffix]),
    (revision) => {
      if (
        !isReady(revision) ||
        revision.metadata?.name !== revisionName ||
        revision.spec?.containers?.[0]?.image !== image ||
        revision.status.imageDigest?.split("@").at(-1) !== resolvedDigest
      )
        return false;
      assertRuntime(revision.spec);
      return true;
    },
  );
  function preservedCandidate(current) {
    return (
      current.metadata?.name === serviceName &&
      fingerprint(current) === preserved &&
      current.spec?.template?.spec?.containers?.[0]?.image === image &&
      current.status.latestCreatedRevisionName === revisionName &&
      origin(current.status.url) === publicURL
    );
  }
  const staged = describe();
  if (
    !preservedCandidate(staged) ||
    canonical(routes(staged)) !== canonical(previous)
  )
    throw new Error(
      "External web configuration or route changed before candidate smoke",
    );
  const tagged = staged.status.traffic?.find(
    (t) => t.tag === input.tag && t.revisionName === revisionName,
  );
  const candidateURL = origin(tagged?.url);
  await smoke({
    baseURL: candidateURL,
    commit: input.commit,
    version: input.version,
    full: true,
    fetchImpl,
  });
  const beforePromotion = describe();
  if (
    !preservedCandidate(beforePromotion) ||
    canonical(routes(beforePromotion)) !== canonical(previous)
  )
    throw new Error(
      "External web configuration or route changed before promotion",
    );
  let promoted;
  try {
    promoted = json([
      "run",
      "services",
      "update-traffic",
      serviceName,
      "--to-revisions",
      `${revisionName}=100`,
      "--remove-tags",
      input.tag,
      "--quiet",
      ...suffix,
    ]);
    const owns = (current) =>
      preservedCandidate(current) &&
      current.metadata.generation === promoted.metadata?.generation &&
      canonical(routes(current)) ===
        canonical([{ revisionName, percent: 100 }]);
    await until(describe, (current) => isReady(current) && owns(current));
    await smoke({
      baseURL: publicURL,
      commit: input.commit,
      version: input.version,
      full: false,
      fetchImpl,
    });
    if (!owns(describe()))
      throw new Error("External web state changed after public verification");
  } catch {
    if (!promoted)
      throw new Error(
        "Web promotion outcome is uncertain; no blind rollback attempted",
      );
    const current = describe();
    if (
      !preservedCandidate(current) ||
      current.metadata.generation !== promoted.metadata?.generation ||
      canonical(routes(current)) !== canonical([{ revisionName, percent: 100 }])
    )
      throw new Error(
        "Web verification failed; rollback skipped because external state changed",
      );
    json([
      "run",
      "services",
      "update-traffic",
      serviceName,
      "--to-revisions",
      previous.map((t) => `${t.revisionName}=${t.percent}`).join(","),
      "--quiet",
      ...suffix,
    ]);
    await until(
      describe,
      (current) => canonical(routes(current)) === canonical(previous),
    );
    throw new Error("Web verification failed; previous route restored");
  }
  return {
    project,
    region,
    service: serviceName,
    commit: input.commit,
    version: input.version,
    image,
    resolvedImageDigest,
    revision: revisionName,
    url: publicURL,
    status: "verified",
  };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv[2] === "--validate") {
    webInputs();
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `project_id=${project}\nservice_account=${deploySA}\nworkload_identity_provider=${provider}\n`,
      );
    console.log(
      "Web production identity and completed release context validated; no cloud calls performed",
    );
  } else if (process.argv.length === 2) {
    const receipt = await deployWeb();
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `url=${receipt.url}\nrevision=${receipt.revision}\nimage=${receipt.image}\n`,
      );
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        "Verified web deployment\n\n```json\n" +
          JSON.stringify(receipt, null, 2) +
          "\n```\n",
      );
    console.log(JSON.stringify(receipt, null, 2));
  } else throw new Error("Usage: cloud-run-web-deploy.mjs [--validate]");
}
