import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  appendFileSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import path from "node:path";
import {
  planCloudRunDeployment,
  validateCloudRunInputs,
  verifyCloudRunDeployment,
  runtimeConfigurationFingerprint,
  verifyCloudRunRevision,
  validateModelExpectations,
} from "./cloud-run-policy.mjs";
import { verifyAsset } from "./release-policy.mjs";
import { smokeHttpCandidate } from "./smoke-candidate.mjs";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function deploymentInputs(env = process.env) {
  const configPath = path.join(process.cwd(), "deployment.config.json");
  const committed = [
    "GCP_PROJECT_ID",
    "GCP_REGION",
    "GCP_SERVICE_ACCOUNT",
    "GCP_RUNTIME_SERVICE_ACCOUNT",
    "GCP_WORKLOAD_IDENTITY_PROVIDER",
  ].some((name) => Object.hasOwn(env, name))
    ? {}
    : existsSync(configPath)
      ? JSON.parse(readFileSync(configPath))
      : {};
  env = {
    GCP_PROJECT_ID: committed.project,
    GCP_REGION: committed.region,
    GCP_CLOUD_RUN_SERVICE: committed.service,
    GCP_SERVICE_ACCOUNT: committed.serviceAccount,
    GCP_RUNTIME_SERVICE_ACCOUNT: committed.runtimeServiceAccount,
    GCP_WORKLOAD_IDENTITY_PROVIDER: committed.workloadIdentityProvider,
    CLOUD_RUN_SMOKE_PACKAGE: committed.smokePackage,
    CLOUD_RUN_MODEL_SECRET_VERSION: committed.modelSecretVersion,
    CLOUD_RUN_MODEL_EXPECTATIONS: committed.modelExpectation
      ? JSON.stringify(committed.modelExpectation)
      : undefined,
    ...env,
  };
  const configuration = {
    project: env.GCP_PROJECT_ID,
    region: env.GCP_REGION,
    service: env.GCP_CLOUD_RUN_SERVICE,
    serviceAccount: env.GCP_SERVICE_ACCOUNT,
    runtimeServiceAccount: env.GCP_RUNTIME_SERVICE_ACCOUNT,
    workloadIdentityProvider: env.GCP_WORKLOAD_IDENTITY_PROVIDER,
    ...(env.CLOUD_RUN_MODEL_SECRET_VERSION === undefined
      ? {}
      : { modelSecretVersion: env.CLOUD_RUN_MODEL_SECRET_VERSION }),
  };
  const context = {
    eventName: env.GITHUB_EVENT_NAME,
    ref: env.GITHUB_REF,
    repository: env.GITHUB_REPOSITORY,
    repositoryId: env.DEPLOY_REPOSITORY_ID,
    ownerId: env.DEPLOY_OWNER_ID,
    workflowRef: env.GITHUB_WORKFLOW_REF,
    environment: env.DEPLOY_ENVIRONMENT,
    sha: env.GITHUB_SHA,
  };
  const release = {
    complete: env.RELEASE_COMPLETE === "true",
    immutable: env.RELEASE_COMPLETE === "true",
    registryPublished: env.RELEASE_NPM_PUBLISHED === "true",
    image: env.RELEASE_IMAGE_DIGEST,
    commit: env.RELEASE_COMMIT,
    version: env.RELEASE_VERSION,
    tarballSha256: env.RELEASE_PACKAGE_SHA256,
  };
  validateCloudRunInputs({ release, context, configuration });
  if (
    !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+@\d+\.\d+\.\d+$/.test(
      env.CLOUD_RUN_SMOKE_PACKAGE || "",
    )
  )
    throw new Error("An explicit exact public smoke package is required");
  let modelExpectation;
  try {
    if (
      !env.CLOUD_RUN_MODEL_EXPECTATIONS ||
      env.CLOUD_RUN_MODEL_EXPECTATIONS.length > 16384
    )
      throw new Error();
    modelExpectation = JSON.parse(env.CLOUD_RUN_MODEL_EXPECTATIONS);
  } catch {
    throw new Error("Configured model route expectations are required");
  }
  validateModelExpectations(modelExpectation);
  return {
    release,
    context,
    configuration,
    modelExpectation,
    packageSpec: env.CLOUD_RUN_SMOKE_PACKAGE,
  };
}
export async function verifyPublicGhcrImage(image, fetchImpl) {
  const match =
    /^ghcr\.io\/([a-z0-9._-]+\/[a-z0-9._-]+)@(sha256:[a-f0-9]{64})$/.exec(
      image,
    );
  if (!match) throw new Error("A public GHCR digest is required");
  try {
    const auth = await fetchImpl(
      `https://ghcr.io/token?service=ghcr.io&scope=repository:${match[1]}:pull`,
      { redirect: "manual", signal: AbortSignal.timeout(10000) },
    );
    if (!auth.ok) throw new Error();
    const reader = auth.body.getReader(),
      chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 262144) throw new Error();
        chunks.push(value);
      }
    } finally {
      reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const token = JSON.parse(Buffer.concat(chunks, size)).token;
    if (
      typeof token !== "string" ||
      !token ||
      token.length > 8192 ||
      /\s/.test(token)
    )
      throw new Error();
    const response = await fetchImpl(
      `https://ghcr.io/v2/${match[1]}/manifests/${match[2]}`,
      {
        method: "HEAD",
        redirect: "manual",
        signal: AbortSignal.timeout(10000),
        headers: {
          authorization: `Bearer ${token}`,
          accept:
            "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
        },
      },
    );
    if (
      !response.ok ||
      response.headers.get("docker-content-digest") !== match[2]
    )
      throw new Error();
    if (
      /image.index|manifest.list/.test(
        response.headers.get("content-type") || "",
      )
    ) {
      const indexResponse = await fetchImpl(
        `https://ghcr.io/v2/${match[1]}/manifests/${match[2]}`,
        {
          redirect: "manual",
          signal: AbortSignal.timeout(10000),
          headers: {
            authorization: `Bearer ${token}`,
            accept:
              "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json",
          },
        },
      );
      if (!indexResponse.ok) throw new Error();
      const indexReader = indexResponse.body.getReader(),
        indexChunks = [];
      let indexSize = 0;
      try {
        while (true) {
          const { done, value } = await indexReader.read();
          if (done) break;
          indexSize += value.length;
          if (indexSize > 262144) throw new Error();
          indexChunks.push(value);
        }
      } finally {
        indexReader.cancel().catch(() => {});
        indexReader.releaseLock();
      }
      const bytes = Buffer.concat(indexChunks, indexSize);
      verifyAsset(bytes, match[2]);
      const children = JSON.parse(bytes).manifests?.filter(
        (item) =>
          item.platform?.os === "linux" &&
          item.platform?.architecture === "amd64",
      );
      if (
        children?.length !== 1 ||
        !/^sha256:[a-f0-9]{64}$/.test(children[0].digest || "")
      )
        throw new Error();
      return `ghcr.io/${match[1]}@${children[0].digest}`;
    }
    return image;
  } catch {
    throw new Error(
      "Published GHCR image is not anonymously pullable at its exact digest",
    );
  }
}
export async function deployCloudRun({
  env = process.env,
  execute = execFileSync,
  fetchImpl = globalThis.fetch,
  smoke = smokeHttpCandidate,
  pause: wait = pause,
  now = () => performance.now(),
} = {}) {
  const inputs = deploymentInputs(env),
    { release, configuration } = inputs;
  release.resolvedImageDigest = await verifyPublicGhcrImage(
    release.image,
    fetchImpl,
  );
  let deadline = now() + 600000;
  function command(args, phase) {
    if (now() >= deadline)
      throw new Error("Cloud Run deployment verification deadline exceeded");
    try {
      return JSON.parse(
        execute("gcloud", args, {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          maxBuffer: 2097152,
          timeout: Math.max(1, Math.min(120000, deadline - now())),
        }),
      );
    } catch {
      throw new Error(
        `Cloud Run ${phase} failed; raw provider output suppressed`,
      );
    }
  }
  const suffix = [
    "--project",
    configuration.project,
    "--region",
    configuration.region,
    "--format=json",
  ];
  const describe = () =>
    command(
      ["run", "services", "describe", configuration.service, ...suffix],
      "service observation",
    );
  const service = describe();
  const plan = planCloudRunDeployment({ ...inputs, service });
  const observedReady = (value) =>
    /^[1-9]\d*$/.test(String(value?.metadata?.generation)) &&
    String(value.status?.observedGeneration) ===
      String(value.metadata.generation) &&
    value.status.conditions?.some(
      (item) => item.type === "Ready" && item.status === "True",
    );
  function trafficOf(value) {
    const weights = new Map();
    for (const route of value.status?.traffic ?? []) {
      if (!route.percent) continue;
      if (
        !Number.isInteger(route.percent) ||
        route.percent < 1 ||
        route.percent > 100 ||
        !/^[a-z][a-z0-9-]{0,62}$/.test(route.revisionName || "")
      )
        throw new Error("Previous revision traffic is not explicitly pinned");
      weights.set(
        route.revisionName,
        (weights.get(route.revisionName) ?? 0) + route.percent,
      );
    }
    const pinned = [...weights].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    if (pinned.reduce((sum, [, percent]) => sum + percent, 0) !== 100)
      throw new Error("Previous traffic must total100percent");
    return pinned;
  }
  const previousTraffic = trafficOf(service);
  const previousRevisions = new Map();
  for (const [name] of previousTraffic) {
    const previous = command(
      ["run", "revisions", "describe", name, ...suffix],
      "previous revision observation",
    );
    if (
      !observedReady(previous) ||
      previous.metadata.name !== name ||
      typeof previous.spec?.containers?.[0]?.image !== "string" ||
      !/(?:^|@)sha256:[a-f0-9]{64}$/.test(previous.status.imageDigest || "")
    )
      throw new Error("Previous serving revision identity/digest is not ready");
    previousRevisions.set(name, {
      image: previous.spec.containers[0].image,
      digest: previous.status.imageDigest,
    });
  }
  const updated = command(plan.updateArgs, "image update");
  const revisionName = updated.status?.latestCreatedRevisionName;
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(revisionName || ""))
    throw new Error("Cloud Run candidate revision identity is unavailable");
  let revision;
  for (let attempt = 0; attempt < 30; attempt++) {
    revision = command(
      ["run", "revisions", "describe", revisionName, ...suffix],
      "revision observation",
    );
    try {
      verifyCloudRunRevision(release, revision, configuration);
      break;
    } catch {
      if (attempt === 29)
        throw new Error(
          "Cloud Run candidate revision did not become ready at the expected digest",
        );
      await wait(2000);
    }
  }
  const beforeRouting = describe();
  if (
    runtimeConfigurationFingerprint(beforeRouting) !== plan.runtimeFingerprint
  )
    throw new Error(
      "Runtime config or secret references changed during the image update",
    );
  let phase = "traffic promotion";
  try {
    command(
      [
        "run",
        "services",
        "update-traffic",
        configuration.service,
        "--to-revisions",
        `${revisionName}=100`,
        "--quiet",
        ...suffix,
      ],
      "traffic update",
    );
    phase = "serving verification";
    let verified;
    for (let attempt = 0; attempt < 30; attempt++) {
      const after = describe();
      try {
        verified = verifyCloudRunDeployment({
          ...inputs,
          service,
          after,
          revision,
        });
        break;
      } catch {
        if (attempt === 29)
          throw new Error(
            "Cloud Run serving traffic/config/image verification failed",
          );
        await wait(2000);
      }
    }
    phase = "model smoke";
    const observed = await smoke({
      baseURL: verified.url,
      identity: {
        version: release.version,
        commit: release.commit,
        tarballSha256: release.tarballSha256,
      },
      packageSpec: inputs.packageSpec,
      mode: "live-public",
      healthPath: "/version",
      timeoutMs: 240000,
      modelExpectation: inputs.modelExpectation,
      fetchImpl,
    });
    if (
      !/^\/r\/[a-f0-9]{32}$/.test(observed.reportPath || "") ||
      observed.modelAcceptance !== "verified-path" ||
      observed.modelProof?.modelPath !== "verified"
    )
      throw new Error("Live model smoke did not verify the intended path");
    phase = "final serving verification";
    const finalRevision = command(
      ["run", "revisions", "describe", revisionName, ...suffix],
      "final revision observation",
    );
    verified = verifyCloudRunDeployment({
      ...inputs,
      service,
      after: describe(),
      revision: finalRevision,
    });
    return {
      project: configuration.project,
      region: configuration.region,
      service: configuration.service,
      image: verified.image,
      resolvedImageDigest: verified.resolvedImageDigest,
      commit: verified.commit,
      version: release.version,
      revision: verified.revision,
      url: verified.url,
      reportUrl: new URL(observed.reportPath, verified.url).href,
      runtimeFingerprint: verified.runtimeFingerprint,
      ...(plan.modelSecretRotation
        ? { modelSecretRotation: plan.modelSecretRotation }
        : {}),
      modelProof: observed.modelProof,
    };
  } catch {
    deadline = now() + 90000;
    let restored = false;
    try {
      const current = describe();
      const ownedRevisions = new Set([
        revisionName,
        ...previousTraffic.map(([name]) => name),
      ]);
      if (
        current.metadata?.name !== configuration.service ||
        current.spec?.template?.spec?.containers?.[0]?.image !==
          release.image ||
        runtimeConfigurationFingerprint(current) !== plan.runtimeFingerprint ||
        trafficOf(current).some(([name]) => !ownedRevisions.has(name))
      )
        throw new Error(
          "Concurrent service change prevents automatic rollback",
        );
      try {
        command(
          [
            "run",
            "services",
            "update-traffic",
            configuration.service,
            "--to-revisions",
            previousTraffic
              .map(([name, percent]) => `${name}=${percent}`)
              .join(","),
            "--quiet",
            ...suffix,
          ],
          "rollback traffic restoration",
        );
      } catch {}
      for (let attempt = 0; attempt < 15; attempt++) {
        const observed = describe();
        if (
          observedReady(observed) &&
          observed.metadata.name === service.metadata.name &&
          observed.status.url === service.status.url &&
          runtimeConfigurationFingerprint(observed) ===
            plan.runtimeFingerprint &&
          JSON.stringify(trafficOf(observed)) ===
            JSON.stringify(previousTraffic)
        ) {
          let digestsMatch = true;
          for (const [name, previous] of previousRevisions) {
            const current = command(
              ["run", "revisions", "describe", name, ...suffix],
              "rollback revision verification",
            );
            if (
              !observedReady(current) ||
              current.metadata.name !== name ||
              current.spec?.containers?.[0]?.image !== previous.image ||
              current.status?.imageDigest !== previous.digest
            )
              digestsMatch = false;
          }
          if (digestsMatch) {
            restored = true;
            break;
          }
        }
        if (attempt < 14) await wait(2000);
      }
    } catch {}
    throw new Error(
      restored
        ? `Deployment ${phase} failed; previous traffic and revision digests restored and verified`
        : `Deployment ${phase} failed; rollback attempted but not verified`,
    );
  }
}
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  if (process.argv[2] === "--validate") {
    const { configuration } = deploymentInputs();
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `project_id=${configuration.project}\nservice_account=${configuration.serviceAccount}\nworkload_identity_provider=${configuration.workloadIdentityProvider}\n`,
      );
    console.log(
      "Production deployment references and model expectations validated; no cloud calls performed",
    );
  } else if (process.argv.length === 2) {
    const receipt = await deployCloudRun();
    mkdirSync("artifacts", { recursive: true });
    writeFileSync(
      "artifacts/deployment-receipt.json",
      JSON.stringify(receipt, null, 2) + "\n",
    );
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `url=${receipt.url}\nrevision=${receipt.revision}\nimage=${receipt.image}\nreport_url=${receipt.reportUrl}\n`,
      );
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        "Production deployment verification\n\n```json\n" +
          JSON.stringify(receipt, null, 2) +
          "\n```\n",
      );
    console.log(JSON.stringify(receipt, null, 2));
  } else throw new Error("Usage: cloud-run-deploy.mjs [--validate]");
}
