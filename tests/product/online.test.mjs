import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { createApp } from "../../src/server/app.mjs";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import tar from "tar-stream";
import { analyzeRegistry } from "../../src/core/online.mjs";
import { canonicalReport, validateReport } from "../../src/core/report.mjs";

const commit = "a".repeat(40);
const hash = (bytes, algorithm = "sha256", encoding = "hex") =>
  createHash(algorithm).update(bytes).digest(encoding);
async function archive(files, prefix) {
  const pack = tar.pack(),
    chunks = [];
  const drain = (async () => {
    for await (const chunk of pack) chunks.push(chunk);
  })();
  for (const [name, body] of Object.entries(files))
    pack.entry({ name: `${prefix}/${name}`, mtime: new Date(0) }, body);
  pack.finalize();
  await drain;
  return gzipSync(Buffer.concat(chunks));
}
async function fixture(
  t,
  {
    integrity,
    sourceFailure = false,
    noSource = false,
    mutation = false,
    delays = {},
    sourceFiles = {},
    repositoryDirectory,
  } = {},
) {
  const workDir = await mkdtemp(path.join(os.tmpdir(), "unmask-online-"));
  t.after(() => rm(workDir, { recursive: true, force: true }));
  const manifest = { name: "fixture", version: "1.0.0" };
  const artifact = await archive(
    {
      "package.json": JSON.stringify({
        ...manifest,
        ...(mutation ? { scripts: { install: "node inert.js" } } : {}),
      }),
      "index.js": "export default 1;",
    },
    "package",
  );
  const source = await archive(
    {
      "package.json": JSON.stringify(manifest),
      "index.js": "export default 1;",
      ...sourceFiles,
    },
    `repo-${commit}`,
  );
  const metadata = {
    ...manifest,
    dist: {
      tarball: "https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz",
      integrity:
        typeof integrity === "function"
          ? integrity(artifact)
          : (integrity ?? `sha512-${hash(artifact, "sha512", "base64")}`),
    },
    ...(!noSource
      ? {
          repository: {
            url: "git+https://github.com/example/repo.git",
            ...(repositoryDirectory === undefined
              ? {}
              : { directory: repositoryDirectory }),
          },
          gitHead: commit,
        }
      : {}),
  };
  const metadataBytes = Buffer.from(JSON.stringify(metadata));
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, "error");
    const kind = url.startsWith("https://codeload.github.com/")
      ? "source"
      : url.endsWith(".tgz")
        ? "artifact"
        : "registry";
    if (delays[kind])
      await new Promise((resolve) => setTimeout(resolve, delays[kind]));
    if (kind === "source" && sourceFailure)
      return new Response("unavailable", { status: 404 });
    return new Response(
      kind === "source"
        ? source
        : kind === "artifact"
          ? artifact
          : metadataBytes,
      { status: 200 },
    );
  };
  return {
    workDir,
    fetchImpl,
    calls,
    metadataBytes,
    artifact,
    source,
    metadata,
  };
}

test("registry pipeline uses digest-bound metadata, publisher trust and the same deterministic local core", async (t) => {
  const f = await fixture(t);
  const report = await analyzeRegistry("fixture@1.0.0", f);
  assert.equal(validateReport(report), report);
  assert.equal(report.policy.exitCode, 0);
  assert.equal(report.inputs.registryDocument.sha256, hash(f.metadataBytes));
  assert.equal(report.inputs.artifact.sha256, hash(f.artifact));
  assert.equal(report.inputs.artifact.kind, "registry");
  assert.equal(report.inputs.sourceArchive.kind, "remote");
  assert.equal(report.inputs.artifact.expectedIntegrity.algorithm, "sha512");
  assert.equal(report.inputs.artifact.expectedIntegrity.status, "match");
  assert.deepEqual(report.inputs.claim, { name: "fixture", version: "1.0.0" });
  assert.equal(report.source.method, "publisher-gitHead");
  assert.ok(report.files.every((file) => file.state === "byte-identical"));
  assert.deepEqual(report.manifests.registry.value, f.metadata);
  assert.equal(report.model.status, "disabled");
  assert.equal(canonicalReport(report).includes(f.workDir), false);
});

test("opposite fetch delays preserve canonical parity and artifact-first retention", async (t) => {
  const a = await fixture(t, { delays: { artifact: 15, source: 1 } }),
    b = await fixture(t, { delays: { artifact: 1, source: 15 } });
  const limits = { retentionBudgetBytes: 57 };
  const first = await analyzeRegistry("fixture@1.0.0", { ...a, limits });
  const second = await analyzeRegistry("fixture@1.0.0", { ...b, limits });
  assert.equal(canonicalReport(first), canonicalReport(second));
  assert.equal(first.manifests.artifact.status, "usable");
  assert.equal(first.manifests.source.status, "unavailable");
});

test("selected source acquisition failure emits incomplete artifact evidence and never upgrades trust", async (t) => {
  const f = await fixture(t, { sourceFailure: true });
  const report = await analyzeRegistry("fixture@1.0.0", f);
  assert.equal(report.policy.exitCode, 2);
  assert.ok(report.files.length > 0);
  assert.ok(
    report.failures.some((item) => item.code === "source-acquisition-failed"),
  );
  assert.ok(report.files.every((file) => file.state === "not-compared"));
  assert.equal(report.source.method, "publisher-gitHead");
});

test("missing publisher full-SHA source is completed artifact inspection, not source absence", async (t) => {
  const f = await fixture(t, { noSource: true, mutation: true });
  const report = await analyzeRegistry("fixture@1.0.0", f);
  assert.equal(report.policy.exitCode, 0);
  assert.equal(report.source.status, "unresolved");
  assert.equal(
    f.calls.some((url) => url.includes("codeload")),
    false,
  );
});

test("supported integrity mismatch is retained as exact policy while malformed recognized SRI is incomplete", async (t) => {
  const bad = await fixture(t, {
    integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
  });
  const mismatch = await analyzeRegistry("fixture@1.0.0", bad);
  assert.equal(mismatch.policy.exitCode, 3);
  assert.ok(
    mismatch.policy.findings.some(
      (item) => item.ruleId === "integrity-mismatch",
    ),
  );
  const malformed = await fixture(t, { integrity: "sha512-not-a-real-digest" });
  const incomplete = await analyzeRegistry("fixture@1.0.0", malformed);
  assert.equal(incomplete.policy.exitCode, 2);
  assert.ok(
    incomplete.failures.some(
      (item) => item.code === "invalid-registry-integrity",
    ),
  );
});

test("SHA1-only metadata remains explicitly unsupported, with no false integrity verification", async (t) => {
  const f = await fixture(t, {
    integrity: `sha1-${Buffer.alloc(20, 1).toString("base64")}`,
  });
  const report = await analyzeRegistry("fixture@1.0.0", f);
  assert.equal(report.policy.exitCode, 0);
  assert.equal(report.inputs.artifact.expectedIntegrity.status, "unavailable");
  assert.equal(
    report.inputs.artifact.expectedIntegrity.reason,
    "unsupported-algorithm",
  );
  assert.notEqual(
    report.inputs.artifact.provenance?.verificationImplemented,
    true,
  );
});

test("strongest supported SRI wins, with alternatives at that same strength accepted", async (t) => {
  const f = await fixture(t, {
    integrity: (artifact) =>
      `sha256-${hash(artifact, "sha256", "base64")} sha512-${Buffer.alloc(64, 2).toString("base64")}`,
  });
  const mismatch = await analyzeRegistry("fixture@1.0.0", f);
  assert.equal(mismatch.inputs.artifact.expectedIntegrity.algorithm, "sha512");
  assert.equal(mismatch.policy.exitCode, 3);
  const alternatives = await fixture(t, {
    integrity: (artifact) =>
      `sha512-${Buffer.alloc(64, 2).toString("base64")} sha512-${hash(artifact, "sha512", "base64")}`,
  });
  assert.equal(
    (await analyzeRegistry("fixture@1.0.0", alternatives)).policy.exitCode,
    0,
  );
});

test("configured advisory model cannot mutate the deterministic registry report or policy", async (t) => {
  const f = await fixture(t);
  const before = await analyzeRegistry("fixture@1.0.0", f);
  const after = await analyzeRegistry("fixture@1.0.0", {
    ...f,
    model: async (input) => {
      input.source.method = "provenance-verified";
      input.policy.exitCode = 3;
      return { status: "unavailable", reason: "fixture" };
    },
  });
  assert.equal(canonicalReport(after), canonicalReport(before));
  assert.deepEqual(after.policy, before.policy);
  assert.equal(after.model.status, "unavailable");
});

test("real hosted registry CLI and API produce identical canonical reports with recorded acquisition", async (t) => {
  const f = await fixture(t);
  const expected = await analyzeRegistry("fixture@1.0.0", f);
  const app = createApp({
    versionInfo: { version: "0.0.0", commit, tarballSha256: "b".repeat(64) },
    runAnalysis: (spec) => analyzeRegistry(spec, f),
  });
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        app.closeAllConnections();
        app.close(resolve);
      }),
  );
  const entrypoint = fileURLToPath(
    new URL("../../src/cli/main.mjs", import.meta.url),
  );
  const child = spawn(
    process.execPath,
    [
      entrypoint,
      "check",
      "fixture@1.0.0",
      "--out",
      path.join(f.workDir, "out"),
    ],
    {
      env: {
        PATH: process.env.PATH,
        UNMASK_SERVER_URL: `http://127.0.0.1:${app.address().port}`,
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  let status;
  try {
    [status] = await once(child, "exit");
  } finally {
    clearTimeout(timer);
  }
  assert.equal(status, 0, stderr);
  const actual = JSON.parse(
    await readFile(path.join(f.workDir, "out/report.json"), "utf8"),
  );
  assert.equal(canonicalReport(actual), canonicalReport(expected));
});

test("online metadata normalization preserves syntax parser, effective limits and inspection evidence", async (t) => {
  const f = await fixture(t);
  const report = await analyzeRegistry("fixture@1.0.0", f);
  assert.equal(report.inputs.syntaxParser, "acorn@8.19.0");
  assert.equal(report.inputs.limits.syntax.fileBytes, 2097152);
  assert.ok(report.coverage.syntaxInspected.bytes > 0);
  assert.ok(report.annotations.some((item) => item.type === "syntax-scope"));
  assert.equal(report.inputs.registryDocument.sha256, hash(f.metadataBytes));
  assert.equal(report.policy.exitCode, 0);
});

test("server cache-disabled analysis keeps only single captured copies while the job is active", async (t) => {
  const f = await fixture(t);
  let active;
  const report = await analyzeRegistry("fixture@1.0.0", {
    ...f,
    persistCache: false,
    model: async () => {
      const entries = await readdir(f.workDir, {
        recursive: true,
        withFileTypes: true,
      });
      const files = entries
        .filter((entry) => entry.isFile())
        .map((entry) => path.join(entry.parentPath, entry.name));
      active = {
        files,
        bytes: (await Promise.all(files.map((file) => readFile(file)))).reduce(
          (sum, bytes) => sum + bytes.length,
          0,
        ),
      };
      return { status: "disabled" };
    },
  });
  assert.equal(report.policy.exitCode, 0);
  assert.equal(active.files.length, 3);
  assert.equal(
    active.bytes,
    f.metadataBytes.length + f.artifact.length + f.source.length,
  );
  assert.ok(
    active.files.every((file) => !file.includes(`${path.sep}blobs${path.sep}`)),
  );
  assert.deepEqual(await readdir(f.workDir), []);
});

test("online source mapping never chooses the first of multiple same-name manifests", async (t) => {
  const sourceFiles = {
    "docs/package.json": JSON.stringify({ name: "fixture", version: "9.9.9" }),
  };
  const ambiguous = await fixture(t, { sourceFiles });
  const unresolved = await analyzeRegistry("fixture@1.0.0", ambiguous);
  assert.equal(unresolved.policy.exitCode, 2);
  assert.equal(unresolved.source.status, "unresolved");
  assert.equal(unresolved.source.reason, "ambiguous-manifest");
  assert.ok(unresolved.files.every((file) => file.state === "not-compared"));
  const explicit = await fixture(t, { sourceFiles, repositoryDirectory: "" });
  const selected = await analyzeRegistry("fixture@1.0.0", explicit);
  assert.equal(selected.policy.exitCode, 0);
  assert.equal(selected.source.directory, "");
  assert.ok(selected.files.every((file) => file.state === "byte-identical"));
});

test("registry augmentation preserves source cues exactly once and adds metadata-bound divergence", async (t) => {
  const f = await fixture(t, { mutation: true });
  const report = await analyzeRegistry("fixture@1.0.0", f);
  const source = report.cues.filter(
    (c) => c.ruleId === "manifest-lifecycle-source-absent",
  );
  assert.equal(source.length, 1);
  assert.equal(source[0].priority, "HIGH");
  const registry = report.cues.filter(
    (c) =>
      c.ruleId === "manifest-registry-runtime-divergence" &&
      c.field === "/scripts/install",
  );
  assert.equal(registry.length, 1);
  assert.equal(
    registry[0].bindings.find((b) => b.side === "registry").documentSha256,
    hash(f.metadataBytes),
  );
  assert.equal(report.policy.exitCode, 3);
});
