import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

function scaffold(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "unmask-closed-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "unmask-fixture", version: "0.0.0", private: true }),
  );
  writeFileSync(
    path.join(root, "release.config.json"),
    JSON.stringify({ enabled: false }),
  );
  return root;
}

const readinessScript = fileURLToPath(
  new URL("../../scripts/release-readiness.mjs", import.meta.url),
);
const releaseScript = fileURLToPath(
  new URL("../../scripts/release.mjs", import.meta.url),
);

test("CLI readiness fails closed; report mode explicitly reports blocked", (t) => {
  const root = scaffold(t);
  const strict = spawnSync(process.execPath, [readinessScript], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(strict.status, 1);
  assert.equal(JSON.parse(strict.stdout).ready, false);
  const report = execFileSync(process.execPath, [readinessScript, "--report"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(JSON.parse(report).ready, false);
  const output = path.join(root, "github-output");
  execFileSync(process.execPath, [readinessScript, "--github-output"], {
    cwd: root,
    env: { ...process.env, GITHUB_OUTPUT: output },
  });
  assert.equal(readFileSync(output, "utf8"), "ready=false\n");
});

for (const mode of ["prepare", "publish"]) {
  test(`real ${mode} entrypoint refuses the scaffold before any network request`, (t) => {
    const root = scaffold(t);
    const guard = path.join(root, "no-network.mjs");
    writeFileSync(
      guard,
      'globalThis.fetch = () => { throw new Error("Network forbidden in test"); };\n',
    );
    const result = spawnSync(
      process.execPath,
      ["--import", guard, releaseScript, mode],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_REPOSITORY: "example/unmask",
          GITHUB_SHA: "a".repeat(40),
          GITHUB_REF: "refs/heads/main",
          GITHUB_ACTOR: "fixture",
          GITHUB_RUN_ID: "1",
          GITHUB_TOKEN: "test-only-not-a-credential",
          CHECKS_RESULT: "success",
        },
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Release blocked/);
    assert.doesNotMatch(result.stderr, /Network forbidden/);
    assert.equal(existsSync(path.join(root, "artifacts")), false);
  });
}
