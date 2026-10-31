import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  symlink,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { main } from "../../src/cli/main.mjs";
import { commandCatalog } from "../../src/cli/discovery.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const CHECK_FALLBACK =
  "usage: Use check name@version or an explicit local tarball with --offline\n";
function capture() {
  let text = "";
  return { write: (chunk) => (text += chunk), text: () => text };
}
async function quiet(run) {
  const original = process.stderr.write;
  const errors = [];
  process.stderr.write = (chunk) => errors.push(String(chunk));
  try {
    return { code: await run(), errors };
  } finally {
    process.stderr.write = original;
  }
}
function command(program, args, cwd) {
  const result = spawnSync(program, args, {
    cwd,
    encoding: "utf8",
    timeout: 60000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

test("help lists commands by actual module availability", async () => {
  const stdout = capture();
  assert.equal(await main(["--help"], { stdout }), 0);
  const text = stdout.text();
  const [availableBlock, plannedBlock = ""] = text.split(
    "Planned, not included in this build:",
  );
  for (const item of commandCatalog()) {
    assert.equal(
      item.available,
      existsSync(
        path.join(
          root,
          "src/cli",
          item.name === "check" ? "main.mjs" : `${item.name}.mjs`,
        ),
      ),
      item.name,
    );
    const block = item.available ? availableBlock : plannedBlock;
    assert.match(block, new RegExp(`\\n  ${item.name} +\\S`));
  }
  assert.ok(commandCatalog().find((item) => item.name === "check").available);
  assert.match(text, /no command guarantees a package is safe/);
  for (const args of [["help"], ["-h"]]) {
    const again = capture();
    assert.equal(await main(args, { stdout: again }), 0);
    assert.equal(again.text(), text);
  }
});

test("every command marked available is actually dispatched by main", async () => {
  for (const item of commandCatalog().filter(
    (entry) => entry.available && entry.name !== "check",
  )) {
    const { code, errors } = await quiet(() =>
      main([item.name, "--unmask-probe-invalid-option"], {
        fetchImpl: () => assert.fail(`${item.name} probe made a request`),
      }),
    );
    assert.equal(code, 2, item.name);
    assert.notEqual(errors.join(""), CHECK_FALLBACK, item.name);
  }
});

test("per-command help shows usage or unavailability and rejects unknown names", async () => {
  const check = capture();
  assert.equal(await main(["check", "--help"], { stdout: check }), 0);
  assert.match(check.text(), /^unmask check: /);
  assert.match(check.text(), /unmask check NAME@VERSION --out DIR/);
  const viaHelp = capture();
  assert.equal(await main(["help", "check"], { stdout: viaHelp }), 0);
  assert.equal(viaHelp.text(), check.text());
  for (const item of commandCatalog()) {
    const out = capture();
    assert.equal(await main(["help", item.name], { stdout: out }), 0);
    if (!item.available) assert.match(out.text(), /Not included in this build/);
  }
  for (const args of [
    ["help", "nope"],
    ["nope", "--help"],
    ["help", "check", "extra"],
    ["--help", "extra"],
    ["--version", "extra"],
  ]) {
    const { code, errors } = await quiet(() => main(args));
    assert.equal(code, 2, args.join(" "));
    assert.match(errors[0], /^usage: /);
  }
});

test("version from a source checkout reads package metadata without network", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => assert.fail("version must not use the network");
  try {
    const text = capture();
    const json = capture();
    assert.equal(await main(["--version"], { stdout: text }), 0);
    assert.equal(await main(["version", "--json"], { stdout: json }), 0);
    const pkg = JSON.parse(await readFile(path.join(root, "package.json")));
    assert.equal(
      text.text(),
      `unmask ${pkg.version} (unbuilt source checkout, no build metadata)\n`,
    );
    assert.deepEqual(JSON.parse(json.text()), {
      version: pkg.version,
      build: "source",
      commit: null,
      dirty: null,
    });
  } finally {
    globalThis.fetch = original;
  }
});

test("installed npm bin reports build metadata identity and help", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "unmask-discovery-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const copy = path.join(temporary, "candidate");
  for (const name of [
    "src",
    "scripts",
    ".nvmrc",
    "package.json",
    "package-lock.json",
  ])
    await cp(path.join(root, name), path.join(copy, name), { recursive: true });
  await symlink(
    path.join(root, "node_modules"),
    path.join(copy, "node_modules"),
  );
  command(process.execPath, ["scripts/build.mjs"], copy);
  const built = JSON.parse(
    await readFile(path.join(copy, "dist/version.json"), "utf8"),
  );
  const { checkPackage } = await import(
    new URL("../../scripts/check-package.mjs", import.meta.url)
  );
  const packed = checkPackage(copy, temporary, {
    requiredFiles: ["dist/cli/main.mjs", "dist/cli/discovery.mjs"],
  });
  const install = path.join(temporary, "install");
  await mkdir(install);
  await writeFile(
    path.join(install, "package.json"),
    JSON.stringify({
      name: "discovery-consumer",
      version: "1.0.0",
      private: true,
    }),
  );
  command(
    "npm",
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      path.join(temporary, packed.filename),
    ],
    install,
  );
  const bin = path.join(install, "node_modules/.bin/unmask");
  const identity = JSON.parse(command(bin, ["--version", "--json"], install));
  assert.equal(identity.version, built.version);
  assert.equal(identity.build, "built");
  assert.equal(identity.dirty, built.dirty);
  assert.equal(
    identity.commit,
    built.commit === "unknown" ? null : built.commit,
  );
  assert.equal(identity.sourceSha256, built.sourceSha256);
  assert.match(
    command(bin, ["--version"], install),
    new RegExp(
      `^unmask ${built.version.replaceAll(".", "\\.")} \\((commit [a-f0-9]{40}|built from uncommitted changes, commit unknown)\\)\\n$`,
    ),
  );
  const help = command(bin, ["--help"], install);
  const installed = path.join(install, "node_modules", "@xagents_in/unmask");
  for (const item of commandCatalog()) {
    const present =
      item.name === "check" ||
      existsSync(path.join(installed, "dist/cli", `${item.name}.mjs`));
    const [availableBlock] = help.split("Planned, not included");
    assert.equal(
      new RegExp(`\\n  ${item.name} +\\S`).test(availableBlock),
      present,
      item.name,
    );
  }
});
