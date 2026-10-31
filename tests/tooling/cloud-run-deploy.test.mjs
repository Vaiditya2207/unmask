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
  let updated = false;
  const calls = [];
  return {
    env,
    before,
    after,
    revision,
    calls,
    execute(command, args) {
      calls.push({ command, args });
      assert.equal(command, "gcloud");
      if (args.includes("update")) {
        updated = true;
        return JSON.stringify(after);
      }
      if (args.includes("update-traffic")) return JSON.stringify(after);
      if (args.includes("revisions")) return JSON.stringify(revision);
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
