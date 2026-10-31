import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  deployWeb,
  webInputs,
  smokeWeb,
} from "../../scripts/cloud-run-web-deploy.mjs";

const sha = "a".repeat(40);
const manifest = JSON.stringify({
  schemaVersion: 2,
  mediaType: "application/vnd.oci.image.manifest.v1+json",
  config: { digest: `sha256:${"d".repeat(64)}`, size: 2 },
  layers: [],
});
const digest = `sha256:${createHash("sha256").update(manifest).digest("hex")}`;
const image = `asia-south1-docker.pkg.dev/unmask-513319/unmask/web@${digest}`;
const origin = "https://unmask-web-386156642190.asia-south1.run.app";
const tag = `web-${sha.slice(0, 12)}-123`;
const candidate = `https://${tag}---unmask-web-xyz.a.run.app`;
const env = () => ({
  GITHUB_EVENT_NAME: "push",
  GITHUB_REF: "refs/heads/main",
  GITHUB_REPOSITORY: "Vaiditya2207/unmask",
  DEPLOY_REPOSITORY_ID: "1440901935",
  DEPLOY_OWNER_ID: "145288107",
  DEPLOY_ENVIRONMENT: "production",
  GITHUB_WORKFLOW_REF:
    "Vaiditya2207/unmask/.github/workflows/release.yml@refs/heads/main",
  GITHUB_SHA: sha,
  GITHUB_RUN_ID: "123",
  RELEASE_COMMIT: sha,
  RELEASE_VERSION: "1.2.3",
  RELEASE_COMPLETE: "true",
  RELEASE_NPM_PUBLISHED: "true",
});
const ready = { conditions: [{ type: "Ready", status: "True" }] };
function service() {
  return {
    metadata: {
      name: "unmask-web",
      generation: 1,
      annotations: { "run.googleapis.com/maxScale": "1" },
    },
    spec: {
      template: {
        metadata: { annotations: {} },
        spec: {
          serviceAccountName:
            "unmask-web@unmask-513319.iam.gserviceaccount.com",
          containers: [
            {
              image: "old-image",
              env: [
                {
                  name: "UNMASK_API_URL",
                  value: "https://unmask-386156642190.asia-south1.run.app",
                },
              ],
              resources: { limits: { cpu: "1", memory: "512Mi" } },
            },
          ],
        },
      },
    },
    status: {
      ...ready,
      observedGeneration: 1,
      url: origin,
      latestReadyRevisionName: "unmask-web-old",
      latestCreatedRevisionName: "unmask-web-old",
      traffic: [{ revisionName: "unmask-web-old", percent: 100 }],
    },
  };
}
function fixture() {
  const calls = [],
    smokes = [];
  const before = service();
  let current = structuredClone(before),
    external = false;
  const f = {
    env: env(),
    calls,
    smokes,
    before,
    get current() {
      return current;
    },
    changeRoute() {
      current.status.traffic = [
        { revisionName: "unmask-web-external", percent: 100 },
      ];
      current.metadata.generation++;
      external = true;
    },
    execute(command, args) {
      calls.push({ command, args });
      if (command === "git") return args[0] === "status" ? "" : sha;
      if (command === "docker") {
        if (args.includes("imagetools")) return manifest + "\n";
        if (args.includes("inspect"))
          return JSON.stringify([
            {
              Id: "local-image",
              Config: {
                Labels: {
                  "org.opencontainers.image.revision": sha,
                  "org.opencontainers.image.version": "1.2.3",
                },
              },
              RepoDigests: [image],
            },
          ]);
        return "";
      }
      if (args.includes("artifacts"))
        return JSON.stringify({ image_summary: { digest } });
      if (args.includes("update")) {
        current.metadata.generation++;
        current.status.observedGeneration = current.metadata.generation;
        current.spec.template.spec.containers[0].image = image;
        current.status.latestReadyRevisionName =
          current.status.latestCreatedRevisionName = "unmask-web-new";
        current.status.traffic.push({
          revisionName: "unmask-web-new",
          tag,
          url: candidate,
        });
      } else if (args.includes("update-traffic")) {
        current.metadata.generation++;
        current.status.observedGeneration = current.metadata.generation;
        const target = args[args.indexOf("--to-revisions") + 1];
        current.status.traffic = target.split(",").map((part) => {
          const [revisionName, percent] = part.split("=");
          return { revisionName, percent: Number(percent) };
        });
      } else if (args.includes("revisions")) {
        return JSON.stringify({
          metadata: { name: "unmask-web-new" },
          spec: structuredClone(current.spec.template.spec),
          status: { ...ready, imageDigest: image },
        });
      }
      return JSON.stringify(current);
    },
    smoke: async (options) => {
      smokes.push(options);
      return { status: "passed", reportPath: "/r/" + "b".repeat(32) };
    },
    source: { version: "1.2.3", dockerfile: true },
  };
  return f;
}
const run = (f, extra = {}) =>
  deployWeb({
    env: f.env,
    execute: f.execute,
    smoke: f.smoke,
    source: f.source,
    pause: async () => {},
    ...extra,
  });

test("web inputs require exact completed main release and pinned production identity", () => {
  assert.equal(webInputs(env()).tag, tag);
  for (const change of [
    { GITHUB_REF: "refs/heads/other" },
    { RELEASE_COMMIT: "b".repeat(40) },
    { DEPLOY_OWNER_ID: "other" },
    { RELEASE_COMPLETE: "false" },
    { RELEASE_NPM_PUBLISHED: "false" },
  ])
    assert.throws(() => webInputs({ ...env(), ...change }));
});

test("web builds exact release, pushes verified digest, smokes tagged candidate before explicit promotion", async () => {
  const f = fixture();
  const result = await run(f);
  const build = f.calls.find(
    (c) => c.command === "docker" && c.args[0] === "build",
  );
  assert.ok(build.args.includes(`RELEASE_COMMIT=${sha}`));
  assert.ok(build.args.includes("RELEASE_VERSION=1.2.3"));
  assert.ok(build.args.includes("linux/amd64"));
  assert.equal(result.image, image);
  assert.equal(f.smokes[0].baseURL, candidate);
  assert.equal(f.smokes[0].full, true);
  assert.equal(f.smokes[1].baseURL, origin);
  assert.equal(f.smokes[1].full, false);
  const update = f.calls.find((c) => c.args.includes("update"));
  assert.ok(update.args.includes("--no-traffic"));
  assert.ok(update.args.includes(image));
  assert.ok(
    !update.args.some((a) => /env-vars|secrets|service-account/.test(a)),
  );
  const promote = f.calls.find((c) => c.args.includes("update-traffic"));
  assert.ok(promote.args.includes("unmask-web-new=100"));
  assert.ok(!promote.args.includes("--to-latest"));
});

test("dirty or mismatched release source cannot build or push", async () => {
  for (const kind of ["dirty", "sha", "version"]) {
    const f = fixture(),
      original = f.execute;
    await assert.rejects(
      run(f, {
        source: {
          ...f.source,
          version: kind === "version" ? "2.0.0" : "1.2.3",
        },
        execute: (command, args) =>
          command === "git"
            ? args[0] === "status"
              ? kind === "dirty"
                ? " M web/app/page.tsx"
                : ""
              : kind === "sha"
                ? "b".repeat(40)
                : sha
            : original(command, args),
      }),
    );
    assert.ok(!f.calls.some((c) => c.command === "docker"));
  }
});

test("wrong image labels or registry digest cannot reach Cloud Run mutation", async () => {
  for (const kind of ["labels", "digest"]) {
    const f = fixture(),
      original = f.execute;
    await assert.rejects(
      run(f, {
        execute: (command, args) => {
          if (
            kind === "labels" &&
            command === "docker" &&
            args.includes("inspect")
          )
            return JSON.stringify([
              { Config: { Labels: {} }, RepoDigests: [image] },
            ]);
          if (kind === "digest" && args.includes("artifacts"))
            return JSON.stringify({
              image_summary: { digest: `sha256:${"e".repeat(64)}` },
            });
          return original(command, args);
        },
      }),
    );
    assert.ok(!f.calls.some((c) => c.args.includes("update")));
  }
});

for (const kind of ["runtime-SA", "env", "cpu", "memory", "scale"])
  test(`unexpected ${kind} fails before Cloud Run mutation`, async () => {
    const f = fixture(),
      current = f.current;
    if (kind === "runtime-SA")
      current.spec.template.spec.serviceAccountName =
        "other@unmask-513319.iam.gserviceaccount.com";
    if (kind === "env")
      current.spec.template.spec.containers[0].env.push({
        name: "UNEXPECTED",
        value: "x",
      });
    if (kind === "cpu")
      current.spec.template.spec.containers[0].resources.limits.cpu = "2";
    if (kind === "memory")
      current.spec.template.spec.containers[0].resources.limits.memory = "2Gi";
    if (kind === "scale")
      current.metadata.annotations["run.googleapis.com/maxScale"] = "2";
    await assert.rejects(run(f));
    assert.ok(!f.calls.some((c) => c.args.includes("update")));
  });

test("candidate smoke failure cannot promote public traffic", async () => {
  const f = fixture();
  await assert.rejects(
    run(f, {
      smoke: async () => {
        throw new Error("candidate failed");
      },
    }),
  );
  assert.ok(!f.calls.some((c) => c.args.includes("update-traffic")));
});

test("failed public version restores previous route when the promoted state is unchanged", async () => {
  const f = fixture();
  await assert.rejects(
    run(f, {
      smoke: async (o) => {
        if (!o.full) throw new Error("public mismatch");
        return {};
      },
    }),
    /restored/,
  );
  assert.deepEqual(f.current.status.traffic, [
    { revisionName: "unmask-web-old", percent: 100 },
  ]);
  assert.equal(
    f.calls.filter((c) => c.args.includes("update-traffic")).length,
    2,
  );
});

test("external traffic change after promotion suppresses rollback", async () => {
  const f = fixture();
  await assert.rejects(
    run(f, {
      smoke: async (o) => {
        if (!o.full) {
          f.changeRoute();
          throw new Error("public mismatch");
        }
        return {};
      },
    }),
    /external|skipped/,
  );
  assert.deepEqual(f.current.status.traffic, [
    { revisionName: "unmask-web-external", percent: 100 },
  ]);
  assert.equal(
    f.calls.filter((c) => c.args.includes("update-traffic")).length,
    1,
  );
});

test("external traffic change during candidate smoke prevents promotion", async () => {
  const f = fixture();
  await assert.rejects(
    run(f, {
      smoke: async () => {
        f.changeRoute();
        return {};
      },
    }),
  );
  assert.ok(!f.calls.some((c) => c.args.includes("update-traffic")));
});

test("web smoke requires version, visible form and normal POST linked to the backend", async () => {
  const seen = [],
    id = "b".repeat(32);
  const fetchImpl = async (url, options) => {
    seen.push({ url, options });
    const p = new URL(url).pathname;
    if (p === "/version")
      return Response.json({ commit: sha, version: "1.2.3" });
    if (p === "/")
      return new Response(
        '<html><form action="/check" method="post"><input name="package"></form></html>',
      );
    if (p === "/check")
      return new Response(null, {
        status: 303,
        headers: { location: `/r/${id}` },
      });
    return Response.json({
      id,
      nameAtExactVersion: "is-number@7.0.0",
      status: "queued",
    });
  };
  const result = await smokeWeb({
    baseURL: candidate,
    commit: sha,
    version: "1.2.3",
    full: true,
    fetchImpl,
  });
  assert.equal(result.reportPath, `/r/${id}`);
  assert.equal(
    seen.find((c) => c.url.endsWith("/check")).options.method,
    "POST",
  );
  assert.ok(seen.every((c) => c.options.redirect === "manual"));
  await assert.rejects(
    smokeWeb({
      baseURL: candidate,
      commit: sha,
      version: "wrong",
      full: false,
      fetchImpl,
    }),
  );
  await assert.rejects(
    smokeWeb({
      baseURL: candidate,
      commit: sha,
      version: "1.2.3",
      full: true,
      fetchImpl: async (url) =>
        new URL(url).pathname === "/check"
          ? new Response(null, {
              status: 303,
              headers: { location: "https://elsewhere.invalid/r/" + id },
            })
          : fetchImpl(url, {}),
    }),
  );
});

test("web workflow waits for completed publication and backend verification using production WIF", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/release.yml", import.meta.url),
    "utf8",
  ).split("\n  deploy-web:\n")[1];
  assert.match(workflow, /needs: \[publish, deploy\]/);
  assert.match(workflow, /needs\.publish\.outputs\.complete == 'true'/);
  assert.match(workflow, /needs\.deploy\.result == 'success'/);
  assert.match(workflow, /name: production/);
  assert.match(workflow, /contents: read\n      id-token: write/);
  assert.match(workflow, /ref: \$\{\{ needs\.publish\.outputs\.commit \}\}/);
  assert.match(
    workflow,
    /google-github-actions\/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093/,
  );
  assert.match(workflow, /cloud-run-web-deploy\.mjs --validate/);
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN|GITHUB_TOKEN|secrets\./);
});

test("split previous routes are restored with their exact percentage mapping", async () => {
  const f = fixture();
  f.current.status.traffic = [
    { revisionName: "unmask-web-old", percent: 60 },
    { revisionName: "unmask-web-older", percent: 40 },
  ];
  await assert.rejects(
    run(f, {
      smoke: async (o) => {
        if (!o.full) throw new Error("public mismatch");
        return {};
      },
    }),
    /previous route restored/,
  );
  const restores = f.calls.filter((c) => c.args.includes("update-traffic"));
  assert.ok(restores[1].args.includes("unmask-web-old=60,unmask-web-older=40"));
});

test("a concurrent image revision cannot replace the candidate before promotion", async () => {
  const f = fixture();
  await assert.rejects(
    run(f, {
      smoke: async () => {
        f.current.status.latestCreatedRevisionName = "unmask-web-external";
        f.current.spec.template.spec.containers[0].image = "other-image";
        return {};
      },
    }),
  );
  assert.ok(!f.calls.some((c) => c.args.includes("update-traffic")));
});

test("web command diagnostics cannot disclose raw provider output", async () => {
  const f = fixture();
  await assert.rejects(
    run(f, {
      execute: () => {
        throw new Error("private-raw-body");
      },
    }),
    (error) => !String(error).includes("private-raw-body"),
  );
});

test("missing candidate Docker/version dependency cannot build or push", async () => {
  const f = fixture();
  await assert.rejects(
    run(f, { source: { version: "1.2.3", dockerfile: false } }),
  );
  assert.ok(!f.calls.some((c) => c.command === "docker"));
});

test("invalid cloud observation JSON cannot expose provider output", async () => {
  const f = fixture(),
    original = f.execute;
  await assert.rejects(
    run(f, {
      execute: (binary, args) =>
        args.includes("artifacts")
          ? "private-provider-diagnostic"
          : original(binary, args),
    }),
    (error) => !String(error).includes("private-provider-diagnostic"),
  );
});

test("external generation change with unchanged traffic suppresses rollback", async () => {
  const f = fixture();
  await assert.rejects(
    run(f, {
      smoke: async (o) => {
        if (!o.full) {
          f.current.metadata.generation++;
          throw new Error("public mismatch");
        }
        return {};
      },
    }),
    /external|skipped/,
  );
  assert.equal(
    f.calls.filter((c) => c.args.includes("update-traffic")).length,
    1,
  );
});

test("candidate revision with unexpected runtime identity cannot be promoted", async () => {
  const f = fixture(),
    original = f.execute;
  await assert.rejects(
    run(f, {
      execute: (binary, args) => {
        const text = original(binary, args);
        if (args.includes("revisions")) {
          const revision = JSON.parse(text);
          revision.spec.serviceAccountName =
            "wrong@unmask-513319.iam.gserviceaccount.com";
          return JSON.stringify(revision);
        }
        return text;
      },
    }),
  );
  assert.ok(!f.calls.some((c) => c.args.includes("update-traffic")));
});

test("malformed Docker inspection output is sanitized before any push", async () => {
  const f = fixture(),
    original = f.execute;
  await assert.rejects(
    run(f, {
      execute: (binary, args) =>
        binary === "docker" && args.includes("inspect")
          ? "private-docker-inspection"
          : original(binary, args),
    }),
    (error) => !String(error).includes("private-docker-inspection"),
  );
  assert.ok(!f.calls.some((c) => c.args.includes("push")));
});

test("controller URL annotation changes during candidate tagging do not imply runtime drift", async () => {
  const f = fixture(),
    original = f.execute;
  f.current.metadata.annotations["run.googleapis.com/urls"] = JSON.stringify([
    origin,
  ]);
  const result = await run(f, {
    execute: (binary, args) => {
      const text = original(binary, args);
      if (args.includes("update")) {
        f.current.metadata.annotations["run.googleapis.com/urls"] =
          JSON.stringify([origin, candidate]);
        return JSON.stringify(f.current);
      }
      if (args.includes("update-traffic")) {
        f.current.metadata.annotations["run.googleapis.com/urls"] =
          JSON.stringify([origin]);
        return JSON.stringify(f.current);
      }
      return text;
    },
  });
  assert.equal(result.status, "verified");
});

test("real runtime annotation drift still prevents candidate promotion", async () => {
  const f = fixture();
  await assert.rejects(
    run(f, {
      smoke: async () => {
        f.current.metadata.annotations["run.googleapis.com/ingress"] =
          "internal";
        return {};
      },
    }),
  );
  assert.ok(!f.calls.some((c) => c.args.includes("update-traffic")));
});

test("an OCI index pins its root image and verifies the exact Linux AMD64 serving leaf", async () => {
  const f = fixture(),
    original = f.execute;
  const leaf = `sha256:${"e".repeat(64)}`;
  const raw = JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [
      {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        platform: { os: "linux", architecture: "amd64" },
        digest: leaf,
      },
      {
        platform: { os: "unknown", architecture: "unknown" },
        digest: `sha256:${"b".repeat(64)}`,
      },
    ],
  });
  const indexDigest = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
  const indexImage = image.replace(digest, indexDigest);
  const result = await run(f, {
    execute: (binary, args) => {
      if (binary === "docker" && args.includes("imagetools")) return raw + "\n";
      const text = original(binary, args);
      if (binary === "docker" && args.includes("inspect")) {
        const value = JSON.parse(text);
        value[0].RepoDigests = [indexImage];
        return JSON.stringify(value);
      }
      if (args.includes("artifacts"))
        return JSON.stringify({ image_summary: { digest: indexDigest } });
      if (args.includes("update")) {
        f.current.spec.template.spec.containers[0].image = indexImage;
        return JSON.stringify(f.current);
      }
      if (args.includes("revisions")) {
        const revision = JSON.parse(text);
        revision.status.imageDigest = image.replace(digest, leaf);
        return JSON.stringify(revision);
      }
      return text;
    },
  });
  assert.equal(result.image, indexImage);
  assert.equal(result.resolvedImageDigest, image.replace(digest, leaf));
});

for (const kind of ["digest-mismatch", "ambiguous-amd64", "missing-amd64"]) {
  test(`untrusted ${kind} manifest cannot reach Cloud Run mutation`, async () => {
    const f = fixture(),
      original = f.execute;
    const descriptor = {
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      platform: {
        os: "linux",
        architecture: kind === "missing-amd64" ? "arm64" : "amd64",
      },
      digest: `sha256:${"e".repeat(64)}`,
    };
    const raw =
      kind === "digest-mismatch"
        ? manifest
        : JSON.stringify({
            schemaVersion: 2,
            mediaType: "application/vnd.oci.image.index.v1+json",
            manifests:
              kind === "ambiguous-amd64"
                ? [
                    descriptor,
                    { ...descriptor, digest: `sha256:${"f".repeat(64)}` },
                  ]
                : [descriptor],
          });
    const indexDigest = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
    const indexImage = image.replace(digest, indexDigest);
    await assert.rejects(
      run(f, {
        execute: (binary, args) => {
          if (binary === "docker" && args.includes("imagetools"))
            return kind === "digest-mismatch" ? raw + "tampered" : raw;
          const text = original(binary, args);
          if (binary === "docker" && args.includes("inspect")) {
            const value = JSON.parse(text);
            value[0].RepoDigests = [indexImage];
            return JSON.stringify(value);
          }
          if (args.includes("artifacts"))
            return JSON.stringify({ image_summary: { digest: indexDigest } });
          return text;
        },
      }),
    );
    assert.ok(!f.calls.some((c) => c.args.includes("update")));
  });
}
