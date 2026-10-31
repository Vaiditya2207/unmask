import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { compareInventories } from "../../src/core/compare.mjs";
import { createReport } from "../../src/core/report.mjs";

const packageVersion = JSON.parse(
  await readFile(new URL("../../package.json", import.meta.url), "utf8"),
).version;
const versionInfo = {
  version: packageVersion,
  commit: "unknown",
  tarballSha256: "unknown",
};
function fixtureReport() {
  return createReport({
    inputs: {
      artifact: { sha256: "a".repeat(64), sha512: "b".repeat(128) },
      limits: { entries: 20000 },
    },
    source: { status: "unresolved", method: "unresolved", alternatives: [] },
    comparison: compareInventories(
      {
        digest: { sha256: "a".repeat(64) },
        entries: [],
        complete: true,
        failures: [],
      },
      null,
    ),
    manifests: {
      artifact: { status: "unavailable" },
      source: { status: "unavailable" },
      registry: { status: "unavailable" },
    },
  });
}
async function setup(t, body, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "unmask-runtime-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worker = path.join(root, "fixture.mjs");
  await writeFile(
    worker,
    `import { writeFile } from 'node:fs/promises';let s='';for await(const c of process.stdin)s+=c;const r=JSON.parse(s);${body}`,
  );
  const { startServer } = await import("../../src/server/main.mjs");
  const runtime = await startServer({
    host: "127.0.0.1",
    port: 0,
    tempRoot: path.join(root, "jobs"),
    versionInfo,
    modelClient: null,
    enrichJob: null,
    runnerOptions: { workerURL: pathToFileURL(worker) },
    ...options,
  });
  t.after(() => runtime.close());
  return {
    ...runtime,
    root,
    base: `http://127.0.0.1:${runtime.server.address().port}`,
  };
}
async function submit(base) {
  return fetch(`${base}/check`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "package=fixture%401.0.0",
    redirect: "manual",
  });
}
async function completed(base, location) {
  for (let i = 0; i < 200; i++) {
    const response = await fetch(`${base}${location}.json`);
    const body = await response.json();
    if (response.status !== 202) return body;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("report did not complete");
}

test("main serves real HTTP lifecycle using a diagnostic fixture worker", async (t) => {
  const f = await setup(
    t,
    `await writeFile(r.workDir+'/report.json',${JSON.stringify(JSON.stringify(fixtureReport()))});`,
  );
  assert.deepEqual(
    await (await fetch(`${f.base}/version`)).json(),
    versionInfo,
  );
  assert.equal((await fetch(`${f.base}/healthz`)).status, 200);
  const response = await submit(f.base);
  assert.equal(response.status, 303);
  const location = response.headers.get("location");
  const result = await completed(f.base, location);
  assert.equal(result.policy.exitCode, 0);
  const rendered = await fetch(`${f.base}${location}`);
  assert.equal(rendered.status, 200);
  assert.match(await rendered.text(), /a{64}/);
  assert.deepEqual(await readdir(path.join(f.root, "jobs")), []);
  await f.close();
  await assert.rejects(fetch(`${f.base}/healthz`));
});

test("main shutdown kills an active child and waits for cleanup before resolving", async (t) => {
  const f = await setup(
    t,
    "await writeFile(r.workDir+'/pid',String(process.pid));setInterval(()=>{},1000);",
  );
  assert.equal((await submit(f.base)).status, 303);
  let pid;
  for (let i = 0; i < 200; i++) {
    const [job] = await readdir(path.join(f.root, "jobs"));
    if (job) {
      try {
        pid = Number(
          await readFile(path.join(f.root, "jobs", job, "pid"), "utf8"),
        );
        if (pid > 0) break;
      } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(pid, "worker ready");
  await f.close();
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.deepEqual(await readdir(path.join(f.root, "jobs")), []);
});

test("default entrypoint reports honest development metadata", async () => {
  const { loadVersionInfo } = await import("../../src/server/main.mjs");
  assert.deepEqual(await loadVersionInfo(), versionInfo);
});

test("trusted worker rejects malformed requests without writing output", async (t) => {
  const { spawn } = await import("node:child_process");
  const root = await mkdtemp(path.join(os.tmpdir(), "unmask-worker-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = spawn(
    process.execPath,
    [new URL("../../src/server/worker.mjs", import.meta.url).pathname],
    { cwd: root, env: {}, stdio: ["pipe", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (data) => {
    output += data;
  });
  child.stderr.on("data", (data) => {
    output += data;
  });
  const result = new Promise((resolve) => child.once("close", resolve));
  child.stdin.end(
    JSON.stringify({
      spec: "https://bad.example",
      workDir: root,
      maxResultBytes: 100,
    }),
  );
  assert.equal(await result, 1);
  assert.equal(output, "");
  assert.deepEqual(await readdir(root), []);
});

test("version endpoint metadata binds clean build commit and external tarball digest", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "unmask-version-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = path.join(root, "version.json");
  const { loadVersionInfo } = await import("../../src/server/main.mjs");
  const metadata = {
    version: packageVersion,
    commit: "c".repeat(40),
    dirty: false,
    sourceSha256: "b".repeat(64),
  };
  await writeFile(filename, JSON.stringify(metadata));
  const options = {
    metadataURL: pathToFileURL(filename),
    tarballSha256: "d".repeat(64),
  };
  assert.deepEqual(await loadVersionInfo(options), {
    version: packageVersion,
    commit: "c".repeat(40),
    tarballSha256: "d".repeat(64),
  });
  await writeFile(filename, JSON.stringify({ ...metadata, dirty: true }));
  assert.equal((await loadVersionInfo(options)).commit, "unknown");
  await assert.rejects(
    loadVersionInfo({ ...options, tarballSha256: "bad" }),
    /version|digest/,
  );
});

test("main HTTP request runs trusted worker and real registry analyzer against recorded inert transport", async (t) => {
  const { gzipSync } = await import("node:zlib");
  const { createHash } = await import("node:crypto");
  const { default: tar } = await import("tar-stream");
  const { startServer } = await import("../../src/server/main.mjs");
  const root = await mkdtemp(path.join(os.tmpdir(), "unmask-online-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function tgz(prefix, files) {
    const pack = tar.pack();
    const chunks = [];
    const drain = (async () => {
      for await (const chunk of pack) chunks.push(chunk);
    })();
    for (const [name, value] of Object.entries(files))
      pack.entry({ name: `${prefix}/${name}`, mtime: new Date(0) }, value);
    pack.finalize();
    await drain;
    return gzipSync(Buffer.concat(chunks));
  }
  const commit = "a".repeat(40);
  const manifest = { name: "fixture", version: "1.0.0" };
  const artifact = await tgz("package", {
    "package.json": JSON.stringify({
      ...manifest,
      scripts: { install: "node SHOULD_NEVER_EXECUTE" },
    }),
    "index.js": "export default 1;",
  });
  const source = await tgz(`demo-${commit}`, {
    "package.json": JSON.stringify(manifest),
    "index.js": "export default 1;",
  });
  const tarballURL = "https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz";
  const registryURL = "https://registry.npmjs.org/fixture/1.0.0";
  const sourceURL = `https://codeload.github.com/fixture/demo/tar.gz/${commit}`;
  const metadata = Buffer.from(
    JSON.stringify({
      ...manifest,
      repository: { type: "git", url: "https://github.com/fixture/demo.git" },
      gitHead: commit,
      dist: {
        tarball: tarballURL,
        integrity: `sha512-${createHash("sha512").update(artifact).digest("base64")}`,
      },
    }),
  );
  const captured = {
    [registryURL]: "registry.json",
    [tarballURL]: "artifact.tgz",
    [sourceURL]: "source.tgz",
  };
  await writeFile(path.join(root, "registry.json"), metadata);
  await writeFile(path.join(root, "artifact.tgz"), artifact);
  await writeFile(path.join(root, "source.tgz"), source);
  const worker = path.join(root, "recorded-transport.mjs");
  await writeFile(
    worker,
    `import {readFile,writeFile,readdir} from 'node:fs/promises';
const root=${JSON.stringify(root)},captured=${JSON.stringify(captured)},requests=[];
globalThis.fetch=async(url,options)=>{if(!captured[url])throw new Error('unrecorded-transport');if(options.redirect!=='error'||options.credentials!=='omit')throw new Error('unsafe-transport-options');if((await readdir(process.cwd())).includes('blobs'))throw new Error('duplicate-web-cache');requests.push(url);await writeFile(root+'/requests.json',JSON.stringify(requests));const bytes=await readFile(root+'/'+captured[url]);return new Response(bytes,{status:200,headers:{'content-length':String(bytes.length)}});};
const {workerMain}=await import(${JSON.stringify(new URL("../../src/server/worker.mjs", import.meta.url).href)});await workerMain().catch(async(error)=>{await writeFile(root+'/error.json',JSON.stringify({message:error.message,stack:error.stack}));throw error;});`,
  );
  const runtime = await startServer({
    host: "127.0.0.1",
    port: 0,
    tempRoot: path.join(root, "jobs"),
    versionInfo,
    modelClient: null,
    enrichJob: null,
    runnerOptions: { workerURL: pathToFileURL(worker) },
  });
  t.after(() => runtime.close());
  const base = `http://127.0.0.1:${runtime.server.address().port}`;
  const response = await submit(base);
  assert.equal(response.status, 303);
  const result = await completed(base, response.headers.get("location"));
  assert.equal(
    result.policy?.exitCode,
    3,
    await readFile(path.join(root, "error.json"), "utf8").catch(() =>
      JSON.stringify(result),
    ),
  );
  assert.deepEqual(
    result.policy.findings.map((finding) => finding.ruleId),
    ["lifecycle-source-absent"],
  );
  assert.equal(result.inputs.artifact.kind, "registry");
  assert.equal(result.inputs.sourceArchive.kind, "remote");
  assert.equal(
    result.inputs.artifact.sha256,
    createHash("sha256").update(artifact).digest("hex"),
  );
  assert.equal(
    result.inputs.sourceArchive.sha256,
    createHash("sha256").update(source).digest("hex"),
  );
  assert.equal(result.model.status, "disabled");
  assert.equal(result.run.surface, "web");
  assert.deepEqual(
    JSON.parse(await readFile(path.join(root, "requests.json"), "utf8")),
    [registryURL, tarballURL, sourceURL],
  );
  assert.deepEqual(await readdir(path.join(root, "jobs")), []);
});

test("executable main honors HOST and PORT and exits cleanly on SIGTERM", async (t) => {
  const { spawn } = await import("node:child_process");
  const root = await mkdtemp(path.join(os.tmpdir(), "unmask-main-process-"));
  const child = spawn(
    process.execPath,
    [new URL("../../src/server/main.mjs", import.meta.url).pathname],
    {
      env: { HOST: "127.0.0.1", PORT: "0", TMPDIR: root },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const exited = new Promise((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );
  t.after(async () => {
    child.kill("SIGKILL");
    await exited;
    await rm(root, { recursive: true, force: true });
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const address = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(new Error("main-startup-timeout")),
      5000,
    );
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = /UNMASK listening on (127\.0\.0\.1:[0-9]+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    exited.then(() => {
      clearTimeout(timer);
      reject(new Error("main-exited-before-listen"));
    });
  });
  const response = await fetch(`http://${address}/version`);
  assert.deepEqual(await response.json(), versionInfo);
  child.kill("SIGTERM");
  assert.deepEqual(await exited, { code: 0, signal: null });
  assert.equal(stderr, "");
});

test("model configuration is disabled until explicitly enabled and quota verified", async () => {
  const { modelClientFromEnv } = await import("../../src/model/config.mjs");
  assert.equal(await modelClientFromEnv({}), undefined);
  assert.equal(await modelClientFromEnv({ UNMASK_MODEL: "off" }), undefined);
  assert.equal(
    await modelClientFromEnv({
      UNMASK_MODEL: "on",
      UNMASK_MODEL_QUOTA_VERIFIED: "false",
    }),
    undefined,
  );
  const env = {
    UNMASK_MODEL: "on",
    GEMINI_API_KEY: "inert-fixture-key",
    UNMASK_MODEL_QUOTA_VERIFIED: "true",
    UNMASK_MODEL_REQUESTS_PER_MINUTE: "2",
    UNMASK_MODEL_INPUT_TOKENS_PER_MINUTE: "8000",
    UNMASK_MODEL_DAILY_REQUESTS: "10",
  };
  const client = await modelClientFromEnv(env);
  assert.equal(client.configuration.enabled, true);
  assert.equal(client.modelId, "gemini-3-flash-preview");
  assert.match(client.configHash, /^[a-f0-9]{64}$/);
  assert.ok(
    !JSON.stringify(client.configuration).includes("inert-fixture-key"),
  );
  const alias = await modelClientFromEnv({
    ...env,
    UNMASK_MODEL_KEY: env.GEMINI_API_KEY,
  });
  assert.equal(alias.configHash, client.configHash);
  for (const change of [
    { UNMASK_MODEL_KEY: "different-inert-key" },
    { UNMASK_MODEL_REQUESTS_PER_MINUTE: "0" },
    { UNMASK_MODEL_INPUT_TOKENS_PER_MINUTE: "8e3" },
    { UNMASK_MODEL_QUOTA_VERIFIED: "yes" },
    { UNMASK_MODEL_PROVIDER: "unregistered" },
    { GEMINI_API_KEY: "" },
    { UNMASK_MODEL_ID: "unknown" },
  ])
    await assert.rejects(
      modelClientFromEnv({ ...env, ...change }),
      /config|quota|model|key|provider/i,
    );
});

test("a second process failing the same HTTP bind cannot sweep the first server active job", async (t) => {
  const { spawn } = await import("node:child_process");
  const f = await setup(
    t,
    `await writeFile(r.workDir+'/ready','ready');const {readFile}=await import('node:fs/promises');for(;;){try{await readFile(r.workDir+'/go');break;}catch{}await new Promise(resolve=>setTimeout(resolve,5));}await writeFile(r.workDir+'/report.json',${JSON.stringify(JSON.stringify(fixtureReport()))});`,
  );
  const response = await submit(f.base);
  const location = response.headers.get("location");
  let job;
  for (let i = 0; i < 1000; i++) {
    [job] = await readdir(path.join(f.root, "jobs"));
    if (
      job &&
      (await readFile(path.join(f.root, "jobs", job, "ready"), "utf8").catch(
        () => "",
      )) === "ready"
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(
    await readFile(path.join(f.root, "jobs", job, "ready"), "utf8"),
    "ready",
  );
  const script = path.join(f.root, "second-server.mjs");
  await writeFile(
    script,
    `import {startServer} from ${JSON.stringify(new URL("../../src/server/main.mjs", import.meta.url).href)};try{await startServer(${JSON.stringify({ host: "127.0.0.1", port: f.server.address().port, tempRoot: path.join(f.root, "jobs"), versionInfo, modelClient: null, enrichJob: null })});process.exitCode=2;}catch(error){console.log(error.code);}`,
  );
  const child = spawn(process.execPath, [script], {
    env: {},
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const exited = new Promise((resolve) => child.once("close", resolve));
  t.after(async () => {
    child.kill("SIGKILL");
    await exited;
  });
  assert.equal(await exited, 0);
  assert.match(output, /EADDRINUSE/);
  assert.equal(
    await readFile(path.join(f.root, "jobs", job, "ready"), "utf8"),
    "ready",
  );
  await writeFile(path.join(f.root, "jobs", job, "go"), "go");
  assert.equal((await completed(f.base, location)).policy.exitCode, 0);
});

test("shared model configuration imports without server modules and retains the server export", async (t) => {
  const { modelClientFromEnv } = await import("../../src/model/config.mjs");
  const main = await import("../../src/server/main.mjs");
  assert.equal(main.modelClientFromEnv, modelClientFromEnv);
  const root = await mkdtemp(path.join(os.tmpdir(), "unmask-model-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ["config", "client", "summary"])
    await writeFile(
      path.join(root, `${name}.mjs`),
      await readFile(new URL(`../../src/model/${name}.mjs`, import.meta.url)),
    );
  const { spawn } = await import("node:child_process");
  const script = path.join(root, "probe.mjs");
  await writeFile(
    script,
    `import assert from 'node:assert/strict';import {modelClientFromEnv} from './config.mjs';assert.equal(await modelClientFromEnv({}),undefined);const client=await modelClientFromEnv({UNMASK_MODEL:'on',GEMINI_API_KEY:'inert-fixture-key',UNMASK_MODEL_QUOTA_VERIFIED:'true',UNMASK_MODEL_REQUESTS_PER_MINUTE:'2',UNMASK_MODEL_INPUT_TOKENS_PER_MINUTE:'8000',UNMASK_MODEL_DAILY_REQUESTS:'10'});assert.equal(client.configuration.enabled,true);assert.equal(client.modelId,'gemini-3-flash-preview');console.log('standalone-config-ok');`,
  );
  const child = spawn(process.execPath, [script], {
    env: {},
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const exited = new Promise((resolve) => child.once("close", resolve));
  t.after(async () => {
    child.kill("SIGKILL");
    await exited;
  });
  assert.equal(await exited, 0, output);
  assert.equal(output.trim(), "standalone-config-ok");
});

test("hosted main defaults to real OSV adapter once per job through synthetic transport", async (t) => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    const value = String(url);
    if (value.startsWith("http://127.0.0.1:"))
      return originalFetch(url, options);
    assert.equal(value, "https://api.osv.dev/v1/query");
    requests.push({ url: value, options });
    assert.deepEqual(JSON.parse(options.body), {
      package: { name: "fixture", ecosystem: "npm" },
      version: "1.0.0",
    });
    assert.equal(options.method, "POST");
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "manual");
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({
      vulns: [{ id: "GHSA-synthetic-0001", summary: "Synthetic advisory" }],
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const report = fixtureReport();
  const runtime = await setup(
    t,
    `await writeFile(r.workDir+'/report.json',${JSON.stringify(JSON.stringify(report))});`,
    { enrichJob: undefined },
  );
  const first = await submit(runtime.base);
  const location = first.headers.get("location");
  const second = await submit(runtime.base);
  assert.equal(second.headers.get("location"), location);
  assert.deepEqual(await completed(runtime.base, location), report);
  const details = await (
    await fetch(runtime.base + location + ".details.json")
  ).json();
  assert.equal(details.vulnerabilityCheck.source, "OSV");
  assert.equal(details.vulnerabilityCheck.status, "found");
  assert.equal(details.vulnerabilityCheck.complete, true);
  assert.equal(
    details.vulnerabilityCheck.advisories[0].id,
    "GHSA-synthetic-0001",
  );
  assert.equal(
    details.scope.knownVulnerabilities,
    "queried-exact-package-only",
  );
  assert.equal(requests.length, 1);
  await fetch(runtime.base + location + ".details.json");
  await fetch(runtime.base + location + ".json");
  assert.equal((await submit(runtime.base)).headers.get("location"), location);
  assert.equal(requests.length, 1);
});
