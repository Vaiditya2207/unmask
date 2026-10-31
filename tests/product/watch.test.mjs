import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { watchLockfile } from "../../src/cli/watch.mjs";

const entrypoint = fileURLToPath(
  new URL("../../src/cli/main.mjs", import.meta.url),
);
function lock(versions) {
  const packages = { "": { name: "app" } };
  for (const [name, version] of Object.entries(versions))
    packages[`node_modules/${name}`] = {
      version,
      resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
      integrity: `sha512-${createHash("sha512")
        .update(name + version)
        .digest("base64")}`,
    };
  return JSON.stringify({ lockfileVersion: 3, packages });
}
async function temp(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "unmask-watch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function until(predicate, label) {
  for (let i = 0; i < 400 && !predicate(); i++) await delay(5);
  assert.ok(predicate(), label);
}

test("watch debounces duplicate events, skips invalid intermediates, never overlaps and cancels honestly", async () => {
  let content = lock({ a: "1.0.0" });
  let fire;
  let closed = false;
  const events = [];
  const started = [];
  let active = 0;
  let maxActive = 0;
  const controller = new AbortController();
  const done = watchLockfile({
    lockfile: "/project/package-lock.json",
    debounceMs: 20,
    signal: controller.signal,
    readText: async () => content,
    watchFactory: (directory, listener) => {
      assert.equal(directory, "/project");
      fire = listener;
      return { close: () => (closed = true) };
    },
    onEvent: (event) => events.push(event),
    checkPackage: (spec, { signal }) => {
      started.push(spec);
      maxActive = Math.max(maxActive, ++active);
      return new Promise((resolve, reject) => {
        const finish = () => (active--, resolve(report(0)));
        const timer = setTimeout(finish, spec === "slow@1.0.0" ? 5000 : 30);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          active--;
          reject(new Error("aborted"));
        });
      });
    },
  });
  const report = (exitCode) => ({
    policy: { exitCode, findings: [] },
    coverage: { complete: true },
  });
  await until(() => events.length === 1, "baseline recorded");
  assert.equal(events[0].type, "baseline");
  assert.equal(events[0].audited, false);

  content = '{"lockfileVersion": 3, "packages": {"node_modu';
  fire("change", "package-lock.json");
  await until(() => events.length === 2, "invalid intermediate reported");
  assert.deepEqual(events[1], {
    type: "lockfile-invalid",
    code: "lockfile-invalid",
  });

  content = lock({ a: "1.0.0", b: "1.0.0" });
  for (let i = 0; i < 5; i++) fire("rename", "package-lock.json");
  fire("change", "unrelated.txt");
  content = lock({ a: "1.0.0", b: "1.0.0", c: "1.0.0" });
  fire("change", "package-lock.json");
  fire("change", "package-lock.json");
  await until(() => started.length === 1, "first check started");
  content = lock({ a: "1.0.0", b: "1.0.0", c: "1.0.0", slow: "1.0.0" });
  fire("change", "package-lock.json");
  await until(() => started.includes("slow@1.0.0"), "coalesced run started");

  const results = events.filter((event) => event.type === "result");
  assert.deepEqual(
    results.map((event) => event.result.checks.map((item) => item.name)),
    [["b", "c"]],
  );
  assert.equal(results[0].result.status, "pass");
  controller.abort();
  const summary = await done;
  assert.equal(closed, true);
  assert.equal(maxActive, 1);
  assert.deepEqual(summary, { runs: 2, interrupted: true, failed: false });
  const last = events.at(-1).result;
  assert.equal(last.status, "cancelled");
  assert.equal(last.exitCode, 2);
  assert.deepEqual(
    last.checks.map((item) => item.status),
    ["cancelled"],
  );
});

test("unmask watch uses real file events and stops on SIGINT with exit 130", async (t) => {
  const root = await temp(t);
  const lockfile = path.join(root, "package-lock.json");
  await writeFile(lockfile, lock({ a: "1.0.0" }));
  const child = spawn(
    process.execPath,
    [
      entrypoint,
      "watch",
      "--lockfile",
      lockfile,
      "--no-check",
      "--debounce-ms",
      "50",
    ],
    { env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] },
  );
  const killer = setTimeout(() => child.kill("SIGKILL"), 10000);
  t.after(() => clearTimeout(killer));
  let stdout = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  await until(() => stdout.includes("baseline recorded"), stdout);
  await writeFile(lockfile, lock({ a: "1.0.0", b: "2.0.0" }));
  await until(() => stdout.includes("preflight incomplete"), stdout);
  assert.match(stdout, /b@2\.0\.0: not-checked \(checks-disabled\)/);
  child.kill("SIGINT");
  const [code] = await once(child, "exit");
  assert.equal(code, 130);
  assert.match(stdout, /watch stopped after 1 run\(s\)\n$/);
});

test("an unexpected run error is reported, keeps the baseline and does not stop watching", async () => {
  let content = lock({ a: "1.0.0" });
  let fire;
  let failNext = true;
  const events = [];
  const controller = new AbortController();
  const done = watchLockfile({
    lockfile: "/project/package-lock.json",
    debounceMs: 10,
    check: false,
    signal: controller.signal,
    readText: async () => content,
    watchFactory: (_directory, listener) => {
      fire = listener;
      return { close() {} };
    },
    onEvent: (event) => {
      if (event.type === "result" && failNext) {
        failNext = false;
        throw new Error("synthetic output failure");
      }
      events.push(event);
    },
  });
  await until(() => events.length === 1, "baseline recorded");
  content = lock({ a: "1.0.0", b: "1.0.0" });
  fire("change", "package-lock.json");
  await until(
    () => events.some((event) => event.type === "run-error"),
    "run error reported",
  );
  fire("change", "package-lock.json");
  await until(
    () => events.some((event) => event.type === "result"),
    "retried after error",
  );
  const result = events.find((event) => event.type === "result").result;
  assert.deepEqual(
    result.changes.added.map((item) => item.name),
    ["b"],
  );
  controller.abort();
  assert.deepEqual(await done, { runs: 2, interrupted: false, failed: false });
});
