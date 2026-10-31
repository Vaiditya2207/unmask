import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import tar from "tar-stream";
import { analyzeLocal } from "../../src/core/pipeline.mjs";
import { canonicalReport, validateReport } from "../../src/core/report.mjs";

async function tgz(files, prefix) {
  const pack = tar.pack();
  const chunks = [];
  const drain = (async () => {
    for await (const chunk of pack) chunks.push(chunk);
  })();
  for (const [name, content] of Object.entries(files))
    pack.entry({ name: `${prefix}/${name}`, mtime: new Date(0) }, content);
  pack.finalize();
  await drain;
  return gzipSync(Buffer.concat(chunks));
}
async function fixture(t, artifact = {}, source = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "unmask-pipeline-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = JSON.stringify({ name: "fixture", version: "1.0.0" });
  const artifactBytes = await tgz(
    { "package.json": manifest, "a.js": "export default 1;", ...artifact },
    "package",
  );
  const sourceBytes = await tgz(
    { "package.json": manifest, "a.js": "export default 1;", ...source },
    "root",
  );
  await writeFile(path.join(root, "artifact.tgz"), artifactBytes);
  await writeFile(path.join(root, "source.tgz"), sourceBytes);
  return {
    root,
    artifactBytes,
    sourceBytes,
    options: {
      tarballPath: path.join(root, "artifact.tgz"),
      sourceArchivePath: path.join(root, "source.tgz"),
      commit: "a".repeat(40),
      sourceRoot: "root",
      cacheDir: path.join(root, "cache"),
    },
  };
}

test("offline pipeline binds original blobs and compares matching inventories without network", async (t) => {
  const f = await fixture(t);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("Network must not be used");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const report = await analyzeLocal(f.options);
  assert.equal(validateReport(report), report);
  assert.equal(report.policy.exitCode, 0);
  assert.equal(report.source.method, "user-full-SHA");
  assert.ok(report.files.every((file) => file.state === "byte-identical"));
  assert.equal(
    report.inputs.artifact.sha256,
    createHash("sha256").update(f.artifactBytes).digest("hex"),
  );
  assert.equal(
    report.inputs.sourceArchive.sha256,
    createHash("sha256").update(f.sourceBytes).digest("hex"),
  );
  assert.equal(report.inputs.limits.retentionBudgetBytes, 134217728);
  assert.equal(report.model.status, "disabled");
  assert.equal(report.inputs.artifact.kind, "local");
  assert.equal(report.inputs.sourceArchive.kind, "local");
  assert.deepEqual(await readFile(f.options.tarballPath), f.artifactBytes);
  assert.equal(canonicalReport(report).includes(f.root), false);
  const blobs = await readdir(path.join(f.options.cacheDir, "blobs", "sha256"));
  assert.deepEqual(
    blobs.sort(),
    [report.inputs.artifact.sha256, report.inputs.sourceArchive.sha256].sort(),
  );
  assert.deepEqual(
    await readFile(
      path.join(
        f.options.cacheDir,
        "blobs",
        "sha256",
        report.inputs.artifact.sha256,
      ),
    ),
    f.artifactBytes,
  );
});

test("offline lifecycle mutation creates exact source-absent finding without target execution", async (t) => {
  const value = {
    name: "fixture",
    version: "1.0.0",
    scripts: { install: "node NEVER-EXECUTE.js" },
  };
  const f = await fixture(t, {
    "package.json": JSON.stringify(value),
    "NEVER-EXECUTE.js": 'throw new Error("Target executed")',
  });
  const report = await analyzeLocal(f.options);
  assert.equal(report.policy.exitCode, 3);
  assert.deepEqual(
    report.policy.findings.map((f) => f.ruleId),
    ["lifecycle-source-absent"],
  );
  assert.ok(report.policy.findings[0].evidenceIds.length >= 2);
});

test("selected missing source emits incomplete artifact report while no source claim is completed inspection", async (t) => {
  const f = await fixture(t);
  const partial = await analyzeLocal({
    ...f.options,
    sourceArchivePath: path.join(f.root, "absent.tgz"),
  });
  assert.equal(partial.policy.exitCode, 2);
  assert.ok(partial.failures.some((f) => f.code === "source-read-failed"));
  assert.equal(partial.coverage.compared.bytes, 0);
  assert.ok(partial.files.every((f) => f.state === "not-compared"));
  const inspection = await analyzeLocal({ tarballPath: f.options.tarballPath });
  assert.equal(inspection.policy.exitCode, 0);
  assert.equal(inspection.source.status, "unresolved");
});

test("malformed accepted bytes are digest-bound incomplete output, never internal-error placeholders", async (t) => {
  const f = await fixture(t);
  const malformed = Buffer.from("not a gzip archive");
  await writeFile(f.options.tarballPath, malformed);
  const report = await analyzeLocal(f.options);
  assert.equal(report.policy.exitCode, 2);
  assert.equal(
    report.inputs.artifact.sha256,
    createHash("sha256").update(malformed).digest("hex"),
  );
  assert.equal(report.coverage.inventory.lowerBound, true);
});

test("compressed cap refuses oversized input before allocation and selected source cap keeps accepted artifact", async (t) => {
  const f = await fixture(t, {}, { "large.txt": "x".repeat(10000) });
  await assert.rejects(
    analyzeLocal({ ...f.options, limits: { compressedBytes: 1 } }),
    (error) => error.code === "artifact-compressed-cap" && error.exitCode === 2,
  );
  const cap = f.artifactBytes.length;
  assert.ok(f.sourceBytes.length > cap);
  const report = await analyzeLocal({
    ...f.options,
    limits: { compressedBytes: cap },
  });
  assert.equal(report.policy.exitCode, 2);
  assert.ok(report.failures.some((f) => f.code === "source-compressed-cap"));
});

test("explicit root and full SHA are required and package selection never silently falls back", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    analyzeLocal({ ...f.options, commit: "main" }),
    (error) => error.exitCode === 2,
  );
  await assert.rejects(
    analyzeLocal({ ...f.options, sourceRoot: "../root" }),
    (error) => error.exitCode === 2,
  );
  const report = await analyzeLocal({ ...f.options, sourceDir: "missing" });
  assert.equal(report.policy.exitCode, 2);
  assert.equal(report.source.status, "unresolved");
  assert.ok(report.files.every((f) => f.state === "not-compared"));
});

test("artifact and source share one retention budget while full hashes still establish correspondence", async (t) => {
  const f = await fixture(t);
  const retainedBytes =
    Buffer.byteLength(JSON.stringify({ name: "fixture", version: "1.0.0" })) +
    Buffer.byteLength("export default 1;");
  const report = await analyzeLocal({
    ...f.options,
    sourceDir: "",
    limits: { retentionBudgetBytes: retainedBytes },
  });
  assert.equal(report.manifests.artifact.status, "usable");
  assert.equal(report.manifests.source.status, "unavailable");
  assert.equal(report.manifests.source.reason, "retention-cap");
  assert.ok(report.files.every((file) => file.state === "byte-identical"));
  assert.equal(report.coverage.compared.bytes, retainedBytes);
});

test("local pipeline inspects retained JavaScript before release and preserves paired source citations", async (t) => {
  const f = await fixture(
    t,
    { "a.js": "fetch('https://collector.invalid/log')" },
    { "a.js": "const target='https://collector.invalid/log';" },
  );
  const report = await analyzeLocal(f.options);
  assert.equal(report.inputs.syntaxParser, "acorn@8.19.0");
  assert.equal(report.inputs.limits.syntax.fileBytes, 2097152);
  assert.ok(report.coverage.syntaxInspected.bytes > 0);
  const cue = report.cues.find((item) => item.ruleId === "syntax-network-call");
  assert.equal(cue.literalStatus, "found-in-inspected-source");
  assert.ok(
    cue.evidenceIds.some(
      (id) => report.evidence.find((item) => item.id === id)?.side === "source",
    ),
  );
  assert.equal(report.policy.exitCode, 0);
  assert.equal(
    report.files.find((item) => item.path === "a.js").state,
    "changed",
  );
});

test("offline pipeline emits dependency and bin observations without changing default exit policy", async (t) => {
  const f = await fixture(t, {
    "package.json": JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      dependencies: { newdep: "1.0.0" },
      bin: { fixture: "bin/new.js" },
    }),
  });
  const report = await analyzeLocal(f.options);
  assert.ok(
    report.cues.some(
      (c) =>
        c.ruleId === "manifest-runtime-dependency-added" &&
        c.priority === "MEDIUM",
    ),
  );
  assert.ok(
    report.cues.some(
      (c) =>
        c.ruleId === "manifest-entrypoint-source-absent" &&
        c.field === "/bin/fixture" &&
        c.priority === "HIGH",
    ),
  );
  assert.equal(report.policy.exitCode, 0);
});
