import { createHash } from "node:crypto";

const digest = (value) => /^sha256:[a-f0-9]{64}$/.test(value || "");
const canonical = (value) =>
  JSON.stringify(value, (_, item) =>
    item && !Array.isArray(item) && typeof item === "object"
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : item,
  );
function fingerprint(service) {
  const template = {
    spec: structuredClone(service.spec?.template?.spec ?? {}),
    serviceAnnotations: { ...service.metadata?.annotations },
    metadata: {
      annotations: { ...service.spec?.template?.metadata?.annotations },
      labels: { ...service.spec?.template?.metadata?.labels },
    },
  };
  for (const key of [
    "run.googleapis.com/client-name",
    "run.googleapis.com/client-version",
    "run.googleapis.com/operation-id",
  ]) {
    delete template.metadata.annotations[key];
    delete template.serviceAnnotations[key];
  }
  delete template.serviceAnnotations["serving.knative.dev/lastModifier"];
  delete template.metadata.labels["client.knative.dev/nonce"];
  for (const container of template.spec.containers ?? [])
    delete container.image;
  return createHash("sha256").update(canonical(template)).digest("hex");
}
function ready(value) {
  return (
    value?.status?.conditions?.some(
      (item) => item.type === "Ready" && item.status === "True",
    ) &&
    /^[1-9]\d*$/.test(String(value.metadata.generation)) &&
    String(value.status.observedGeneration) ===
      String(value.metadata.generation)
  );
}
function configurationValid(configuration) {
  return (
    configuration &&
    /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(configuration.project || "") &&
    configuration.region === "asia-south1" &&
    /^[a-z](?:[a-z0-9-]{0,47}[a-z0-9])?$/.test(configuration.service || "") &&
    /^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(
      configuration.serviceAccount || "",
    ) &&
    /^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(
      configuration.runtimeServiceAccount || "",
    ) &&
    /^projects\/\d+\/locations\/global\/workloadIdentityPools\/[a-z0-9-]+\/providers\/[a-z0-9-]+$/.test(
      configuration.workloadIdentityProvider || "",
    )
  );
}
export function validateCloudRunInputs({
  release,
  context,
  configuration,
  service,
}) {
  if (
    !context ||
    context.eventName !== "push" ||
    context.ref !== "refs/heads/main" ||
    context.environment !== "production" ||
    context.repositoryId !== "1440901935" ||
    context.ownerId !== "145288107" ||
    !/^[\w.-]+\/[\w.-]+$/.test(context.repository || "") ||
    context.workflowRef !==
      `${context.repository}/.github/workflows/release.yml@refs/heads/main`
  )
    throw new Error(
      "Production deployment context/repository/owner/workflow/environment differs",
    );
  if (
    !release ||
    release.complete !== true ||
    release.immutable !== true ||
    release.registryPublished !== true ||
    !/^[a-f0-9]{40}$/.test(release.commit || "") ||
    release.commit !== context.sha ||
    !/^[a-f0-9]{64}$/.test(release.tarballSha256 || "") ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(release.version || "") ||
    release.version === "0.0.0"
  )
    throw new Error(
      "Complete immutable release, verified npm publication and matching commit are required",
    );
  const prefix = `ghcr.io/${context.repository.toLowerCase()}@`;
  if (
    !release.image?.startsWith(prefix) ||
    !digest(release.image.slice(prefix.length))
  )
    throw new Error("Exact release image digest is required");
  if (!configurationValid(configuration))
    throw new Error(
      "Confirmed project/region/service/WIF configuration is required",
    );
  return true;
}
export function planCloudRunDeployment({
  release,
  context,
  configuration,
  service,
}) {
  validateCloudRunInputs({ release, context, configuration });
  const annotations = service?.spec?.template?.metadata?.annotations;
  const spec = service?.spec?.template?.spec;
  const container = spec?.containers?.[0];
  if (
    service?.metadata?.name !== configuration.service ||
    !ready(service) ||
    spec?.containers?.length !== 1 ||
    spec.serviceAccountName !== configuration.runtimeServiceAccount ||
    annotations?.["run.googleapis.com/cpu-throttling"] !== "false" ||
    (service.metadata?.annotations?.["run.googleapis.com/minScale"] ??
      annotations?.["autoscaling.knative.dev/minScale"]) !== "1" ||
    (service.metadata?.annotations?.["run.googleapis.com/maxScale"] ??
      annotations?.["autoscaling.knative.dev/maxScale"]) !== "1" ||
    !["1", "1000m"].includes(container?.resources?.limits?.cpu) ||
    !["2Gi", "2048Mi"].includes(container?.resources?.limits?.memory)
  )
    throw new Error(
      "Existing service must have ready identity, instance-based CPU, one instance and1CPU/2Gi configuration",
    );
  return {
    image: release.image,
    commit: release.commit,
    version: release.version,
    tarballSha256: release.tarballSha256,
    runtimeFingerprint: fingerprint(service),
    resolvedImageDigest: release.resolvedImageDigest ?? release.image,
    updateArgs: [
      "run",
      "services",
      "update",
      configuration.service,
      "--project",
      configuration.project,
      "--region",
      configuration.region,
      "--image",
      release.image,
      "--no-traffic",
      "--quiet",
      "--format=json",
    ],
  };
}
export function verifyCloudRunDeployment({
  release,
  context,
  configuration,
  service,
  after,
  revision,
}) {
  const plan = planCloudRunDeployment({
    release,
    context,
    configuration,
    service,
  });
  if (
    after.metadata?.name !== configuration.service ||
    after.status?.url !== service.status?.url ||
    !revision.metadata?.name?.startsWith(`${configuration.service}-`)
  )
    throw new Error("Serving service identity or URL changed");
  if (fingerprint(after) !== plan.runtimeFingerprint)
    throw new Error(
      "Runtime config/secret references/identity were not preserved",
    );
  if (
    !ready(after) ||
    !ready(revision) ||
    revision.spec?.serviceAccountName !== configuration.runtimeServiceAccount ||
    after.status.latestReadyRevisionName !== revision.metadata.name ||
    revision.status.imageDigest?.split("@").at(-1) !==
      plan.resolvedImageDigest.split("@").at(-1) ||
    ![plan.image, plan.resolvedImageDigest].includes(
      revision.spec?.containers?.[0]?.image,
    ) ||
    after.spec?.template?.spec?.containers?.[0]?.image !== plan.image
  )
    throw new Error(
      "Serving revision readiness/image digest differs from the exact release",
    );
  if (
    after.status.traffic?.length !== 1 ||
    after.status.traffic[0].revisionName !== revision.metadata.name ||
    after.status.traffic[0].percent !== 100
  )
    throw new Error(
      "Production traffic is not entirely on the verified release revision",
    );
  const url = new URL(after.status.url);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Service URL is not a verified HTTPS origin");
  return {
    image: plan.image,
    resolvedImageDigest: plan.resolvedImageDigest,
    commit: plan.commit,
    revision: revision.metadata.name,
    url: url.href,
    runtimeFingerprint: plan.runtimeFingerprint,
  };
}

export function releaseDeploymentOutputs({
  repository,
  manifest,
  published,
  sealedTag,
}) {
  const prefix = `ghcr.io/${repository.toLowerCase()}@`;
  if (
    !Number.isSafeInteger(published?.id) ||
    published.id < 1 ||
    published.draft !== false ||
    published.immutable !== true ||
    published.tag_name !== manifest.tag ||
    manifest.tag !== `v${manifest.version}` ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(
      manifest.version || "",
    ) ||
    manifest.version === "0.0.0" ||
    !/^[a-f0-9]{40}$/.test(manifest.commit || "") ||
    sealedTag?.object?.type !== "commit" ||
    sealedTag.object.sha !== manifest.commit ||
    typeof manifest.package?.registryPublished !== "boolean" ||
    !digest(manifest.package.digest) ||
    manifest.image?.platform !== "linux/amd64" ||
    !manifest.image.reference.startsWith(prefix) ||
    !digest(manifest.image.reference.slice(prefix.length))
  )
    throw new Error(
      "Completed release/tag/image/commit publication binding differs",
    );
  return {
    complete: "true",
    npm_published: String(manifest.package.registryPublished),
    image: manifest.image.reference,
    commit: manifest.commit,
    version: manifest.version,
    tarball_sha256: manifest.package.digest.slice(7),
    release_id: String(published.id),
  };
}

export function verifyDeployedModel(report, expectation) {
  const model = report?.model;
  const routes = expectation?.routes ?? [expectation];
  if (!Array.isArray(routes) || !routes.length || routes.length > 3)
    throw new Error("Explicit model route expectations are required");
  expectation = routes.find(
    (route) =>
      route?.modelId === model?.modelId &&
      route?.configHash === model?.configHash,
  );
  if (
    !expectation?.modelId ||
    !/^[a-f0-9]{64}$/.test(expectation.configHash || "") ||
    !expectation.provider ||
    !expectation.endpointHost ||
    !expectation.generationConfig ||
    model?.status !== "complete" ||
    model.provider !== expectation.provider ||
    model.endpointHost !== expectation.endpointHost ||
    model.modelId !== expectation.modelId ||
    model.configHash !== expectation.configHash ||
    canonical(model.generationConfig) !==
      canonical(expectation.generationConfig) ||
    !/^[a-f0-9]{64}$/.test(model.promptHash || "") ||
    !Number.isInteger(model.attempts) ||
    model.attempts < 1 ||
    model.attempts > 3 ||
    !Number.isInteger(model.preflightCalls) ||
    model.preflightCalls < 1
  )
    throw new Error(
      "Intended model configuration and completed token preflight/generation proof are required",
    );
  if (
    !Array.isArray(model.hypotheses) ||
    !model.hypotheses.length ||
    model.hypotheses.length > 5
  )
    throw new Error("Nonempty bounded model hypotheses are required");
  const evidence = new Map(
    (report.evidence ?? []).map((item) => [item.id, item]),
  );
  let citationsCount = 0;
  for (const hypothesis of model.hypotheses) {
    if (
      !["review-concern", "possible-transformation", "unknown"].includes(
        hypothesis.category,
      ) ||
      ![
        hypothesis.explanation,
        hypothesis.uncertainty,
        hypothesis.alternative,
      ].every((value) => typeof value === "string" && value.trim()) ||
      !Array.isArray(hypothesis.citations) ||
      !hypothesis.citations.length
    )
      throw new Error("Model hypothesis must have rationale and citations");
    for (const citation of hypothesis.citations) {
      if (
        typeof citation.quote !== "string" ||
        !citation.quote ||
        !evidence.get(citation.evidenceId)?.excerpt?.includes(citation.quote)
      )
        throw new Error(
          "Model citation quote is not grounded in known evidence",
        );
      citationsCount++;
    }
    if (hypothesis.category === "possible-transformation") {
      const sides = new Set(
        hypothesis.citations.map((item) => evidence.get(item.evidenceId).side),
      );
      if (
        !sides.has("artifact") ||
        !sides.has("source") ||
        !model.evidenceGroups?.some(
          (group) =>
            group.paired &&
            hypothesis.citations.every((item) =>
              group.evidenceIds.includes(item.evidenceId),
            ),
        )
      )
        throw new Error(
          "Transformation hypotheses require a verified evidence pair",
        );
    }
  }
  return {
    modelPath: "verified",
    provider: model.provider,
    modelId: model.modelId,
    configHash: model.configHash,
    promptHash: model.promptHash,
    hypothesesCount: model.hypotheses.length,
    citationsCount,
  };
}

export function runtimeConfigurationFingerprint(service) {
  return fingerprint(service);
}
export function verifyCloudRunRevision(release, revision, configuration) {
  if (
    !ready(revision) ||
    !configuration?.runtimeServiceAccount ||
    revision.spec?.serviceAccountName !== configuration.runtimeServiceAccount ||
    ![release.image, release.resolvedImageDigest ?? release.image].includes(
      revision.spec?.containers?.[0]?.image,
    ) ||
    revision.status.imageDigest?.split("@").at(-1) !==
      (release.resolvedImageDigest ?? release.image).split("@").at(-1)
  )
    throw new Error("Candidate revision readiness/image digest differs");
  return revision.metadata.name;
}
export function validateModelExpectations(expectation) {
  const routes = expectation?.routes ?? [expectation];
  if (
    !Array.isArray(routes) ||
    !routes.length ||
    routes.length > 3 ||
    routes.some(
      (route) =>
        !route?.provider ||
        !route.endpointHost ||
        !route.modelId ||
        !/^[a-f0-9]{64}$/.test(route.configHash || "") ||
        !route.generationConfig ||
        typeof route.generationConfig !== "object",
    )
  )
    throw new Error("Explicit model route/config expectations are required");
  return expectation;
}
