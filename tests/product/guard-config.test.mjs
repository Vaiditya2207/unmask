import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { main } from "../../src/cli/main.mjs";
import { runConfig } from "../../src/cli/config.mjs";
import {
  inspectGuardConfig,
  loadGuardSettings,
} from "../../src/core/guard-config.mjs";

async function project(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "unmask-guard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function io(cwd) {
  const out = [],
    err = [];
  return {
    runtime: {
      cwd,
      stdout: { write: (text) => out.push(text) },
      stderr: { write: (text) => err.push(text) },
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

test("config show reports strict defaults without creating files", async (t) => {
  const root = await project(t);
  const run = io(root);
  assert.equal(await main(["config", "show", "--json"], run.runtime), 0);
  const view = JSON.parse(run.out());
  assert.equal(view.source, "default");
  assert.deepEqual(view.settings, {
    profile: "strict",
    unknownDecision: "block",
    blockSeverity: "medium",
    knownMalware: "block",
    aiSignals: "nonbinding",
    enforcement: "enforce",
  });
  assert.deepEqual(view.warnings, []);
  assert.ok(
    view.semantics.some((line) => /no per-setting overrides/.test(line)),
  );
  assert.deepEqual(await readdir(root), []);
});

test("config set writes a private validated file atomically and applies the profile", async (t) => {
  const root = await project(t);
  const run = io("/");
  assert.equal(
    await runConfig(
      ["set", "profile", "balanced", "--project", root],
      run.runtime,
    ),
    0,
  );
  assert.match(run.out(), /Updated profile: strict -> balanced/);
  assert.match(run.err(), /balanced is less restrictive than strict/);
  const file = path.join(root, ".unmask.json");
  assert.deepEqual(await readdir(root), [".unmask.json"]);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(file)), {
    schemaVersion: 1,
    profile: "balanced",
  });
  const loaded = await loadGuardSettings(root);
  assert.equal(loaded.settings.unknownDecision, "unknown");
  assert.equal(loaded.settings.blockSeverity, "high");
});

test("config warns when choosing a less restrictive profile", async (t) => {
  const root = await project(t);
  const run = io(root);
  assert.equal(await runConfig(["set", "profile", "audit"], run.runtime), 0);
  assert.match(run.err(), /audit is less restrictive than strict/);
  const shown = io(root);
  assert.equal(await runConfig(["show"], shown.runtime), 0);
  assert.match(shown.out(), /enforcement: audit/);
  assert.match(shown.err(), /^warning: The audit profile is nonenforcing/);
  assert.equal((await loadGuardSettings(root)).settings.knownMalware, "block");
  assert.equal((await inspectGuardConfig(root)).warnings.length, 1);
});

test("config rejects invalid enums, unknown keys and unsafe unknown handling without writing", async (t) => {
  const root = await project(t);
  for (const args of [
    ["set", "profile", "lenient"],
    ["set", "unknown", "warn"],
    ["set", "blockAtSeverity", "high"],
    ["set", "apiToken", "secret"],
    ["unset", "profile"],
    ["set", "profile"],
    ["show", "--verbose"],
    ["show", "--project", "--json"],
  ]) {
    const run = io(root);
    assert.equal(await runConfig(args, run.runtime), 2, args.join(" "));
    assert.match(run.err(), /^[a-z-]+: /);
  }
  assert.deepEqual(await readdir(root), []);
});

test("config refuses symlinked, shared-writable and malformed configuration", async (t) => {
  const root = await project(t);
  const outside = await project(t);
  const file = path.join(root, ".unmask.json");
  await symlink(path.join(outside, "x.json"), file);
  let run = io(root);
  assert.equal(await runConfig(["show"], run.runtime), 2);
  assert.match(run.err(), /^path-escape:/);
  run = io(root);
  assert.equal(await runConfig(["set", "profile", "strict"], run.runtime), 2);
  assert.match(run.err(), /^path-escape:/);
  assert.deepEqual(await readdir(outside), []);
  await rm(file);

  await writeFile(
    file,
    JSON.stringify({ schemaVersion: 1, profile: "strict" }),
  );
  await chmod(file, 0o666);
  run = io(root);
  assert.equal(await runConfig(["show"], run.runtime), 2);
  assert.match(run.err(), /^unsafe-permissions:/);

  for (const body of [
    "{",
    JSON.stringify({ schemaVersion: 1, profile: "strict", token: "x" }),
    JSON.stringify({ schemaVersion: 2, profile: "strict" }),
    JSON.stringify({
      schemaVersion: 1,
      profile: "strict",
      overrides: { unknownDecision: "allow" },
    }),
  ]) {
    await writeFile(file, body, { mode: 0o600 });
    await chmod(file, 0o600);
    run = io(root);
    assert.equal(await runConfig(["show"], run.runtime), 2, body);
    assert.match(run.err(), /^invalid-(config|value):/);
    assert.equal((await inspectGuardConfig(root)).status, "invalid");
  }
});

test("config rejects a missing project directory", async (t) => {
  const root = await project(t);
  const run = io(root);
  assert.equal(
    await runConfig(
      ["show", "--project", path.join(root, "missing")],
      run.runtime,
    ),
    2,
  );
  assert.match(run.err(), /^invalid-project:/);
});

test("config fails closed without hanging on FIFOs, unreadable or oversized files", async (t) => {
  const root = await project(t);
  const file = path.join(root, ".unmask.json");
  const fifo = spawnSync("mkfifo", [file]);
  assert.equal(fifo.status, 0);
  let result = await inspectGuardConfig(root);
  assert.equal(result.status, "invalid");
  assert.equal(result.code, "invalid-config");
  await rm(file);

  await writeFile(
    file,
    JSON.stringify({ schemaVersion: 1, profile: "strict" }),
    { mode: 0o600 },
  );
  await chmod(file, 0o000);
  result = await inspectGuardConfig(root);
  if (process.getuid?.() !== 0) {
    assert.deepEqual(result, {
      status: "invalid",
      code: "unreadable-config",
      message: "Guard configuration file cannot be read",
    });
    const run = io(root);
    assert.equal(await runConfig(["show"], run.runtime), 2);
    assert.match(run.err(), /^unreadable-config:/);
  }
  await chmod(file, 0o600);

  await writeFile(file, " ".repeat(64 * 1024 + 1));
  result = await inspectGuardConfig(root);
  assert.equal(result.code, "invalid-config");
  assert.match(result.message, /too large/);
});
