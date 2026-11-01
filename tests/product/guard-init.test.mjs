import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
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
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { main } from "../../src/cli/main.mjs";
import { loadGuardSettings } from "../../src/core/guard-config.mjs";

const entrypoint = fileURLToPath(
  new URL("../../src/cli/main.mjs", import.meta.url),
);
async function project(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "unmask-guard-init-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function init(root, ...args) {
  const out = [],
    err = [];
  const code = await main(["init", ...args], {
    cwd: root,
    stdout: { write: (text) => out.push(text) },
    stderr: { write: (text) => err.push(text) },
  });
  return { code, out: out.join(""), err: err.join("") };
}

test("init creates a private strict configuration that loads with the guard schema", async (t) => {
  const root = await project(t);
  const result = await init(root);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /profile strict \(enforcement enforce\)/);
  assert.equal(result.err, "");
  const file = path.join(root, ".unmask.json");
  assert.deepEqual(await readdir(root), [".unmask.json"]);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
    schemaVersion: 1,
    profile: "strict",
  });
  assert.equal(
    (await loadGuardSettings(root)).settings.unknownDecision,
    "block",
  );
});

test("init accepts explicit profiles and labels audit as nonenforcing", async (t) => {
  const balanced = await project(t);
  assert.equal((await init(balanced, "--profile", "balanced")).code, 0);
  assert.equal(
    (await loadGuardSettings(balanced)).settings.profile,
    "balanced",
  );
  const audit = await project(t);
  const result = await init(audit, "--profile", "audit");
  assert.equal(result.code, 0);
  assert.match(result.out, /enforcement audit/);
  assert.match(result.err, /^warning: The audit profile is nonenforcing/);
});

test("init never replaces existing files, symlinks or dangling links", async (t) => {
  const root = await project(t);
  const outside = await project(t);
  const file = path.join(root, ".unmask.json");
  await writeFile(file, "keep me", { mode: 0o600 });
  let result = await init(root, "--profile", "audit");
  assert.equal(result.code, 2);
  assert.match(result.err, /^config-exists:/);
  assert.equal(await readFile(file, "utf8"), "keep me");
  await rm(file);
  await symlink(path.join(outside, "target.json"), file);
  result = await init(root);
  assert.equal(result.code, 2);
  assert.match(result.err, /^config-exists:/);
  assert.deepEqual(await readdir(outside), []);
  assert.deepEqual(await readdir(root), [".unmask.json"]);
});

test("init rejects invalid profiles, options and missing projects without writing", async (t) => {
  const root = await project(t);
  for (const [args, code] of [
    [["--profile", "lenient"], "invalid-value"],
    [["--profile"], "missing-value"],
    [["--profile", "--project"], "missing-value"],
    [["--json"], "unknown-option"],
    [["extra"], "usage"],
    [["--project", path.join(root, "missing")], "invalid-project"],
  ]) {
    const result = await init(root, ...args);
    assert.equal(result.code, 2, args.join(" "));
    assert.match(result.err, new RegExp(`^${code}:`), args.join(" "));
  }
  assert.deepEqual(await readdir(root), []);
});

test("the real CLI entrypoint creates the file and refuses a second run", async (t) => {
  const root = await project(t);
  const run = () =>
    spawnSync(process.execPath, [entrypoint, "init", "--project", root], {
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /^Created .*\.unmask\.json with profile strict/);
  const second = run();
  assert.equal(second.status, 2);
  assert.match(second.stderr, /^config-exists:/);
});
