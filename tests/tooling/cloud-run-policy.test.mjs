import assert from "node:assert/strict";
import { test } from "node:test";
import {
  planCloudRunDeployment,
  verifyCloudRunDeployment,
  releaseDeploymentOutputs,
  verifyDeployedModel,
} from "../../scripts/cloud-run-policy.mjs";

function fixture() {
  const release = {
    complete: true,
    immutable: true,
    registryPublished: true,
    version: "0.1.0",
    commit: "a".repeat(40),
    tarballSha256: "b".repeat(64),
    image: `ghcr.io/fixture/unmask@sha256:${"c".repeat(64)}`,
  };
  const context = {
    eventName: "push",
    ref: "refs/heads/main",
    workflowRef: "fixture/unmask/.github/workflows/release.yml@refs/heads/main",
    repository: "fixture/unmask",
    repositoryId: "1440901935",
    ownerId: "145288107",
    environment: "production",
    sha: release.commit,
  };
  const configuration = {
    project: "fixture-project",
    region: "asia-south1",
    service: "unmask-fixture",
    serviceAccount: "deployment@fixture-project.iam.gserviceaccount.com",
    runtimeServiceAccount: "runtime@fixture-project.iam.gserviceaccount.com",
    workloadIdentityProvider:
      "projects/123456789/locations/global/workloadIdentityPools/fixture/providers/github",
  };
  const service = {
    metadata: { name: configuration.service, generation: 2 },
    spec: {
      template: {
        metadata: {
          annotations: {
            "run.googleapis.com/cpu-throttling": "false",
            "autoscaling.knative.dev/minScale": "1",
            "autoscaling.knative.dev/maxScale": "1",
          },
        },
        spec: {
          serviceAccountName: "runtime@fixture-project.iam.gserviceaccount.com",
          containerConcurrency: 8,
          timeoutSeconds: 300,
          containers: [
            {
              image: `ghcr.io/fixture/unmask@sha256:${"d".repeat(64)}`,
              resources: { limits: { cpu: "1", memory: "2Gi" } },
              env: [
                { name: "UNMASK_MODEL", value: "on" },
                {
                  name: "GEMINI_API_KEY",
                  valueFrom: { secretKeyRef: { name: "model-key", key: "3" } },
                },
              ],
              ports: [{ containerPort: 8080 }],
            },
          ],
        },
      },
    },
    status: {
      observedGeneration: 2,
      conditions: [{ type: "Ready", status: "True" }],
      url: "https://fixture.invalid",
      latestReadyRevisionName: "unmask-fixture-old",
      traffic: [{ revisionName: "unmask-fixture-old", percent: 100 }],
    },
  };
  return { release, context, configuration, service };
}

test("deployment plan pins exact release digest and updates only the existing image", () => {
  const f = fixture();
  const plan = planCloudRunDeployment(f);
  assert.equal(plan.image, f.release.image);
  assert.deepEqual(plan.updateArgs, [
    "run",
    "services",
    "update",
    "unmask-fixture",
    "--project",
    "fixture-project",
    "--region",
    "asia-south1",
    "--image",
    f.release.image,
    "--no-traffic",
    "--quiet",
    "--format=json",
  ]);
  assert.equal(JSON.stringify(plan).includes("model-key"), false);
  assert.equal(JSON.stringify(plan).includes("runtime@"), false);
});

for (const [label, mutate] of [
  [
    "incomplete GitHub release",
    (f) => {
      f.release.complete = false;
    },
  ],
  [
    "mutable release",
    (f) => {
      f.release.immutable = false;
    },
  ],
  [
    "missing verified npm publication",
    (f) => {
      f.release.registryPublished = false;
    },
  ],
  [
    "floating image",
    (f) => {
      f.release.image = "ghcr.io/fixture/unmask:latest";
    },
  ],
  [
    "different commit",
    (f) => {
      f.context.sha = "f".repeat(40);
    },
  ],
  [
    "PR context",
    (f) => {
      f.context.eventName = "pull_request";
    },
  ],
  [
    "different repository id",
    (f) => {
      f.context.repositoryId = "1";
    },
  ],
  [
    "different owner id",
    (f) => {
      f.context.ownerId = "1";
    },
  ],
  [
    "different workflow",
    (f) => {
      f.context.workflowRef =
        "fixture/unmask/.github/workflows/pr.yml@refs/heads/main";
    },
  ],
  [
    "missing production environment",
    (f) => {
      f.context.environment = "";
    },
  ],
  [
    "missing project",
    (f) => {
      f.configuration.project = "";
    },
  ],
  [
    "wrong region",
    (f) => {
      f.configuration.region = "us-central1";
    },
  ],
  [
    "missing service",
    (f) => {
      f.configuration.service = "";
    },
  ],
  [
    "request based CPU",
    (f) => {
      f.service.spec.template.metadata.annotations[
        "run.googleapis.com/cpu-throttling"
      ] = "true";
    },
  ],
  [
    "multiple instances",
    (f) => {
      f.service.spec.template.metadata.annotations[
        "autoscaling.knative.dev/maxScale"
      ] = "2";
    },
  ],
]) {
  test(`deployment refuses ${label}`, () => {
    const f = fixture();
    mutate(f);
    assert.throws(
      () => planCloudRunDeployment(f),
      /release|npm|image|commit|context|repository|owner|workflow|environment|project|region|service|CPU|instance|config/i,
    );
  });
}

function deployed(f) {
  const after = structuredClone(f.service);
  after.spec.template.spec.containers[0].image = f.release.image;
  after.status.latestReadyRevisionName = "unmask-fixture-new";
  after.status.traffic = [{ revisionName: "unmask-fixture-new", percent: 100 }];
  const revision = {
    metadata: { name: "unmask-fixture-new", generation: 1 },
    spec: structuredClone(after.spec.template.spec),
    status: {
      observedGeneration: 1,
      imageDigest: f.release.image,
      conditions: [{ type: "Ready", status: "True" }],
    },
  };
  return { after, revision };
}

test("serving verification requires exact digest, ready revision and all production traffic", () => {
  const f = fixture();
  const result = verifyCloudRunDeployment({ ...f, ...deployed(f) });
  assert.equal(result.image, f.release.image);
  assert.equal(result.url, "https://fixture.invalid/");
});

for (const [label, mutate] of [
  [
    "different image digest",
    (x) => {
      x.revision.status.imageDigest = `ghcr.io/fixture/unmask@sha256:${"f".repeat(64)}`;
    },
  ],
  [
    "old traffic",
    (x) => {
      x.after.status.traffic = [
        { revisionName: "unmask-fixture-old", percent: 100 },
      ];
    },
  ],
  [
    "unready revision",
    (x) => {
      x.revision.status.conditions[0].status = "False";
    },
  ],
  [
    "secret reference changed",
    (x) => {
      x.after.spec.template.spec.containers[0].env[1].valueFrom.secretKeyRef.key =
        "4";
    },
  ],
  [
    "runtime identity changed",
    (x) => {
      x.after.spec.template.spec.serviceAccountName =
        "other@fixture-project.iam.gserviceaccount.com";
    },
  ],
  [
    "memory changed",
    (x) => {
      x.after.spec.template.spec.containers[0].resources.limits.memory = "4Gi";
    },
  ],
]) {
  test(`serving verification refuses ${label}`, () => {
    const f = fixture();
    const observed = deployed(f);
    mutate(observed);
    assert.throws(
      () => verifyCloudRunDeployment({ ...f, ...observed }),
      /image|digest|traffic|ready|config|identity|preserv/i,
    );
  });
}

test("controller bookkeeping can change while runtime configuration stays preserved", () => {
  const f = fixture();
  const observed = deployed(f);
  observed.after.spec.template.metadata.name = "new-revision";
  observed.after.spec.template.metadata.annotations[
    "run.googleapis.com/client-version"
  ] = "new-sdk";
  observed.after.spec.template.metadata.labels = {
    "client.knative.dev/nonce": "new-controller-nonce",
  };
  assert.equal(
    verifyCloudRunDeployment({ ...f, ...observed }).image,
    f.release.image,
  );
});

test("missing controller generation cannot establish serving readiness", () => {
  const f = fixture();
  delete f.service.metadata.generation;
  delete f.service.status.observedGeneration;
  assert.throws(() => planCloudRunDeployment(f), /ready|config|generation/i);
});

function publicationFixture() {
  const f = fixture();
  return {
    repository: f.context.repository,
    manifest: {
      tag: "v0.1.0",
      version: f.release.version,
      commit: f.release.commit,
      package: {
        registryPublished: true,
        digest: `sha256:${f.release.tarballSha256}`,
      },
      image: { reference: f.release.image, platform: "linux/amd64" },
    },
    published: { id: 123, tag_name: "v0.1.0", draft: false, immutable: true },
    sealedTag: { object: { type: "commit", sha: f.release.commit } },
  };
}

test("release outputs expose only completed immutable, commit-bound publication metadata", () => {
  const p = publicationFixture();
  const result = releaseDeploymentOutputs(p);
  assert.equal(result.complete, "true");
  assert.equal(result.npm_published, "true");
  assert.equal(result.image, p.manifest.image.reference);
  assert.equal(result.commit, p.manifest.commit);
  assert.equal(result.tarball_sha256, "b".repeat(64));
});

for (const [label, mutate] of [
  [
    "draft release",
    (p) => {
      p.published.draft = true;
    },
  ],
  [
    "unsealed release",
    (p) => {
      p.published.immutable = false;
    },
  ],
  [
    "wrong tag after publication",
    (p) => {
      p.sealedTag.object.sha = "f".repeat(40);
    },
  ],
  [
    "different repository image",
    (p) => {
      p.manifest.image.reference = `ghcr.io/other/image@sha256:${"c".repeat(64)}`;
    },
  ],
]) {
  test(`release cannot emit deployment outputs for ${label}`, () => {
    const p = publicationFixture();
    mutate(p);
    assert.throws(
      () => releaseDeploymentOutputs(p),
      /release|tag|image|commit|publication/i,
    );
  });
}

function modelProof() {
  const expectation = {
    provider: "google",
    endpointHost: "generativelanguage.googleapis.com",
    modelId: "gemma-4-26b-a4b-it",
    configHash: "a".repeat(64),
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 1000,
      candidateCount: 1,
      thinkingConfig: { thinkingLevel: "minimal" },
    },
  };
  const report = {
    evidence: [
      {
        id: "artifact-1",
        side: "artifact",
        excerpt: '"install":"node setup.js"',
      },
    ],
    model: {
      ...structuredClone(expectation),
      status: "complete",
      promptHash: "b".repeat(64),
      attempts: 1,
      preflightCalls: 1,
      hypotheses: [
        {
          category: "review-concern",
          explanation: "The install command warrants review.",
          uncertainty: "Intent is not established.",
          alternative: "It may be packaging behavior.",
          citations: [{ evidenceId: "artifact-1", quote: "node setup.js" }],
        },
      ],
    },
  };
  return { report, expectation };
}

test("AI path acceptance needs intended configuration and nonempty cited model output", () => {
  const f = modelProof();
  const result = verifyDeployedModel(f.report, f.expectation);
  assert.equal(result.modelPath, "verified");
  assert.equal(result.hypothesesCount, 1);
  assert.equal(result.citationsCount, 1);
});

for (const [label, mutate] of [
  [
    "disabled model",
    (f) => {
      f.report.model.status = "disabled";
    },
  ],
  [
    "not-sent model",
    (f) => {
      f.report.model.status = "not-sent";
    },
  ],
  [
    "provider failure",
    (f) => {
      f.report.model.status = "unavailable";
    },
  ],
  [
    "empty hypotheses",
    (f) => {
      f.report.model.hypotheses = [];
    },
  ],
  [
    "different model",
    (f) => {
      f.report.model.modelId = "other-model";
    },
  ],
  [
    "different configuration",
    (f) => {
      f.report.model.configHash = "f".repeat(64);
    },
  ],
  [
    "missing real token preflight",
    (f) => {
      f.report.model.preflightCalls = 0;
    },
  ],
  [
    "unknown citation",
    (f) => {
      f.report.model.hypotheses[0].citations[0].evidenceId = "invented";
    },
  ],
  [
    "invented quote",
    (f) => {
      f.report.model.hypotheses[0].citations[0].quote = "invented";
    },
  ],
  [
    "unpaired transformation claim",
    (f) => {
      f.report.model.hypotheses[0].category = "possible-transformation";
    },
  ],
]) {
  test(`AI acceptance refuses ${label}`, () => {
    const f = modelProof();
    mutate(f);
    assert.throws(
      () => verifyDeployedModel(f.report, f.expectation),
      /model|config|citation|quote|pair|hypothes|preflight/i,
    );
  });
}

test("new service-level min/max settings satisfy the single-instance policy", () => {
  const f = fixture();
  f.service.metadata.annotations = {
    "run.googleapis.com/minScale": "1",
    "run.googleapis.com/maxScale": "1",
  };
  delete f.service.spec.template.metadata.annotations[
    "autoscaling.knative.dev/minScale"
  ];
  delete f.service.spec.template.metadata.annotations[
    "autoscaling.knative.dev/maxScale"
  ];
  assert.equal(planCloudRunDeployment(f).image, f.release.image);
});

test("approved fallback route is verified without overriding the service model", () => {
  const f = modelProof();
  const fallback = {
    ...structuredClone(f.expectation),
    modelId: "fallback-model",
    configHash: "c".repeat(64),
  };
  Object.assign(f.report.model, fallback);
  assert.equal(
    verifyDeployedModel(f.report, { routes: [f.expectation, fallback] })
      .modelId,
    "fallback-model",
  );
});

test("serving identity cannot change to a different Cloud Run service", () => {
  const f = fixture();
  const observed = deployed(f);
  observed.after.metadata.name = "other-service";
  assert.throws(
    () => verifyCloudRunDeployment({ ...f, ...observed }),
    /service|identity/i,
  );
});

test("existing runtime identity must match the intended configured service account", () => {
  const f = fixture();
  f.service.spec.template.spec.serviceAccountName =
    "other@fixture-project.iam.gserviceaccount.com";
  assert.throws(() => planCloudRunDeployment(f), /identity|service|config/i);
});
