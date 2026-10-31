import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deployCloudRun,
  verifyPublicGhcrImage,
} from "../../scripts/cloud-run-deploy.mjs";

function fixture() {
  const image = `ghcr.io/fixture/unmask@sha256:${"c".repeat(64)}`;
  const env = {
    GCP_PROJECT_ID: "fixture-project",
    GCP_REGION: "asia-south1",
    GCP_CLOUD_RUN_SERVICE: "unmask",
    GCP_SERVICE_ACCOUNT: "deploy@fixture-project.iam.gserviceaccount.com",
    GCP_RUNTIME_SERVICE_ACCOUNT:
      "runtime@fixture-project.iam.gserviceaccount.com",
    GCP_WORKLOAD_IDENTITY_PROVIDER:
      "projects/123456789/locations/global/workloadIdentityPools/fixture/providers/github",
    GITHUB_EVENT_NAME: "push",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY: "fixture/unmask",
    DEPLOY_REPOSITORY_ID: "1440901935",
    DEPLOY_OWNER_ID: "145288107",
    GITHUB_WORKFLOW_REF:
      "fixture/unmask/.github/workflows/release.yml@refs/heads/main",
    DEPLOY_ENVIRONMENT: "production",
    GITHUB_SHA: "a".repeat(40),
    RELEASE_COMPLETE: "true",
    RELEASE_NPM_PUBLISHED: "true",
    RELEASE_IMAGE_DIGEST: image,
    RELEASE_COMMIT: "a".repeat(40),
    RELEASE_VERSION: "0.1.0",
    RELEASE_PACKAGE_SHA256: "b".repeat(64),
    CLOUD_RUN_SMOKE_PACKAGE: "fixture@1.0.0",
    CLOUD_RUN_MODEL_EXPECTATIONS: JSON.stringify({
      routes: [
        {
          provider: "google",
          endpointHost: "generativelanguage.googleapis.com",
          modelId: "configured-model",
          configHash: "d".repeat(64),
          generationConfig: { temperature: 0 },
        },
      ],
    }),
  };
  const before = {
    metadata: {
      name: "unmask",
      generation: 1,
      annotations: {
        "run.googleapis.com/minScale": "1",
        "run.googleapis.com/maxScale": "1",
      },
    },
    spec: {
      template: {
        metadata: {
          annotations: { "run.googleapis.com/cpu-throttling": "false" },
        },
        spec: {
          serviceAccountName: "runtime@fixture-project.iam.gserviceaccount.com",
          containers: [
            {
              image: `ghcr.io/fixture/unmask@sha256:${"e".repeat(64)}`,
              resources: { limits: { cpu: "1", memory: "2Gi" } },
              env: [
                {
                  name: "GEMINI_API_KEY",
                  valueFrom: { secretKeyRef: { name: "model-key", key: "3" } },
                },
              ],
            },
          ],
        },
      },
    },
    status: {
      observedGeneration: 1,
      conditions: [{ type: "Ready", status: "True" }],
      latestReadyRevisionName: "unmask-old",
      latestCreatedRevisionName: "unmask-old",
      url: "https://fixture.invalid",
      traffic: [{ revisionName: "unmask-old", percent: 100 }],
    },
  };
  const after = structuredClone(before);
  after.spec.template.spec.containers[0].image = image;
  after.status.latestReadyRevisionName =
    after.status.latestCreatedRevisionName = "unmask-new";
  after.status.traffic = [{ revisionName: "unmask-new", percent: 100 }];
  const revision = {
    metadata: { name: "unmask-new", generation: 1 },
    spec: structuredClone(after.spec.template.spec),
    status: {
      observedGeneration: 1,
      conditions: [{ type: "Ready", status: "True" }],
      imageDigest: image,
    },
  };
  const previousRevision = {
    metadata: { name: "unmask-old", generation: 1 },
    spec: structuredClone(before.spec.template.spec),
    status: {
      observedGeneration: 1,
      conditions: [{ type: "Ready", status: "True" }],
      imageDigest: before.spec.template.spec.containers[0].image,
    },
  };
  let updated = false,
    routed = false,
    restored = false;
  const calls = [];
  return {
    env,
    before,
    after,
    revision,
    previousRevision,
    calls,
    get traffic() {
      return restored || !routed
        ? "unmask-old"
        : after.status.traffic[0].revisionName;
    },
    execute(command, args) {
      calls.push({ command, args });
      assert.equal(command, "gcloud");
      if (args.includes("update")) {
        updated = true;
        const candidate = structuredClone(after);
        candidate.status.traffic = structuredClone(before.status.traffic);
        return JSON.stringify(candidate);
      }
      if (args.includes("update-traffic")) {
        if (
          args.includes("--to-revisions") &&
          args[args.indexOf("--to-revisions") + 1] === "unmask-old=100"
        ) {
          restored = true;
          const rollback = structuredClone(after);
          rollback.status.traffic = structuredClone(before.status.traffic);
          return JSON.stringify(rollback);
        }
        routed = true;
        return JSON.stringify(after);
      }
      if (args.includes("revisions"))
        return JSON.stringify(
          args[3] === "unmask-old" ? previousRevision : revision,
        );
      if (restored) {
        const rollback = structuredClone(after);
        rollback.status.traffic = structuredClone(before.status.traffic);
        return JSON.stringify(rollback);
      }
      if (updated && !routed) {
        const candidate = structuredClone(after);
        candidate.status.traffic = structuredClone(before.status.traffic);
        return JSON.stringify(candidate);
      }
      return JSON.stringify(updated ? after : before);
    },
    fetchImpl: async (url) =>
      url.includes("/token?")
        ? Response.json({ token: "public-read-only-fixture" })
        : new Response(null, {
            headers: { "docker-content-digest": `sha256:${"c".repeat(64)}` },
          }),
    smoke: async (options) => {
      assert.equal(options.baseURL, "https://fixture.invalid/");
      assert.equal(options.mode, "live-public");
      assert.equal(
        options.modelExpectation.routes[0].modelId,
        "configured-model",
      );
      return {
        status: "passed",
        modelAcceptance: "verified-path",
        reportPath: `/r/${"f".repeat(32)}`,
        modelProof: { modelPath: "verified", modelId: "configured-model" },
      };
    },
  };
}

async function run(f, extra = {}) {
  return deployCloudRun({
    env: f.env,
    execute: f.execute,
    fetchImpl: f.fetchImpl,
    smoke: f.smoke,
    pause: async () => {},
    ...extra,
  });
}

test("deployment updates exact published digest and verifies serving state before and after real-model smoke", async () => {
  const f = fixture();
  const result = await run(f);
  const mutations = f.calls.filter(
    (call) =>
      call.args.includes("update") || call.args.includes("update-traffic"),
  );
  assert.equal(mutations.length, 2);
  assert.ok(mutations[0].args.includes(f.env.RELEASE_IMAGE_DIGEST));
  assert.ok(mutations[0].args.includes("--no-traffic"));
  assert.equal(
    mutations.some((call) =>
      call.args.some((arg) => /env-vars|secrets|service-account/.test(arg)),
    ),
    false,
  );
  assert.equal(result.image, f.env.RELEASE_IMAGE_DIGEST);
  assert.equal(result.modelProof.modelPath, "verified");
  assert.equal(result.reportUrl, `https://fixture.invalid/r/${"f".repeat(32)}`);
});

for (const name of [
  "GCP_PROJECT_ID",
  "GCP_SERVICE_ACCOUNT",
  "GCP_WORKLOAD_IDENTITY_PROVIDER",
  "CLOUD_RUN_SMOKE_PACKAGE",
  "CLOUD_RUN_MODEL_EXPECTATIONS",
]) {
  test(`missing ${name} prevents authentication-dependent cloud commands`, async () => {
    const f = fixture();
    delete f.env[name];
    await assert.rejects(
      run(f),
      /configuration|project|service|model|package|WIF|expect/i,
    );
    assert.equal(f.calls.length, 0);
  });
}

test("private GHCR image is rejected before mutating Cloud Run", async () => {
  const f = fixture();
  await assert.rejects(
    run(f, { fetchImpl: async () => new Response(null, { status: 403 }) }),
    /public|image|GHCR/i,
  );
  assert.equal(f.calls.length, 0);
});

test("disabled-model smoke cannot mark deployment accepted", async () => {
  const f = fixture();
  await assert.rejects(
    run(f, {
      smoke: async () => ({ status: "passed", modelAcceptance: "not-tested" }),
    }),
    /model|smoke/i,
  );
});

test("changed runtime secret reference prevents routing or acceptance", async () => {
  const f = fixture();
  f.after.spec.template.spec.containers[0].env[0].valueFrom.secretKeyRef.key =
    "4";
  await assert.rejects(run(f), /config|secret|preserv/i);
  assert.equal(
    f.calls.some((call) => call.args.includes("update-traffic")),
    false,
  );
});

test("cloud provider diagnostics are sanitized", async () => {
  const f = fixture();
  await assert.rejects(
    run(f, {
      execute: () => {
        throw new Error("sensitive-provider-body");
      },
    }),
    (error) => {
      assert.equal(String(error).includes("sensitive-provider-body"), false);
      return true;
    },
  );
});

test("public OCI index is hash-verified and bound to exactly one Linux AMD64 child", async () => {
  const child = `sha256:${"a".repeat(64)}`;
  const index = Buffer.from(
    JSON.stringify({
      manifests: [
        { platform: { os: "linux", architecture: "amd64" }, digest: child },
        {
          platform: { os: "unknown", architecture: "unknown" },
          digest: `sha256:${"b".repeat(64)}`,
        },
      ],
    }),
  );
  const digest = `sha256:${createHash("sha256").update(index).digest("hex")}`;
  const image = `ghcr.io/fixture/unmask@${digest}`;
  const fetchImpl = async (url, options = {}) =>
    url.includes("/token?")
      ? Response.json({ token: "public-fixture" })
      : options.method === "HEAD"
        ? new Response(null, {
            headers: {
              "content-type": "application/vnd.oci.image.index.v1+json",
              "docker-content-digest": digest,
            },
          })
        : new Response(index);
  assert.equal(
    await verifyPublicGhcrImage(image, fetchImpl),
    `ghcr.io/fixture/unmask@${child}`,
  );
});

test("failed model smoke restores the exact previous revision traffic and verifies its digest", async () => {
  const f = fixture();
  let failure;
  try {
    await run(f, {
      smoke: async () => {
        throw new Error("model-smoke-failed");
      },
    });
  } catch (error) {
    failure = error;
  }
  assert.equal(f.traffic, "unmask-old");
  assert.match(failure?.message ?? "", /restored.*verified/i);
  const rollback = f.calls.find((call) => call.args.includes("unmask-old=100"));
  assert.ok(rollback);
  assert.equal(
    rollback.args[rollback.args.indexOf("--to-revisions") + 1],
    "unmask-old=100",
  );
  assert.equal(rollback.args.includes("--to-latest"), false);
});

test("rollback cannot report verification when the prior revision digest changed", async () => {
  const f = fixture();
  let failed = false;
  await assert.rejects(
    run(f, {
      smoke: async () => {
        failed = true;
        f.previousRevision.status.imageDigest = `ghcr.io/fixture/unmask@sha256:${"f".repeat(64)}`;
        throw new Error("model-failed");
      },
    }),
    /rollback.*not.*verified|rollback.*failed/i,
  );
  assert.equal(failed, true);
  assert.equal(f.traffic, "unmask-old");
});

test("rollback does not overwrite a concurrent operator traffic change", async () => {
  const f = fixture();
  let failure;
  try {
    await run(f, {
      smoke: async () => {
        f.after.status.traffic = [
          { revisionName: "unmask-operator", percent: 100 },
        ];
        throw new Error("model-failed");
      },
    });
  } catch (error) {
    failure = error;
  }
  assert.equal(f.traffic, "unmask-operator");
  assert.equal(
    f.calls.some((call) => call.args.includes("unmask-old=100")),
    false,
  );
  assert.match(failure?.message ?? "", /rollback.*not verified/i);
});

test("promotion targets only the captured verified revision, never concurrent latest", async () => {
  const f = fixture();
  await run(f);
  const promotion = f.calls.find((call) =>
    call.args.includes("update-traffic"),
  );
  assert.ok(promotion.args.includes("--to-revisions"));
  assert.equal(
    promotion.args[promotion.args.indexOf("--to-revisions") + 1],
    "unmask-new=100",
  );
  assert.equal(promotion.args.includes("--to-latest"), false);
});

test("candidate with a different runtime service account receives no traffic", async () => {
  const f = fixture();
  f.revision.spec.serviceAccountName =
    "other@fixture-project.iam.gserviceaccount.com";
  await assert.rejects(run(f), /candidate|identity|runtime/i);
  assert.equal(
    f.calls.some((call) => call.args.includes("update-traffic")),
    false,
  );
});

test("deployment promotes a provider-canonicalized leaf only after verifying its parent index", async () => {
  const f = fixture();
  const child = `sha256:${"d".repeat(64)}`;
  const index = Buffer.from(
    JSON.stringify({
      manifests: [
        { platform: { os: "linux", architecture: "amd64" }, digest: child },
      ],
    }),
  );
  const indexDigest = `sha256:${createHash("sha256").update(index).digest("hex")}`;
  const requested = `ghcr.io/fixture/unmask@${indexDigest}`;
  const resolved = `ghcr.io/fixture/unmask@${child}`;
  f.env.RELEASE_IMAGE_DIGEST = requested;
  f.after.spec.template.spec.containers[0].image = requested;
  f.revision.spec.containers[0].image = resolved;
  f.revision.status.imageDigest = resolved;
  const result = await run(f, {
    fetchImpl: async (url, options = {}) =>
      url.includes("/token?")
        ? Response.json({ token: "fixture-public" })
        : options.method === "HEAD"
          ? new Response(null, {
              headers: {
                "content-type": "application/vnd.oci.image.index.v1+json",
                "docker-content-digest": indexDigest,
              },
            })
          : new Response(index),
  });
  assert.equal(result.image, requested);
  assert.equal(result.resolvedImageDigest, resolved);
  assert.ok(f.calls.some((call) => call.args.includes("unmask-new=100")));
});

test("deployment promotes the exact GHCR image through the observed Asia cache representation", async () => {
  const f = fixture();
  const cache = `cache.asia-docker.pkg.dev/${f.env.RELEASE_IMAGE_DIGEST}`;
  f.revision.spec.containers[0].image = cache;
  f.revision.status.imageDigest = cache;
  const result = await run(f);
  assert.equal(result.image, f.env.RELEASE_IMAGE_DIGEST);
  assert.equal(result.resolvedImageDigest, f.env.RELEASE_IMAGE_DIGEST);
  assert.equal(f.traffic, "unmask-new");
});

test("failed smoke restores and verifies the exact cached previous revision", async () => {
  const f = fixture();
  f.previousRevision.spec.containers[0].image = `cache.asia-docker.pkg.dev/${f.previousRevision.spec.containers[0].image}`;
  f.previousRevision.status.imageDigest =
    f.previousRevision.spec.containers[0].image;
  const cache = `cache.asia-docker.pkg.dev/${f.env.RELEASE_IMAGE_DIGEST}`;
  f.revision.spec.containers[0].image = cache;
  f.revision.status.imageDigest = cache;
  await assert.rejects(
    run(f, {
      smoke: async () => {
        throw new Error("model-smoke-failed");
      },
    }),
    /restored.*verified/i,
  );
  assert.equal(f.traffic, "unmask-old");
});

test("cached rollback still rejects a different repository with the same digest", async () => {
  const f = fixture();
  f.previousRevision.spec.containers[0].image = `cache.asia-docker.pkg.dev/${f.previousRevision.spec.containers[0].image}`;
  f.previousRevision.status.imageDigest =
    f.previousRevision.spec.containers[0].image;
  await assert.rejects(
    run(f, {
      smoke: async () => {
        f.previousRevision.status.imageDigest =
          f.previousRevision.status.imageDigest.replace(
            "fixture/unmask",
            "other/unmask",
          );
        throw new Error("model-smoke-failed");
      },
    }),
    /rollback.*not.*verified|rollback.*failed/i,
  );
});
