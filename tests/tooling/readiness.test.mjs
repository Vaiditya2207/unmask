import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildProduct } from "../../scripts/build.mjs";
import { readiness } from "../../scripts/release-readiness.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "unmask-ready-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = {
    name: "@example/unmask",
    version: "1.0.0",
    private: false,
    publishConfig: {
      registry: "https://registry.npmjs.org/",
      access: "public",
    },
    bin: { unmask: "dist/cli/main.mjs" },
    scripts: {
      build: "node build.mjs",
      "test:product": "node --test tests/product/*.test.mjs",
      "test:release": "node smoke.mjs",
    },
  };
  const config = {
    enabled: true,
    approvedPackageName: pkg.name,
    sourceFiles: [
      "src/cli/main.mjs",
      "src/server/main.mjs",
      "src/viewer/shell.mjs",
    ],
    cli: "dist/cli/main.mjs",
    server: "dist/server/main.mjs",
    web: "dist/viewer/shell.mjs",
    dockerfile: "Dockerfile",
    productTestDirectory: "tests/product",
  };
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  writeFileSync(
    path.join(root, "scripts/build.mjs"),
    readFileSync(new URL("../../scripts/build.mjs", import.meta.url)),
  );
  writeFileSync(path.join(root, ".nvmrc"), "24.22.2\n");
  const save = () => {
    writeFileSync(
      path.join(root, "package-lock.json"),
      JSON.stringify({
        name: pkg.name,
        version: pkg.version,
        lockfileVersion: 3,
        packages: { "": { name: pkg.name, version: pkg.version } },
      }),
    );
    writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg));
    writeFileSync(
      path.join(root, "release.config.json"),
      JSON.stringify(config),
    );
    buildProduct(root);
  };
  for (const file of [
    ...config.sourceFiles,
    config.cli,
    config.server,
    config.web,
    config.dockerfile,
    "tests/product/analysis.test.mjs",
  ]) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), "Test fixture only\n");
  }
  save();
  return { root, pkg, config, save };
}

test("configured fixture requires actual built CLI, website and server", (t) => {
  const f = fixture(t);
  assert.equal(readiness(f.root, { built: true }).ready, true);
  rmSync(path.join(f.root, f.config.server));
  assert.equal(readiness(f.root, { built: true }).ready, false);
});

test("source scaffold, private npm identity and absent product tests stay blocked", (t) => {
  const f = fixture(t);
  f.config.enabled = false;
  f.pkg.private = true;
  f.save();
  rmSync(path.join(f.root, "tests/product/analysis.test.mjs"));
  const result = readiness(f.root);
  assert.equal(result.ready, false);
  assert.match(result.reasons.join("\n"), /disabled/);
  assert.match(result.reasons.join("\n"), /npm identity/);
  assert.match(result.reasons.join("\n"), /Product test files/);
});

test("an output entrypoint cannot escape the package dist directory", (t) => {
  const f = fixture(t);
  f.config.cli = "dist/../../outside";
  f.save();
  assert.equal(readiness(f.root, { built: true }).ready, false);
});

test("ordinary main pushes require a version change to become candidates", async () => {
  const { versionChanged } =
    await import("../../scripts/release-readiness.mjs");
  assert.equal(versionChanged("1.0.0", "1.0.0"), false);
  assert.equal(versionChanged("1.0.0", "1.0.1"), true);
  assert.equal(versionChanged(undefined, "1.0.1"), false);
});

test("lockfile identity drift blocks the candidate", (t) => {
  const f = fixture(t);
  writeFileSync(
    path.join(f.root, "package-lock.json"),
    JSON.stringify({
      name: f.pkg.name,
      version: "0.9.0",
      packages: { "": { name: f.pkg.name, version: "0.9.0" } },
    }),
  );
  const result = readiness(f.root, { built: true });
  assert.equal(result.ready, false);
  assert.match(result.reasons.join("\n"), /lockfile identity/);
});
