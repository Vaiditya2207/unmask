import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  previewContext,
  validateBuildRun,
  validateImage,
  cleanupCandidates,
  verifyRouting,
} from "../../scripts/web-preview.mjs";
const sha = "a".repeat(40);
const context = (mode = "deploy") => ({
  GITHUB_EVENT_NAME: mode === "deploy" ? "workflow_run" : "pull_request_target",
  GITHUB_REF: "refs/heads/main",
  GITHUB_REPOSITORY: "Vaiditya2207/unmask",
  GITHUB_REPOSITORY_ID: "1440901935",
  GITHUB_REPOSITORY_OWNER_ID: "145288107",
  GITHUB_WORKFLOW_REF: `Vaiditya2207/unmask/.github/workflows/web-preview-${mode === "deploy" ? "deploy" : "cleanup"}.yml@refs/heads/main`,
  PREVIEW_ENVIRONMENT: "preview",
});
const repo = {
  id: 1440901935,
  full_name: "Vaiditya2207/unmask",
  owner: { id: 145288107 },
};
const pull = () => ({
  number: 12,
  state: "open",
  head: { sha, repo },
  base: { ref: "main", repo },
  merge_commit_sha: "b".repeat(40),
});
const run = () => ({
  id: 123,
  run_attempt: 1,
  workflow_id: 34,
  event: "pull_request",
  status: "completed",
  conclusion: "success",
  path: ".github/workflows/web-preview-build.yml",
  head_sha: sha,
  repository: repo,
  head_repository: repo,
  pull_requests: [{ number: 12, head: { sha, repo: { id: repo.id } } }],
});

test("preview privilege context rejects production, wrong workflows and fork identities", () => {
  assert.equal(
    previewContext(context(), "deploy").service,
    "unmask-web-preview",
  );
  for (const override of [
    { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_REF: "refs/pull/12/head" },
    { GITHUB_REPOSITORY_ID: "other" },
    { PREVIEW_ENVIRONMENT: "production" },
    {
      GITHUB_WORKFLOW_REF: context().GITHUB_WORKFLOW_REF.replace(
        "main",
        "evil",
      ),
    },
  ])
    assert.throws(() =>
      previewContext({ ...context(), ...override }, "deploy"),
    );
});

test("successful exact-run artifacts bind to one current same-repository open head", () => {
  const plan = validateBuildRun(run(), pull(), {
    workflowId: 34,
    runId: 123,
    attempt: 1,
  });
  assert.equal(plan.commit, sha);
  assert.equal(plan.tag, "pr-12");
  const mergeRun = run();
  mergeRun.head_sha = pull().merge_commit_sha;
  assert.equal(
    validateBuildRun(mergeRun, pull(), {
      workflowId: 34,
      runId: 123,
      attempt: 1,
    }).commit,
    sha,
  );
  for (const change of [
    { event: "push" },
    { conclusion: "failure" },
    { path: ".github/workflows/evil.yml" },
    { id: 124 },
    { run_attempt: 2 },
    { workflow_id: 35 },
    { head_sha: "c".repeat(40) },
    { head_repository: { ...repo, id: 7 } },
  ])
    assert.throws(() =>
      validateBuildRun({ ...run(), ...change }, pull(), {
        workflowId: 34,
        runId: 123,
        attempt: 1,
      }),
    );
  for (const change of [
    { state: "closed" },
    { head: { ...pull().head, sha: "c".repeat(40) } },
    { head: { sha, repo: { ...repo, id: 7 } } },
  ])
    assert.throws(() =>
      validateBuildRun(
        run(),
        { ...pull(), ...change },
        { workflowId: 34, runId: 123, attempt: 1 },
      ),
    );
});

test("image inspection requires exact immutable ID, linux amd64 and version/head labels", () => {
  const metadata = {
    imageId: `sha256:${"d".repeat(64)}`,
    commit: sha,
    version: "0.1.1",
  };
  const image = {
    Id: metadata.imageId,
    Os: "linux",
    Architecture: "amd64",
    Config: {
      Labels: {
        "org.opencontainers.image.revision": sha,
        "org.opencontainers.image.version": "0.1.1",
      },
    },
  };
  assert.doesNotThrow(() => validateImage(image, metadata));
  for (const change of [
    { Id: `sha256:${"e".repeat(64)}` },
    { Architecture: "arm64" },
    { Os: "windows" },
    { Config: { Labels: {} } },
  ])
    assert.throws(() => validateImage({ ...image, ...change }, metadata));
});

const service = () => ({
  metadata: { name: "unmask-web-preview" },
  status: {
    traffic: [
      { revisionName: "baseline", percent: 100 },
      {
        revisionName: "other",
        tag: "pr-99",
        url: "https://pr-99---preview.a.run.app",
      },
    ],
  },
});
test("cleanup selects only owned, unserved, untagged revisions for the exact closed PR", () => {
  const revision = (name, pr = "12") => ({
    metadata: {
      name,
      labels: {
        "serving.knative.dev/service": "unmask-web-preview",
        "unmask-preview-owner": "github",
        "unmask-preview-pr": pr,
      },
    },
  });
  const candidates = cleanupCandidates(
    service(),
    [
      revision("unmask-web-preview-pr-12-123"),
      revision("unmask-web-preview-pr-99-123", "99"),
      revision("unmask-web-preview-pr-12-124"),
      revision("other"),
    ],
    12,
  );
  assert.deepEqual(
    candidates.map((item) => item.metadata.name),
    ["unmask-web-preview-pr-12-123", "unmask-web-preview-pr-12-124"],
  );
  const active = service();
  active.status.traffic.push({
    revisionName: candidates[0].metadata.name,
    tag: "keep",
  });
  assert.equal(cleanupCandidates(active, candidates, 12).length, 1);
  assert.throws(() =>
    verifyRouting(
      service(),
      {
        ...service(),
        status: { traffic: [{ revisionName: "evil", percent: 100 }] },
      },
      "pr-12",
    ),
  );
  assert.doesNotThrow(() => verifyRouting(service(), service(), "pr-12"));
});

test("workflow privilege boundaries and shared mutation serialization remain explicit", () => {
  const build = readFileSync(
    new URL("../../.github/workflows/web-preview-build.yml", import.meta.url),
    "utf8",
  );
  const deploy = readFileSync(
    new URL("../../.github/workflows/web-preview-deploy.yml", import.meta.url),
    "utf8",
  );
  const cleanup = readFileSync(
    new URL("../../.github/workflows/web-preview-cleanup.yml", import.meta.url),
    "utf8",
  );
  assert.match(build, /pull_request:/u);
  assert.match(build, /github.event.pull_request.head.sha/u);
  assert.doesNotMatch(
    build,
    /id-token:|secrets\.|contents: write|pull_request_target|google-github/u,
  );
  for (const workflow of [deploy, cleanup]) {
    assert.match(workflow, /group: web-preview-mutations/u);
    assert.match(workflow, /queue: max/u);
    assert.match(workflow, /cancel-in-progress: false/u);
    assert.match(workflow, /ref: main/u);
    assert.doesNotMatch(workflow, /ref:.*head.sha/u);
  }
});

const previewImage = `asia-south1-docker.pkg.dev/unmask-513319/unmask-preview/web@sha256:${"d".repeat(64)}`;
function cloudFixture() {
  const calls = [];
  const config = {
    serviceAccountName:
      "unmask-web-preview@unmask-513319.iam.gserviceaccount.com",
    containers: [
      {
        image: previewImage,
        env: [
          {
            name: "UNMASK_API_URL",
            value: "https://unmask-386156642190.asia-south1.run.app",
          },
        ],
        resources: { limits: { cpu: "1", memory: "512Mi" } },
      },
    ],
  };
  const current = service();
  current.metadata.annotations = { "run.googleapis.com/maxScale": "1" };
  current.spec = {
    traffic: [{ revisionName: "baseline", percent: 100 }],
    template: { metadata: { annotations: {} }, spec: structuredClone(config) },
  };
  current.status.conditions = [{ type: "Ready", status: "True" }];
  const revisions = new Map();
  const add = (name, pr = "12") =>
    revisions.set(name, {
      metadata: {
        name,
        annotations: {},
        labels: {
          "serving.knative.dev/service": "unmask-web-preview",
          "unmask-preview-owner": "github",
          "unmask-preview-pr": pr,
        },
      },
      spec: structuredClone(config),
      status: { imageDigest: previewImage },
    });
  let apiCalls = 0;
  const f = {
    calls,
    current,
    revisions,
    staleAt: Infinity,
    closed: false,
    add,
    api: async () => {
      apiCalls++;
      return {
        ...pull(),
        state: f.closed ? "closed" : "open",
        ...(apiCalls >= f.staleAt
          ? { head: { ...pull().head, sha: "f".repeat(40) } }
          : {}),
      };
    },
    fetchImpl: async (url) =>
      url.endsWith("/version")
        ? Response.json({ version: "0.1.1", commit: sha })
        : new Response("home", { status: 200 }),
    execute(binary, args) {
      calls.push({ binary, args });
      if (binary === "docker") return "";
      if (args[0] === "auth" && args[1] === "list")
        return "unmask-preview-deploy@unmask-513319.iam.gserviceaccount.com";
      if (args[0] === "auth") return "";
      if (args[0] === "artifacts")
        return JSON.stringify({
          image_summary: { digest: `sha256:${"d".repeat(64)}` },
        });
      if (args[1] === "services" && args[2] === "describe")
        return JSON.stringify(current);
      if (args[1] === "services" && args[2] === "update") {
        const name =
          "unmask-web-preview-" + args[args.indexOf("--revision-suffix") + 1];
        add(name);
        current.status.latestReadyRevisionName = name;
        current.status.traffic = current.status.traffic.filter(
          (item) => item.tag !== "pr-12",
        );
        current.status.traffic.push({
          revisionName: name,
          tag: "pr-12",
          url: "https://pr-12---preview.a.run.app",
        });
        return "{}";
      }
      if (args[1] === "services" && args[2] === "update-traffic") {
        current.status.traffic = current.status.traffic.filter(
          (item) => item.tag !== args[args.indexOf("--remove-tags") + 1],
        );
        return "{}";
      }
      if (args[1] === "revisions" && args[2] === "list")
        return JSON.stringify([...revisions.values()]);
      if (args[1] === "revisions" && args[2] === "describe")
        return JSON.stringify(revisions.get(args[3]));
      if (args[1] === "revisions" && args[2] === "delete") {
        revisions.delete(args[3]);
        return "{}";
      }
      throw new Error("Unexpected command");
    },
  };
  return f;
}

test("preview deploy preserves baseline/other tags and never executes PR image code", async () => {
  const { mutatePreview } = await import("../../scripts/web-preview.mjs");
  const f = cloudFixture();
  const plan = {
    ...validateBuildRun(run(), pull(), {
      workflowId: 34,
      runId: 123,
      attempt: 1,
    }),
    version: "0.1.1",
  };
  const result = await mutatePreview({
    ...f,
    mode: "deploy",
    event: {},
    plan,
    metadata: {
      commit: sha,
      version: "0.1.1",
      imageId: `sha256:${"e".repeat(64)}`,
    },
    pause: async () => {},
  });
  assert.equal(result.url, "https://pr-12---preview.a.run.app");
  assert.equal(result.image, previewImage);
  assert.deepEqual(
    f.current.status.traffic.filter((item) => item.percent > 0),
    [{ revisionName: "baseline", percent: 100 }],
  );
  assert.ok(f.current.status.traffic.some((item) => item.tag === "pr-99"));
  const update = f.calls.find((call) => call.args[2] === "update");
  for (const flag of [
    "--no-traffic",
    "--tag",
    "--cpu-throttling",
    "--clear-secrets",
  ])
    assert.ok(update.args.includes(flag));
  assert.equal(update.args[3], "unmask-web-preview");
  assert.equal(
    f.calls.some(
      (call) =>
        call.binary === "docker" &&
        ["run", "build", "exec"].includes(call.args[0]),
    ),
    false,
  );
  assert.equal(
    f.calls.some(
      (call) =>
        call.args.includes("unmask-web") || call.args.includes("unmask"),
    ),
    false,
  );
});

test("stale PR head blocks remote push and service mutation", async () => {
  const { mutatePreview } = await import("../../scripts/web-preview.mjs");
  const f = cloudFixture();
  f.staleAt = 2;
  await assert.rejects(
    mutatePreview({
      ...f,
      mode: "deploy",
      event: {},
      plan: {
        pr: 12,
        commit: sha,
        version: "0.1.1",
        runId: 123,
        attempt: 1,
        tag: "pr-12",
      },
      metadata: {
        commit: sha,
        version: "0.1.1",
        imageId: `sha256:${"e".repeat(64)}`,
      },
    }),
    /Stale/u,
  );
  assert.equal(
    f.calls.some((call) => call.binary === "docker" && call.args[0] === "push"),
    false,
  );
  assert.equal(
    f.calls.some((call) => call.args[2] === "update"),
    false,
  );
});

test("cleanup removes only closed PR tag and verified unserved owned revisions", async () => {
  const { mutatePreview } = await import("../../scripts/web-preview.mjs");
  const f = cloudFixture();
  f.closed = true;
  f.add("unmask-web-preview-pr-12-120-1");
  f.add("unmask-web-preview-pr-12-121-1");
  f.add("unmask-web-preview-pr-99-120-1", "99");
  f.current.status.traffic.push(
    { revisionName: "unmask-web-preview-pr-12-120-1", tag: "pr-12" },
    { revisionName: "unmask-web-preview-pr-12-121-1", tag: "preserve" },
  );
  const result = await mutatePreview({
    ...f,
    mode: "cleanup",
    event: {
      action: "closed",
      number: 12,
      pull_request: { ...pull(), state: "closed" },
    },
  });
  assert.deepEqual(result.removed, ["unmask-web-preview-pr-12-120-1"]);
  assert.ok(f.current.status.traffic.some((item) => item.tag === "preserve"));
  assert.ok(f.current.status.traffic.some((item) => item.tag === "pr-99"));
  assert.equal(
    f.calls
      .find((call) => call.args[2] === "update-traffic")
      .args.includes("--clear-tags"),
    false,
  );
});

test("reopened PR or unexpected preview runtime blocks cleanup mutations", async () => {
  const { mutatePreview } = await import("../../scripts/web-preview.mjs");
  for (const variant of ["reopened", "runtime"]) {
    const f = cloudFixture();
    f.closed = variant !== "reopened";
    if (variant === "runtime")
      f.current.spec.template.spec.containers[0].env.push({
        name: "GEMINI_API_KEY",
        valueFrom: { secretKeyRef: { name: "forbidden" } },
      });
    await assert.rejects(
      mutatePreview({
        ...f,
        mode: "cleanup",
        event: { action: "closed", number: 12, pull_request: pull() },
      }),
    );
    assert.equal(
      f.calls.some((call) =>
        ["update-traffic", "delete"].includes(call.args[2]),
      ),
      false,
    );
  }
});

async function artifactFixture(t, override = {}, extra = []) {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createHash } = await import("node:crypto");
  const { default: tar } = await import("tar-stream");
  const directory = await mkdtemp(join(tmpdir(), "unmask-preview-artifact-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pack = tar.pack();
  pack.entry(
    { name: "manifest.json" },
    JSON.stringify([
      {
        Config: "config.json",
        RepoTags: [`unmask-web-preview-build:${sha}`],
        Layers: [],
      },
    ]),
  );
  for (const entry of extra)
    pack.entry(entry, entry.type === "symlink" ? undefined : "x");
  pack.entry({ name: "config.json" }, "{}");
  pack.finalize();
  const chunks = [];
  for await (const chunk of pack) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const metadata = {
    schemaVersion: "1",
    repository: "Vaiditya2207/unmask",
    headRepository: "Vaiditya2207/unmask",
    headRepositoryId: "1440901935",
    commit: sha,
    version: "0.1.1",
    pr: 12,
    runId: 123,
    attempt: 1,
    imageId: `sha256:${hash("{}")}`,
    imageSha256: hash(bytes),
    ...override,
  };
  const json = JSON.stringify(metadata);
  await writeFile(join(directory, "image.tar"), bytes);
  await writeFile(join(directory, "preview.json"), json);
  await writeFile(
    join(directory, "SHA256SUMS"),
    `${hash(bytes)}  image.tar\n${hash(json)}  preview.json\n`,
  );
  const plan = {
    ...validateBuildRun(run(), pull(), {
      workflowId: 34,
      runId: 123,
      attempt: 1,
    }),
    version: "0.1.1",
  };
  return { directory, plan, metadata };
}

test("artifact validation binds regular files, hashes, identity and safe archive headers", async (t) => {
  const { validateArtifact } = await import("../../scripts/web-preview.mjs");
  const { writeFile, unlink, symlink } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const good = await artifactFixture(t);
  assert.deepEqual(
    await validateArtifact(good.directory, good.plan),
    good.metadata,
  );
  const wrong = await artifactFixture(t, { commit: "f".repeat(40) });
  await assert.rejects(
    validateArtifact(wrong.directory, wrong.plan),
    /identity differs/u,
  );
  for (const entry of [
    { name: "../escape" },
    { name: "linked", type: "symlink", linkname: "../escape" },
  ]) {
    const bad = await artifactFixture(t, {}, [entry]);
    await assert.rejects(validateArtifact(bad.directory, bad.plan), /Unsafe/u);
  }
  await writeFile(join(good.directory, "SHA256SUMS"), "wrong");
  await assert.rejects(
    validateArtifact(good.directory, good.plan),
    /checksum/u,
  );
  const linked = await artifactFixture(t);
  await unlink(join(linked.directory, "preview.json"));
  await symlink(
    join(wrong.directory, "preview.json"),
    join(linked.directory, "preview.json"),
  );
  await assert.rejects(
    validateArtifact(linked.directory, linked.plan),
    /file type/u,
  );
});

test("allowlisted fork runs with empty PR associations bind artifact PR metadata through REST", async () => {
  const { preparePreview } = await import("../../scripts/web-preview.mjs");
  for (const head of [
    {
      id: 1441129169,
      full_name: "Pranay0083/unmask",
      owner: { id: 149870314 },
    },
    {
      id: 1441129131,
      full_name: "visheshrao17/unmask",
      owner: { id: 151499332 },
    },
  ]) {
    const build = { ...run(), pull_requests: [], head_repository: head };
    const pr = { ...pull(), head: { sha, repo: head } };
    const paths = [];
    const api = async (route) => {
      paths.push(route);
      if (route.endsWith("/actions/runs/123")) return build;
      if (route.endsWith("/actions/workflows/web-preview-build.yml"))
        return {
          id: 34,
          path: ".github/workflows/web-preview-build.yml",
          state: "active",
        };
      if (route.includes("/artifacts?"))
        return {
          total_count: 1,
          artifacts: [
            {
              id: 55,
              name: "web-preview-123-1",
              expired: false,
              size_in_bytes: 1000,
              workflow_run: { id: 123 },
            },
          ],
        };
      if (route.endsWith("/pulls/12")) return pr;
      if (route === `/repos/${head.full_name}/contents/package.json?ref=${sha}`)
        return {
          encoding: "base64",
          size: 25,
          content: Buffer.from('{"version":"0.1.1"}').toString("base64"),
        };
      throw new Error("Unexpected REST route");
    };
    const event = {
      action: "completed",
      workflow_run: { id: 123, run_attempt: 1 },
    };
    const initial = await preparePreview({ event, api });
    assert.equal(initial.artifactId, 55);
    assert.equal(initial.pr, undefined);
    const verified = await preparePreview({
      event,
      api,
      metadata: {
        pr: 12,
        commit: sha,
        headRepository: head.full_name,
        headRepositoryId: String(head.id),
      },
    });
    assert.equal(verified.pr, 12);
    assert.equal(verified.version, "0.1.1");
    assert.equal(verified.headRepositoryId, String(head.id));
    assert.ok(
      paths.some((route) =>
        route.startsWith(`/repos/${head.full_name}/contents/`),
      ),
    );
    await assert.rejects(
      preparePreview({
        event,
        api,
        metadata: {
          pr: 12,
          commit: sha,
          headRepository: head.full_name,
          headRepositoryId: "7",
        },
      }),
      /repository or PR identity/u,
    );
    const stale = { ...pr, head: { sha: "f".repeat(40), repo: head } };
    assert.throws(() =>
      validateBuildRun(build, stale, {
        workflowId: 34,
        runId: 123,
        attempt: 1,
        pr: 12,
        commit: sha,
      }),
    );
    const impostor = { ...head, id: head.id + 1 };
    assert.throws(() =>
      validateBuildRun(
        { ...build, head_repository: impostor },
        { ...pr, head: { sha, repo: impostor } },
        { workflowId: 34, runId: 123, attempt: 1, pr: 12, commit: sha },
      ),
    );
  }
});

test("unknown forks and expired or ambiguous build artifacts fail before privileged work", async () => {
  const { preparePreview } = await import("../../scripts/web-preview.mjs");
  assert.throws(() =>
    validateBuildRun(
      {
        ...run(),
        head_repository: {
          id: 7,
          full_name: "unknown/unmask",
          owner: { id: 9 },
        },
      },
      pull(),
      { workflowId: 34, runId: 123, attempt: 1 },
    ),
  );
  for (const variant of ["expired", "duplicate", "wrong-run", "too-large"]) {
    const artifact = {
      id: 55,
      name: "web-preview-123-1",
      expired: variant === "expired",
      size_in_bytes: variant === "too-large" ? 1073741824 + 32769 : 1000,
      workflow_run: { id: variant === "wrong-run" ? 7 : 123 },
    };
    const api = async (route) =>
      route.endsWith("/actions/runs/123")
        ? run()
        : route.endsWith("/actions/workflows/web-preview-build.yml")
          ? {
              id: 34,
              path: ".github/workflows/web-preview-build.yml",
              state: "active",
            }
          : {
              total_count: variant === "duplicate" ? 2 : 1,
              artifacts:
                variant === "duplicate" ? [artifact, artifact] : [artifact],
            };
    await assert.rejects(
      preparePreview({
        event: {
          action: "completed",
          workflow_run: { id: 123, run_attempt: 1 },
        },
        api,
      }),
      /artifact/u,
    );
  }
});

test("artifact size and extra-file bounds reject before Docker load", async (t) => {
  const { validateArtifact, ARTIFACT_LIMITS } =
    await import("../../scripts/web-preview.mjs");
  const { truncate, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const oversized = await artifactFixture(t);
  await truncate(
    join(oversized.directory, "image.tar"),
    ARTIFACT_LIMITS.imageBytes + 1,
  );
  await assert.rejects(
    validateArtifact(oversized.directory, oversized.plan),
    /size/u,
  );
  const extra = await artifactFixture(t);
  await writeFile(
    join(extra.directory, "executable.sh"),
    "should never execute",
  );
  await assert.rejects(
    validateArtifact(extra.directory, extra.plan),
    /exactly three/u,
  );
});

test("inline unprivileged build emits the exact checksummed artifact without shell evaluation", async (t) => {
  const { mkdtemp, writeFile, rm, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const { validateArtifact } = await import("../../scripts/web-preview.mjs");
  const f = await artifactFixture(t);
  const root = await mkdtemp(join(tmpdir(), "unmask-preview-build-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin"),
    output = join(root, "output");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(bin);
  await writeFile(join(root, "package.json"), '{"version":"0.1.1"}');
  await writeFile(
    join(bin, "git"),
    `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(sha)});\n`,
    { mode: 0o700 },
  );
  await writeFile(
    join(bin, "docker"),
    `#!${process.execPath}\nimport{appendFileSync,copyFileSync}from'node:fs';const a=process.argv.slice(2);appendFileSync(process.env.COMMANDS,JSON.stringify(a)+'\\n');if(a[0]==='image')process.stdout.write(JSON.stringify([{Id:'${f.metadata.imageId}'}]));if(a[0]==='save')copyFileSync(process.env.IMAGE_TAR,a[a.indexOf('--output')+1]);`,
    { mode: 0o700 },
  );
  const workflow = readFileSync(
    new URL("../../.github/workflows/web-preview-build.yml", import.meta.url),
    "utf8",
  );
  const marker = "          node --input-type=module <<'NODE'\n";
  const start = workflow.indexOf(marker) + marker.length;
  const script = workflow
    .slice(start, workflow.indexOf("\n          NODE", start))
    .split("\n")
    .map((line) => line.slice(10))
    .join("\n");
  execFileSync(process.execPath, ["--input-type=module"], {
    input: script,
    cwd: root,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      PREVIEW_HEAD: sha,
      PREVIEW_PR: "12",
      PREVIEW_HEAD_REPOSITORY: "Vaiditya2207/unmask",
      PREVIEW_HEAD_REPOSITORY_ID: "1440901935",
      PREVIEW_ARTIFACT: output,
      GITHUB_REPOSITORY: "Vaiditya2207/unmask",
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "1",
      COMMANDS: join(root, "commands"),
      IMAGE_TAR: join(f.directory, "image.tar"),
    },
  });
  assert.equal((await validateArtifact(output, f.plan)).version, "0.1.1");
  const calls = (await readFile(join(root, "commands"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.deepEqual(calls[0].slice(0, 5), [
    "build",
    "--platform",
    "linux/amd64",
    "--file",
    "web/Dockerfile",
  ]);
  assert.ok(calls[0].includes(`RELEASE_COMMIT=${sha}`));
  assert.ok(calls[0].includes("RELEASE_VERSION=0.1.1"));
});

test("real GitHub wrapper permits only exact SHA-bound package content for pinned forks", async () => {
  const { githubAPI } = await import("../../scripts/web-preview.mjs");
  const calls = [];
  const api = githubAPI({
    token: "synthetic-token",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return Response.json({ content: "synthetic" });
    },
  });
  for (const fork of ["Pranay0083/unmask", "visheshrao17/unmask"])
    await api(`/repos/${fork}/contents/package.json?ref=${sha}`);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.redirect, "error");
  for (const route of [
    `/repos/unknown/unmask/contents/package.json?ref=${sha}`,
    "/repos/Pranay0083/unmask/pulls/12",
    "/repos/visheshrao17/unmask/contents/package.json?ref=main",
    `/repos/Pranay0083/unmask/contents/secret.json?ref=${sha}`,
    `/repos/Pranay0083/unmask/contents/package.json?ref=${sha}&other=true`,
  ])
    await assert.rejects(api(route), /Unexpected/u);
  assert.equal(calls.length, 2);
});

test("containerd Docker saves bind OCI index, amd64 manifest, config and layer digests", async (t) => {
  const { validateArtifact } = await import("../../scripts/web-preview.mjs");
  const { writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { createHash } = await import("node:crypto");
  const { default: tar } = await import("tar-stream");
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  for (const variant of ["valid", "config-mismatch", "wrong-platform"]) {
    const f = await artifactFixture(t);
    const config = "{}",
      layer = "synthetic-layer";
    const configHash = hash(config),
      layerHash = hash(layer);
    const runtime = JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: {
        digest: `sha256:${variant === "config-mismatch" ? "f".repeat(64) : configHash}`,
      },
      layers: [{ digest: `sha256:${layerHash}` }],
    });
    const runtimeHash = hash(runtime);
    const root = JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: [
        {
          digest: `sha256:${runtimeHash}`,
          platform: {
            os: "linux",
            architecture: variant === "wrong-platform" ? "arm64" : "amd64",
          },
        },
      ],
    });
    const rootHash = hash(root);
    const pack = tar.pack();
    for (const [name, value] of Object.entries({
      "index.json": JSON.stringify({
        schemaVersion: 2,
        manifests: [{ digest: `sha256:${rootHash}` }],
      }),
      "manifest.json": JSON.stringify([
        {
          Config: `blobs/sha256/${configHash}`,
          RepoTags: [`unmask-web-preview-build:${sha}`],
          Layers: [`blobs/sha256/${layerHash}`],
        },
      ]),
      [`blobs/sha256/${rootHash}`]: root,
      [`blobs/sha256/${runtimeHash}`]: runtime,
      [`blobs/sha256/${configHash}`]: config,
      [`blobs/sha256/${layerHash}`]: layer,
    }))
      pack.entry({ name }, value);
    pack.finalize();
    const chunks = [];
    for await (const chunk of pack) chunks.push(chunk);
    const archive = Buffer.concat(chunks);
    const metadata = JSON.stringify({
      ...f.metadata,
      imageId: `sha256:${rootHash}`,
      imageSha256: hash(archive),
    });
    await writeFile(join(f.directory, "image.tar"), archive);
    await writeFile(join(f.directory, "preview.json"), metadata);
    await writeFile(
      join(f.directory, "SHA256SUMS"),
      `${hash(archive)}  image.tar\n${hash(metadata)}  preview.json\n`,
    );
    if (variant === "valid") {
      const observed = await validateArtifact(f.directory, f.plan);
      assert.equal(observed.imageId, `sha256:${rootHash}`);
      assert.equal(observed.runtimeManifestDigest, `sha256:${runtimeHash}`);
    } else await assert.rejects(validateArtifact(f.directory, f.plan), /OCI/u);
  }
});

test("Cloud Run may canonicalize spec and status only to the proven same-repository OCI leaf", async () => {
  const { mutatePreview } = await import("../../scripts/web-preview.mjs");
  const leaf = `sha256:${"c".repeat(64)}`;
  for (const variant of ["valid-leaf", "wrong-repository", "wrong-leaf"]) {
    const f = cloudFixture();
    const execute = (binary, args) => {
      const result = f.execute(binary, args);
      if (args[1] === "services" && args[2] === "update") {
        const revision = [...f.revisions.values()].at(-1);
        revision.spec.containers[0].image =
          variant === "wrong-repository"
            ? `asia-south1-docker.pkg.dev/unmask-513319/unmask/web@${leaf}`
            : `asia-south1-docker.pkg.dev/unmask-513319/unmask-preview/web@${variant === "wrong-leaf" ? `sha256:${"f".repeat(64)}` : leaf}`;
        revision.status.imageDigest = revision.spec.containers[0].image;
      }
      return result;
    };
    const operation = mutatePreview({
      ...f,
      execute,
      mode: "deploy",
      event: {},
      plan: {
        pr: 12,
        commit: sha,
        version: "0.1.1",
        runId: 123,
        attempt: 1,
        tag: "pr-12",
      },
      metadata: {
        commit: sha,
        version: "0.1.1",
        imageId: `sha256:${"e".repeat(64)}`,
        runtimeManifestDigest: leaf,
      },
      pause: async () => {},
    });
    if (variant === "valid-leaf")
      assert.equal((await operation).status, "verified");
    else await assert.rejects(operation, /digest differs/u);
  }
});
