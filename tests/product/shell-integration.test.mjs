import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  SHELL_MARKER,
  runShellIntegration,
  shellIntegrationScript,
} from "../../src/cli/shell-integration.mjs";

const entrypoint = fileURLToPath(
  new URL("../../src/cli/main.mjs", import.meta.url),
);

async function bin(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "unmask-shell-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const log = path.join(root, "calls.log");
  for (const [name, code] of [
    ["unmask", 3],
    ["npm", 0],
  ]) {
    const file = path.join(root, name);
    await writeFile(
      file,
      `#!/bin/sh\necho "${name} $*" >> "${log}"\nexit ${code}\n`,
    );
    await chmod(file, 0o755);
  }
  return { root, log };
}
function available(shell) {
  return spawnSync(shell, ["-c", "exit 0"]).status === 0;
}

for (const shell of ["bash", "zsh"])
  test(
    `${shell} integration routes only install/ci through unmask and is reversible`,
    { skip: !available(shell) && `${shell} unavailable` },
    async (t) => {
      const fake = await bin(t);
      const script = [
        `eval "$("${process.execPath}" "${entrypoint}" enable ${shell})"`,
        "npm i left-pad --save-dev; echo status=$?",
        "npm clean-install --omit=dev",
        "npm run build",
        "UNMASK_GUARD_ACTIVE=1 npm ci",
        'echo "marker=$UNMASK_SHELL_INTEGRATION"',
        `eval "$("${process.execPath}" "${entrypoint}" disable ${shell})"`,
        "npm ci",
        'echo "marker=${UNMASK_SHELL_INTEGRATION:-unset}"',
      ].join("\n");
      const result = spawnSync(shell, ["-c", script], {
        encoding: "utf8",
        env: { PATH: `${fake.root}:/usr/bin:/bin`, HOME: fake.root },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        result.stdout,
        "status=3\nmarker=npm-guard-v1\nmarker=unset\n",
      );
      assert.deepEqual((await readFile(fake.log, "utf8")).trim().split("\n"), [
        "unmask install left-pad --save-dev",
        "unmask ci --omit=dev",
        "npm run build",
        "npm ci",
        "npm ci",
      ]);
    },
  );

test(
  "enable and disable leave a user-defined npm function untouched",
  { skip: !available("bash") && "bash unavailable" },
  async (t) => {
    const fake = await bin(t);
    const result = spawnSync(
      "bash",
      [
        "-c",
        `function npm { echo mine; }\neval "$("${process.execPath}" "${entrypoint}" enable bash)"\nnpm ci\necho "marker=\${UNMASK_SHELL_INTEGRATION:-unset}"\neval "$("${process.execPath}" "${entrypoint}" disable bash)"\nnpm`,
      ],
      { encoding: "utf8", env: { PATH: `${fake.root}:/usr/bin:/bin` } },
    );
    assert.equal(result.stdout, "mine\nmarker=unset\nmine\n");
    assert.match(
      result.stderr,
      /existing npm alias or function was left unchanged/,
    );
  },
);

test("printed code carries the marker and the command never writes files", async () => {
  for (const shell of ["bash", "zsh", "fish"]) {
    const enable = shellIntegrationScript("enable", shell);
    assert.ok(enable.startsWith(SHELL_MARKER + "\n"));
    assert.match(enable, /command unmask install/);
    assert.doesNotMatch(enable, /rc\b|>>|profile/);
  }
  assert.match(
    shellIntegrationScript("enable", "fish"),
    /set -gx UNMASK_SHELL_INTEGRATION npm-guard-v1/,
  );
  let out = "",
    err = "";
  const code = runShellIntegration("enable", ["tcsh"], {
    env: {},
    stdout: { write: (chunk) => void (out += chunk) },
    stderr: { write: (chunk) => void (err += chunk) },
  });
  assert.equal(code, 2);
  assert.equal(out, "");
  assert.match(err, /nothing is written to shell startup files/);
});

for (const shell of ["bash", "zsh"])
  test(
    `${shell} never treats a wrapper that merely mentions unmask as owned`,
    { skip: !available(shell) && `${shell} unavailable` },
    async (t) => {
      const fake = await bin(t);
      const load = (action) =>
        `eval "$("${process.execPath}" "${entrypoint}" ${action} ${shell})"`;
      const result = spawnSync(
        shell,
        [
          "-c",
          [
            'function npm { echo original-wrapper; : "command unmask"; }',
            load("enable"),
            "npm",
            load("disable"),
            "npm",
            "unset -f npm",
            load("enable"),
            load("enable"),
            "npm run x",
            load("disable"),
            "typeset -f npm >/dev/null 2>&1 && echo still-defined || echo removed",
          ].join("\n"),
        ],
        {
          encoding: "utf8",
          env: { PATH: `${fake.root}:/usr/bin:/bin`, HOME: fake.root },
        },
      );
      assert.equal(
        result.stdout,
        "original-wrapper\noriginal-wrapper\nremoved\n",
        result.stderr,
      );
      assert.match(result.stderr, /left unchanged/);
      assert.equal((await readFile(fake.log, "utf8")).trim(), "npm run x");
    },
  );
