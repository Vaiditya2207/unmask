import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  access,
  rm,
  mkdir,
  symlink,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import tar from "tar-stream";
import { analyzeLocal } from "../../src/core/pipeline.mjs";
import { canonicalReport } from "../../src/core/report.mjs";
const entrypoint = fileURLToPath(
  new URL("../../src/cli/main.mjs", import.meta.url),
);
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
async function fixture(t, mutation = false, name = "fixture") {
  const root = await mkdtemp(path.join(os.tmpdir(), "unmask-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = { name, version: "1.0.0" };
  const artifactManifest = {
    ...manifest,
    ...(mutation
      ? {
          scripts: {
            install: `node -e "require('fs').writeFileSync('${root}/EXECUTED','bad')"`,
          },
        }
      : {}),
  };
  const artifact = path.join(root, "artifact.tgz"),
    source = path.join(root, "source.tgz"),
    guard = path.join(root, "no-network.mjs");
  await writeFile(
    artifact,
    await archive(
      {
        "package.json": JSON.stringify(artifactManifest),
        "a.js": "export default 1;",
      },
      "package",
    ),
  );
  await writeFile(
    source,
    await archive(
      { "package.json": JSON.stringify(manifest), "a.js": "export default 1;" },
      "root",
    ),
  );
  await writeFile(
    guard,
    `import net from 'node:net';\nimport http from 'node:http';\nimport https from 'node:https';\nconst deny=()=>{throw new Error('NETWORK FORBIDDEN');};\nglobalThis.fetch=deny;net.Socket.prototype.connect=deny;http.request=deny;https.request=deny;\n`,
  );
  const args = [
    "check",
    "--tarball",
    artifact,
    "--source-archive",
    source,
    "--commit",
    "a".repeat(40),
    "--source-root",
    "root",
    "--offline",
    "--cache-dir",
    path.join(root, "cache"),
    "--out",
    path.join(root, "out"),
  ];
  return { root, artifact, source, guard, args };
}
function run(f, args = f.args) {
  return spawnSync(
    process.execPath,
    ["--import", f.guard, entrypoint, ...args],
    {
      encoding: "utf8",
      timeout: 10000,
      env: { ...process.env, UNMASK_MODEL: "off" },
    },
  );
}

test("real offline CLI returns0, writes validated evidence JSON and HTML, and never uses network", async (t) => {
  const f = await fixture(t);
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(
    await readFile(path.join(f.root, "out/report.json"), "utf8"),
  );
  assert.equal(report.policy.exitCode, 0);
  assert.ok(report.files.every((file) => file.state === "byte-identical"));
  assert.deepEqual(report.model, {
    status: "not-sent",
    reason: "consent-required",
  });
  assert.match(
    await readFile(path.join(f.root, "out/report.html"), "utf8"),
    /Completed report/,
  );
  assert.doesNotMatch(result.stderr, /NETWORK FORBIDDEN/);
});

test("real CLI lifecycle mutation returns3 without ever running its inert install command", async (t) => {
  const f = await fixture(t, true);
  const result = run(f);
  assert.equal(result.status, 3, result.stderr);
  const report = JSON.parse(
    await readFile(path.join(f.root, "out/report.json"), "utf8"),
  );
  assert.deepEqual(
    report.policy.findings.map((f) => f.ruleId),
    ["lifecycle-source-absent"],
  );
  assert.match(
    await readFile(path.join(f.root, "out/report.html"), "utf8"),
    /lifecycle-source-absent/,
  );
  await assert.rejects(access(path.join(f.root, "EXECUTED")));
});

test("real CLI malformed archive returns2 with digest-bound partial JSON and visible failures", async (t) => {
  const f = await fixture(t);
  await writeFile(f.artifact, Buffer.from("broken gzip"));
  const result = run(f);
  assert.equal(result.status, 2, result.stderr);
  const report = JSON.parse(
    await readFile(path.join(f.root, "out/report.json"), "utf8"),
  );
  assert.equal(report.policy.exitCode, 2);
  assert.equal(report.coverage.inventory.lowerBound, true);
  assert.match(
    await readFile(path.join(f.root, "out/report.html"), "utf8"),
    /Incomplete analysis/,
  );
});

test("real CLI missing selected source returns2 but still writes artifact evidence", async (t) => {
  const f = await fixture(t);
  await rm(f.source);
  const result = run(f);
  assert.equal(result.status, 2, result.stderr);
  const report = JSON.parse(
    await readFile(path.join(f.root, "out/report.json"), "utf8"),
  );
  assert.ok(report.files.length > 0);
  assert.equal(report.coverage.compared.bytes, 0);
  assert.ok(report.failures.some((f) => f.code === "source-read-failed"));
});

test("CLI rejects online modes, unknown flags, duplicate options and mutable refs with exit2", async (t) => {
  const f = await fixture(t);
  for (const args of [
    f.args.filter((arg) => arg !== "--offline"),
    [...f.args, "--source", "https://example.com"],
    [...f.args, "--tarball", f.artifact],
    f.args.map((arg) => (arg === "a".repeat(40) ? "main" : arg)),
  ]) {
    const result = run(f, args);
    assert.equal(result.status, 2, result.stderr);
    assert.doesNotMatch(result.stderr, /NETWORK FORBIDDEN/);
  }
  await assert.rejects(access(path.join(f.root, "out/report.json")));
});

test("CLI output never overwrites existing files and escapes hostile identity text", async (t) => {
  const f = await fixture(t, false, "<img src=x onerror=alert(1)>");
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  const html = await readFile(path.join(f.root, "out/report.html"), "utf8");
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img src=x/);
  const before = await readFile(path.join(f.root, "out/report.json"));
  const retry = run(f);
  assert.equal(retry.status, 2, retry.stderr);
  assert.deepEqual(
    await readFile(path.join(f.root, "out/report.json")),
    before,
  );
});

test("npm-style executable symlink invokes the real CLI and writes its report", async (t) => {
  const f = await fixture(t);
  const directory = path.join(f.root, "node_modules", ".bin");
  await mkdir(directory, { recursive: true });
  const bin = path.join(directory, "unmask");
  await symlink(entrypoint, bin);
  const result = spawnSync(bin, f.args, {
    encoding: "utf8",
    timeout: 10000,
    env: {
      ...process.env,
      PATH: path.dirname(process.execPath) + ":" + process.env.PATH,
      NODE_OPTIONS: "--import=" + f.guard,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(
    await readFile(path.join(f.root, "out", "report.json"), "utf8"),
  );
  assert.equal(report.policy.exitCode, 0);
  assert.ok(report.files.length > 0);
});

async function runInjected(f, runtimeSource, args = f.args) {
  const wrapper = path.join(f.root, "model-wrapper.mjs");
  const callsPath = path.join(f.root, "model-calls.json");
  await writeFile(
    wrapper,
    `import {main} from ${JSON.stringify(new URL("../../src/cli/main.mjs", import.meta.url).href)};import {writeFileSync} from 'node:fs';const calls=[];${runtimeSource};const code=await main(process.argv.slice(2),runtime);writeFileSync(${JSON.stringify(callsPath)},JSON.stringify(calls));process.exitCode=code;`,
  );
  const result = spawnSync(
    process.execPath,
    ["--import", f.guard, wrapper, ...args],
    { encoding: "utf8", timeout: 10000 },
  );
  return {
    result,
    calls: JSON.parse(await readFile(callsPath, "utf8")),
    report: JSON.parse(
      await readFile(path.join(f.root, "out/report.json"), "utf8"),
    ),
  };
}

test("CLI without model consent never invokes the shared factory even with invalid configuration", async (t) => {
  const f = await fixture(t);
  const run = await runInjected(
    f,
    `const runtime={env:{UNMASK_MODEL:'invalid'},modelFactory:async()=>{calls.push('factory');throw new Error('must not configure');}}`,
  );
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.deepEqual(run.calls, []);
  assert.deepEqual(run.report.model, {
    status: "not-sent",
    reason: "consent-required",
  });
});

test("CLI consent configures one client and adapts explain with allowLocal and the same signal", async (t) => {
  const f = await fixture(t);
  const run = await runInjected(
    f,
    `const runtime={signal:new AbortController().signal,env:{configuration:'fixture'},modelFactory:async env=>{calls.push('factory');if(env.configuration!=='fixture')throw new Error('wrong environment');return {explain:async(report,options)=>{calls.push('explain');if(options.allowLocal!==true||options.signal!==runtime.signal)throw new Error('wrong explain options');return {status:'unavailable',reason:'synthetic-provider'};}};}}`,
    [...f.args, "--allow-model"],
  );
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.deepEqual(run.calls, ["factory", "explain"]);
  assert.equal(run.report.model.reason, "synthetic-provider");
  assert.equal(run.report.policy.exitCode, 0);
});

test("explicit runtime model callback wins over factory configuration", async (t) => {
  const f = await fixture(t);
  const run = await runInjected(
    f,
    `const runtime={model:async()=>{calls.push('injected');return {status:'disabled'};},modelFactory:async()=>{calls.push('factory');throw new Error('must not configure');}}`,
    [...f.args, "--allow-model"],
  );
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.deepEqual(run.calls, ["injected"]);
  assert.equal(run.report.model.status, "disabled");
});

test("factory configuration failure is sanitized and preserves the deterministic result", async (t) => {
  const f = await fixture(t);
  const run = await runInjected(
    f,
    `const runtime={modelFactory:async()=>{calls.push('factory');throw new Error('SYNTHETIC_SECRET_DO_NOT_LOG');}}`,
    [...f.args, "--allow-model"],
  );
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.deepEqual(run.calls, ["factory"]);
  assert.equal(run.report.model.status, "unavailable");
  assert.equal(run.report.model.reason, "configuration-invalid");
  assert.match(run.result.stderr, /model-configuration-invalid/);
  assert.doesNotMatch(run.result.stderr, /SYNTHETIC_SECRET_DO_NOT_LOG/);
});

test("shared real factory missing quota remains unavailable without a provider request", async (t) => {
  const f = await fixture(t);
  const run = await runInjected(
    f,
    `const runtime={env:{UNMASK_MODEL:'on',UNMASK_MODEL_QUOTA_VERIFIED:'false'}}`,
    [...f.args, "--allow-model"],
  );
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.equal(run.report.model.status, "unavailable");
  assert.equal(run.report.model.reason, "not-configured");
  assert.doesNotMatch(run.result.stderr, /NETWORK FORBIDDEN/);
});

test("real factory rejects conflicting synthetic keys without exposing either value", async (t) => {
  const f = await fixture(t);
  const run = await runInjected(
    f,
    `const runtime={env:{UNMASK_MODEL:'on',UNMASK_MODEL_QUOTA_VERIFIED:'true',GEMINI_API_KEY:'SYNTHETIC_FIRST_SECRET',UNMASK_MODEL_KEY:'SYNTHETIC_SECOND_SECRET'}}`,
    [...f.args, "--allow-model"],
  );
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.equal(run.report.model.reason, "configuration-invalid");
  assert.match(run.result.stderr, /model-configuration-invalid/);
  assert.doesNotMatch(
    run.result.stderr,
    /SYNTHETIC_FIRST_SECRET|SYNTHETIC_SECOND_SECRET/,
  );
});

for (const seam of ["factory", "model"]) {
  test(`local CLI without consent reports not-sent and makes zero ${seam}/provider calls`, async (t) => {
    const f = await fixture(t);
    const runtimeSource = `const deny=name=>{calls.push(name);throw new Error('FORBIDDEN MODEL PATH');};globalThis.fetch=()=>deny('provider');const runtime={env:new Proxy({},{get(){return deny('configuration-read');}}),${seam === "factory" ? "modelFactory:async()=>deny('factory')" : "model:async()=>deny('model')"}}`;
    const run = await runInjected(f, runtimeSource);
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.deepEqual(run.report.model, {
      status: "not-sent",
      reason: "consent-required",
    });
    assert.deepEqual(run.calls, []);
    const expected = await analyzeLocal({
      tarballPath: f.artifact,
      sourceArchivePath: f.source,
      commit: "a".repeat(40),
      sourceRoot: "root",
    });
    assert.equal(canonicalReport(run.report), canonicalReport(expected));
    assert.deepEqual(run.report.source, expected.source);
    assert.deepEqual(run.report.policy, expected.policy);
  });
}
