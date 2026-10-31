import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import tar from "tar-stream";
import { createApp } from "../../src/server/app.mjs";
import { analyzeLocal } from "../../src/core/pipeline.mjs";
import { renderCheckSummary, safeText } from "../../src/cli/terminal.mjs";

const entrypoint = fileURLToPath(
  new URL("../../src/cli/main.mjs", import.meta.url),
);
const versionInfo = {
  version: "0.0.0",
  commit: "b".repeat(40),
  tarballSha256: "c".repeat(64),
};
async function temp(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "unmask-terminal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function archive(manifest, prefix) {
  const pack = tar.pack(),
    chunks = [];
  const drain = (async () => {
    for await (const chunk of pack) chunks.push(chunk);
  })();
  pack.entry(
    { name: `${prefix}/package.json`, mtime: new Date(0) },
    JSON.stringify(manifest),
  );
  pack.finalize();
  await drain;
  return gzipSync(Buffer.concat(chunks));
}
async function fixture(t, lifecycle = false) {
  const root = await temp(t);
  const manifest = { name: "fixture", version: "1.0.0" };
  const paths = {
    tarballPath: path.join(root, "artifact.tgz"),
    sourceArchivePath: path.join(root, "source.tgz"),
  };
  await writeFile(
    paths.tarballPath,
    await archive(
      lifecycle
        ? { ...manifest, scripts: { install: "inert synthetic text" } }
        : manifest,
      "package",
    ),
  );
  await writeFile(paths.sourceArchivePath, await archive(manifest, "root"));
  return { root, manifest, ...paths };
}
async function run(args, { cwd, env = {} }) {
  const child = spawn(process.execPath, [entrypoint, ...args], {
    cwd,
    env: { PATH: process.env.PATH, UNMASK_MODEL: "off", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  try {
    const [code] = await once(child, "exit");
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

test("hosted check without --out prints AI, advisories, coverage and next actions and writes no files", async (t) => {
  const f = await fixture(t, true);
  const report = await analyzeLocal({
    tarballPath: f.tarballPath,
    sourceArchivePath: f.sourceArchivePath,
    sourceRoot: "root",
    commit: "d".repeat(40),
    claim: f.manifest,
  });
  report.model = {
    status: "complete",
    summary: "The artifact adds an install script absent from source.",
    assessment: {
      source: "model",
      summary: "The artifact adds an install script absent from source.",
      checkedScope: "package.json lifecycle scripts",
      uncertainty: "Script intent is not executed or verified.",
      nextAction: "Compare the install script with the upstream repository.",
    },
    hypotheses: [
      {
        explanation: "Install script added only in the artifact.",
        evidenceIds: [],
      },
    ],
  };
  const server = createApp({
    versionInfo,
    runAnalysis: async () => report,
    enrichJob: async () => ({
      schemaVersion: "1",
      source: "OSV",
      package: { ecosystem: "npm", name: "fixture", version: "1.0.0" },
      queriedAt: new Date(0).toISOString(),
      status: "found",
      complete: true,
      reasons: [],
      advisories: [
        {
          id: "GHSA-test-0001",
          summary: "Embedded malicious code",
          databaseSeverity: "CRITICAL",
        },
      ],
      pagesFetched: 1,
      limits: {},
    }),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const cwd = await temp(t);
  const result = await run(["check", "fixture@1.0.0"], {
    cwd,
    env: { UNMASK_SERVER_URL: `http://127.0.0.1:${server.address().port}` },
  });
  assert.equal(result.code, 3, result.stderr);
  assert.deepEqual(await readdir(cwd), []);
  for (const pattern of [
    /^UNMASK fixture@1\.0\.0$/m,
    /Deterministic findings need review \(exit 3\)/,
    /Coverage  complete: 1 file, /,
    /lifecycle-source-absent \(script install\)/,
    /Advisory  1 known for this exact version \(OSV\)/,
    /GHSA-test-0001 \[CRITICAL\] Embedded malicious code/,
    /AI        complete, 1 hypothesis/,
    /Summary: The artifact adds an install script absent from source\./,
    /Scope: package\.json lifecycle scripts/,
    /Uncertainty: Script intent is not executed or verified\./,
    /AI suggests: Compare the install script with the upstream repository\./,
    /Install script added only in the artifact\./,
    /do not install this version/,
    /Add --out DIR/,
  ])
    assert.match(result.stdout, pattern);
});

test("offline check without --out keeps exit semantics, reports AI consent and creates no report files", async (t) => {
  const f = await fixture(t);
  const result = await run(
    [
      "check",
      "--offline",
      "--tarball",
      f.tarballPath,
      "--source-archive",
      f.sourceArchivePath,
      "--commit",
      "a".repeat(40),
      "--source-root",
      "root",
      "--cache-dir",
      path.join(f.root, "cache"),
    ],
    { cwd: f.root },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual((await readdir(f.root)).sort(), [
    "artifact.tgz",
    "cache",
    "source.tgz",
  ]);
  assert.match(result.stdout, /No deterministic findings/);
  assert.match(
    result.stdout,
    /AI        not-sent \(consent-required\); no AI summary/,
  );
  assert.match(result.stdout, /Advisory  not assessed in this check/);
  assert.match(result.stdout, /not proof of safety/);
});

test("summary escapes terminal control characters and never claims safety for unavailable AI or advisories", () => {
  assert.equal(safeText("a\u001b[31mb\u202e"), "a\\u001b[31mb\\u202e");
  assert.equal(
    safeText("a\u2060b\u061cc\u180ed\u2064"),
    "a\\u2060b\\u061cc\\u180ed\\u2064",
  );
  const summary = renderCheckSummary(
    {
      inputs: { claim: { name: "evil\u001b]0;x\u0007", version: "1.0.0" } },
      source: { status: "unresolved", method: "unresolved" },
      coverage: {
        complete: false,
        sourceAvailable: false,
        inventory: { files: 2, bytes: 2048, lowerBound: true },
        states: {},
      },
      failures: [{ code: "archive-read-failed" }],
      policy: { exitCode: 2, findings: [] },
      model: { status: "unavailable", reason: "quota\u001b[2J" },
    },
    {
      details: {
        vulnerabilityCheck: {
          status: "unavailable",
          reasons: ["lookup-failed"],
        },
      },
      outDir: "/tmp/out",
    },
  );
  assert.doesNotMatch(summary, /\u001b|\u0007/);
  assert.match(summary, /Incomplete analysis; no verdict is claimed/);
  assert.match(summary, /at least 2 files, 2\.0 KB/);
  assert.match(summary, /Advisory  unavailable \(lookup-failed\)/);
  assert.match(summary, /AI        unavailable \(quota\\u001b\[2J\)/);
  assert.match(summary, /Open \/tmp\/out\/report\.html/);
  assert.doesNotMatch(summary, /No deterministic findings/);
});
