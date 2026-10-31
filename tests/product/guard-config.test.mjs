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
    unknown: "block",
    blockAtSeverity: "moderate",
    knownMalware: "block",
    aiSignals: "nonbinding",
    enforcement: "enforcing",
  });
  assert.ok(
    view.semantics.some((line) => /never reported as permitted/.test(line)),
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
  assert.equal(
    await runConfig(
      ["set", "blockAtSeverity", "critical", "--project", root],
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
    overrides: { blockAtSeverity: "critical" },
  });
  const loaded = await loadGuardSettings(root);
  assert.equal(loaded.settings.unknown, "warn");
  assert.equal(loaded.settings.blockAtSeverity, "critical");
  assert.equal(loaded.sources.blockAtSeverity, "override");
  assert.equal(
    await runConfig(
      ["unset", "blockAtSeverity", "--project", root],
      run.runtime,
    ),
    0,
  );
  assert.equal(
    (await loadGuardSettings(root)).settings.blockAtSeverity,
    "high",
  );
});

test("config warns when choosing a less restrictive profile", async (t) => {
  const root = await project(t);
  const run = io(root);
  assert.equal(await runConfig(["set", "profile", "audit"], run.runtime), 0);
  assert.match(run.err(), /audit is less restrictive than strict/);
  const shown = io(root);
  assert.equal(await runConfig(["show"], shown.runtime), 0);
  assert.match(shown.out(), /enforcement: nonenforcing \(profile\)/);
  assert.match(shown.out(), /audit is nonenforcing/);
});

test("config rejects invalid enums, unknown keys and unsafe unknown handling without writing", async (t) => {
  const root = await project(t);
  for (const args of [
    ["set", "profile", "lenient"],
    ["set", "unknown", "allow"],
    ["set", "apiToken", "secret"],
    ["set", "blockAtSeverity", "HIGH"],
    ["unset", "profile"],
    ["set", "profile"],
    ["show", "--verbose"],
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
      overrides: { unknown: "allow" },
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
