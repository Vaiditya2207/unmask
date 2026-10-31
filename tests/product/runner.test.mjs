import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readdir,
  readFile,
  rm,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRunner } from "../../src/server/runner.mjs";
import { compareInventories } from "../../src/core/compare.mjs";
import { createReport } from "../../src/core/report.mjs";
import { policyResult } from "../../src/core/policy.mjs";

function report() {
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
async function setup(t, body) {
  const root = await mkdtemp(path.join(os.tmpdir(), "unmask-runner-test-"));
  const fixture = { root };
  t.after(async () => {
    await fixture.cleanup?.();
    await rm(root, { recursive: true, force: true });
  });
  const worker = path.join(root, "worker.mjs");
  await writeFile(
    worker,
    `import {writeFile} from 'node:fs/promises';\nlet input='';for await(const chunk of process.stdin)input+=chunk;const request=JSON.parse(input);\n${body}`,
  );
  const tempRoot = path.join(root, "jobs");
  return Object.assign(fixture, { worker, tempRoot });
}

test("isolated runner returns a validated child result and preserves unmarked directories", async (t) => {
  const f = await setup(
    t,
    `await writeFile(request.workDir+'/report.json',${JSON.stringify(JSON.stringify(report()))});`,
  );
  await mkdir(path.join(f.tempRoot, "job-0123456789abcdef0123456789abcdef"), {
    recursive: true,
  });
  await writeFile(path.join(f.tempRoot, "keep.txt"), "unrelated");
  const run = await createRunner({
    tempRoot: f.tempRoot,
    workerURL: new URL(`file://${f.worker}`),
  });
  const result = await run("fixture@1.0.0", {});
  assert.equal(result.policy.exitCode, 0);
  assert.deepEqual(await readdir(f.tempRoot), [
    "job-0123456789abcdef0123456789abcdef",
    "keep.txt",
  ]);
  assert.equal(
    await readFile(path.join(f.tempRoot, "keep.txt"), "utf8"),
    "unrelated",
  );
});

test("timeout and external abort kill a real worker before cleanup and release the slot", async (t) => {
  const f = await setup(t, "setInterval(()=>{},1000);");
  const run = await createRunner({
    tempRoot: f.tempRoot,
    workerURL: new URL(`file://${f.worker}`),
    deterministicMs: 50,
  });
  await assert.rejects(run("fixture@1.0.0", {}), /timeout/);
  assert.deepEqual(await readdir(f.tempRoot), []);
  const controller = new AbortController();
  const result = run("fixture@1.0.0", { signal: controller.signal });
  controller.abort();
  await assert.rejects(result, /aborted/);
  assert.deepEqual(await readdir(f.tempRoot), []);
});

test("worker failure, oversized output and concurrent invocation fail without leaking provider data", async (t) => {
  const f = await setup(
    t,
    "console.error('private provider details');process.exitCode=1;",
  );
  const run = await createRunner({
    tempRoot: f.tempRoot,
    workerURL: new URL(`file://${f.worker}`),
  });
  await assert.rejects(
    run("fixture@1.0.0", {}),
    (error) => error.message === "analysis-worker-failed",
  );
  await writeFile(
    f.worker,
    "import {writeFile} from 'node:fs/promises';let s='';for await(const c of process.stdin)s+=c;const r=JSON.parse(s);await writeFile(r.workDir+'/report.json','x'.repeat(101));",
  );
  const bounded = await createRunner({
    tempRoot: f.tempRoot,
    workerURL: new URL(`file://${f.worker}`),
    maxResultBytes: 100,
  });
  const first = bounded("fixture@1.0.0", {});
  await assert.rejects(bounded("other@1.0.0", {}), /busy/);
  await assert.rejects(first, /result-cap/);
  assert.deepEqual(await readdir(f.tempRoot), []);
});

test("the real child receives no inherited environment or runtime options", async (t) => {
  const f = await setup(
    t,
    `if (process.env.UNMASK_TEST_PRIVATE || process.env.NODE_OPTIONS || process.env.HOME || process.env.PATH) process.exit(9); if (!process.execArgv.includes('--max-old-space-size=512')) process.exit(10); await writeFile(request.workDir+'/report.json',${JSON.stringify(JSON.stringify(report()))});`,
  );
  process.env.UNMASK_TEST_PRIVATE = "inert-private-marker";
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = "--no-warnings";
  t.after(() => {
    delete process.env.UNMASK_TEST_PRIVATE;
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
  });
  const run = await createRunner({ tempRoot: f.tempRoot, workerURL: f.worker });
  assert.equal((await run("fixture@1.0.0")).policy.exitCode, 0);
});

test("external cancellation waits for actual child exit before removing its private directory", async (t) => {
  const f = await setup(
    t,
    "await writeFile(request.workDir+'/pid',String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);",
  );
  const run = await createRunner({ tempRoot: f.tempRoot, workerURL: f.worker });
  const controller = new AbortController();
  const pending = run("fixture@1.0.0", { signal: controller.signal });
  pending.catch(() => {});
  t.after(async () => {
    controller.abort();
    await pending.catch(() => {});
  });
  let workDir, pid;
  for (let i = 0; i < 2000; i++) {
    const entries = await readdir(f.tempRoot);
    workDir = entries[0] && path.join(f.tempRoot, entries[0]);
    if (workDir) {
      try {
        pid = Number(await readFile(path.join(workDir, "pid"), "utf8"));
        if (pid > 0) break;
      } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(pid, "child readiness recorded");
  process.kill(pid, 0);
  controller.abort();
  await assert.rejects(pending, /aborted/);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.deepEqual(await readdir(f.tempRoot), []);
});

test("missing, invalid and symlink report output never escapes validation or cleanup", async (t) => {
  for (const body of [
    "",
    "await writeFile(request.workDir+'/report.json','{}');",
    "const {symlink}=await import('node:fs/promises');await symlink('../keep.txt',request.workDir+'/report.json');",
  ]) {
    const f = await setup(t, body);
    const run = await createRunner({
      tempRoot: f.tempRoot,
      workerURL: f.worker,
    });
    await writeFile(
      path.join(f.tempRoot, "keep.txt"),
      JSON.stringify(report()),
    );
    await assert.rejects(run("fixture@1.0.0"));
    assert.deepEqual(await readdir(f.tempRoot), ["keep.txt"]);
  }
});

test("model runs in parent after child exit and cannot change deterministic results", async (t) => {
  const f = await setup(
    t,
    `await writeFile(request.workDir+'/pid',String(process.pid));await writeFile(request.workDir+'/report.json',${JSON.stringify(JSON.stringify(report()))});`,
  );
  const modelClient = {
    async explain(input) {
      const [job] = await readdir(f.tempRoot);
      const pid = Number(
        await readFile(path.join(f.tempRoot, job, "pid"), "utf8"),
      );
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      input.policy.exitCode = 3;
      return { status: "completed", marker: "inert model section" };
    },
  };
  const run = await createRunner({
    tempRoot: f.tempRoot,
    workerURL: f.worker,
    modelClient,
  });
  const result = await run("fixture@1.0.0");
  assert.equal(result.policy.exitCode, 0);
  assert.equal(result.model.status, "completed");
  assert.deepEqual(await readdir(f.tempRoot), []);
});

test("model rejection preserves deterministic policy and records unavailable status", async (t) => {
  const f = await setup(
    t,
    `await writeFile(request.workDir+'/report.json',${JSON.stringify(JSON.stringify(report()))});`,
  );
  const run = await createRunner({
    tempRoot: f.tempRoot,
    workerURL: f.worker,
    modelClient: {
      async explain(input) {
        input.policy.exitCode = 3;
        throw new Error("private provider failure");
      },
    },
  });
  const result = await run("fixture@1.0.0");
  assert.equal(result.policy.exitCode, 0);
  assert.equal(result.model.status, "unavailable");
  assert.ok(!JSON.stringify(result).includes("private provider failure"));
});

test("model deadline aborts the explanation at 90 seconds without changing policy", async (t) => {
  const f = await setup(
    t,
    `await writeFile(request.workDir+'/report.json',${JSON.stringify(JSON.stringify(report()))});`,
  );
  let modelSignal;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const run = await createRunner({
    tempRoot: f.tempRoot,
    workerURL: f.worker,
    modelClient: {
      explain(input, { signal }) {
        modelSignal = signal;
        queueMicrotask(() => t.mock.timers.tick(90000));
        return new Promise(() => {});
      },
    },
  });
  const result = await run("fixture@1.0.0");
  assert.equal(result.policy.exitCode, 0);
  assert.equal(result.model.status, "timeout");
  assert.equal(modelSignal.aborted, true);
});

test("invalid invocation cannot leave an unowned running child or consume the slot", async (t) => {
  const f = await setup(
    t,
    `await writeFile(request.workDir+'/report.json',${JSON.stringify(JSON.stringify(report()))});`,
  );
  const run = await createRunner({ tempRoot: f.tempRoot, workerURL: f.worker });
  await assert.rejects(run({ bad: true }), /invalid-package|Expected exact/);
  await assert.rejects(run("fixture@1.0.0", { signal: {} }), /signal/);
  assert.deepEqual(await readdir(f.tempRoot), []);
  assert.equal((await run("fixture@1.0.0")).policy.exitCode, 0);
});

test("model cancellation releases the slot and cleans the exited worker job", async (t) => {
  const f = await setup(
    t,
    `await writeFile(request.workDir+'/report.json',${JSON.stringify(JSON.stringify(report()))});`,
  );
  const controller = new AbortController();
  let signal;
  const run = await createRunner({
    tempRoot: f.tempRoot,
    workerURL: f.worker,
    modelClient: {
      explain(input, options) {
        signal = options.signal;
        queueMicrotask(() => controller.abort());
        return new Promise(() => {});
      },
    },
  });
  await assert.rejects(
    run("fixture@1.0.0", { signal: controller.signal }),
    /aborted/,
  );
  assert.equal(signal.aborted, true);
  assert.deepEqual(await readdir(f.tempRoot), []);
});

test("model failure and oversized attachment respect the byte cap at the deterministic report boundary", async (t) => {
  const base = report();
  base.inputs.artifact.expectedIntegrity = {
    status: "mismatch",
    algorithm: "sha256",
    digest: "c".repeat(64),
  };
  base.policy = policyResult(base);
  assert.equal(base.policy.findings[0].ruleId, "integrity-mismatch");
  const encoded = JSON.stringify(base);
  for (const explain of [
    async () => {
      throw new Error("inert model error");
    },
    async () => ({ status: "completed", text: "x".repeat(1000) }),
  ]) {
    for (const extra of [0, 3]) {
      const f = await setup(
        t,
        `await writeFile(request.workDir+'/report.json',${JSON.stringify(encoded)});`,
      );
      const cap = Buffer.byteLength(encoded) + extra;
      const run = await createRunner({
        tempRoot: f.tempRoot,
        workerURL: f.worker,
        maxResultBytes: cap,
        modelClient: { explain },
      });
      const result = await run("fixture@1.0.0");
      assert.ok(Buffer.byteLength(JSON.stringify(result)) <= cap);
      assert.equal(result.model.status, extra === 0 ? "failed" : "unavailable");
      assert.deepEqual(result.policy, base.policy);
      assert.deepEqual(await readdir(f.tempRoot), []);
    }
  }
});

test("crash recovery preserves a live inherited lease and sweeps after actual worker exit", async (t) => {
  const { spawn } = await import("node:child_process");
  const f = await setup(
    t,
    "await writeFile(request.workDir+'/pid',String(process.pid));setInterval(()=>{},1000);",
  );
  const script = path.join(f.root, "owner.mjs");
  await writeFile(
    script,
    `import {createRunner} from ${JSON.stringify(new URL("../../src/server/runner.mjs", import.meta.url).href)};const run=await createRunner(${JSON.stringify({ tempRoot: f.tempRoot, workerURL: f.worker })});await run('fixture@1.0.0');`,
  );
  const owner = spawn(process.execPath, [script], { env: {}, stdio: "ignore" });
  const exited = new Promise((resolve) => owner.once("close", resolve));
  let pid, job;
  f.cleanup = async () => {
    owner.kill("SIGKILL");
    await exited;
    if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
      for (let i = 0; i < 1000; i++) {
        try {
          process.kill(pid, 0);
        } catch {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    await createRunner({ tempRoot: f.tempRoot, workerURL: f.worker });
  };
  for (let i = 0; i < 1000; i++) {
    [job] = await readdir(f.tempRoot).catch(() => []);
    if (job)
      pid = Number(
        await readFile(path.join(f.tempRoot, job, "pid"), "utf8").catch(
          () => "",
        ),
      );
    if (pid > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(pid > 0);
  owner.kill("SIGKILL");
  await exited;
  process.kill(pid, 0);
  await createRunner({ tempRoot: f.tempRoot, workerURL: f.worker });
  assert.equal(
    await readFile(path.join(f.tempRoot, job, "pid"), "utf8"),
    String(pid),
  );
  process.kill(pid, "SIGKILL");
  for (let i = 0; i < 1000; i++) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") break;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  await Promise.all([
    createRunner({ tempRoot: f.tempRoot, workerURL: f.worker }),
    createRunner({ tempRoot: f.tempRoot, workerURL: f.worker }),
  ]);
  assert.deepEqual(await readdir(f.tempRoot), []);
});

test("deterministic JSON normalization cannot return more than the configured result cap", async (t) => {
  const encoded = JSON.stringify(report()).replace(
    '"entries":20000',
    '"entries":2e4',
  );
  const f = await setup(
    t,
    `await writeFile(request.workDir+'/report.json',${JSON.stringify(encoded)});`,
  );
  const run = await createRunner({
    tempRoot: f.tempRoot,
    workerURL: f.worker,
    maxResultBytes: Buffer.byteLength(encoded),
  });
  await assert.rejects(run("fixture@1.0.0"), /result-cap/);
  assert.deepEqual(await readdir(f.tempRoot), []);
});
