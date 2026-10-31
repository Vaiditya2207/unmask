import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkCandidate } from "../../scripts/check-candidate.mjs";

const sha = "a".repeat(40);
const id = `sha256:${"b".repeat(64)}`;
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "unmask-smoke-fixture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = {
    name: "unmask-fixture",
    version: "1.0.0",
    private: false,
    files: ["dist"],
    bin: { unmask: "dist/cli.js" },
    publishConfig: {
      registry: "https://registry.npmjs.org/",
      access: "public",
    },
    scripts: {
      build: "fixture",
      "test:product": "fixture",
      "test:release": "fixture",
    },
  };
  const config = {
    enabled: true,
    approvedPackageName: pkg.name,
    sourceFiles: ["src/cli.js", "src/server.js", "src/web.js"],
    cli: "dist/cli.js",
    server: "dist/server.js",
    web: "dist/web/index.html",
    dockerfile: "Dockerfile",
    productTestDirectory: "tests/product",
  };
  writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg));
  writeFileSync(
    path.join(root, "package-lock.json"),
    JSON.stringify({
      name: pkg.name,
      version: pkg.version,
      packages: { "": { name: pkg.name, version: pkg.version } },
    }),
  );
  writeFileSync(path.join(root, "release.config.json"), JSON.stringify(config));
  for (const file of [
    ...config.sourceFiles,
    config.cli,
    config.server,
    config.web,
    config.dockerfile,
    "tests/product/example.test.mjs",
  ]) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), "Test fixture only\n");
  }
  return root;
}

function adapter({
  failBuild = false,
  failSmoke = false,
  mutateArchive = false,
  mutateImage = false,
} = {}) {
  let inspections = 0;
  const calls = [];
  return {
    calls,
    execute(command, args, options) {
      calls.push({ command, args, options });
      if (command === "docker" && args[0] === "buildx") {
        if (failBuild) throw new Error("Docker build failed");
        return;
      }
      if (command === "docker" && args[0] === "image")
        return JSON.stringify([
          {
            Id: mutateImage && inspections++ ? `sha256:${"c".repeat(64)}` : id,
            Os: "linux",
            Architecture: "amd64",
            Config: { Labels: { "org.opencontainers.image.revision": sha } },
          },
        ]);
      if (command === "npm" && args.join(" ") === "run test:release") {
        assert.ok(readFileSync(options.env.RELEASE_PACKAGE).length > 0);
        assert.equal(options.env.RELEASE_IMAGE, `unmask-candidate:${sha}`);
        if (failSmoke) throw new Error("Candidate smoke failed");
        if (mutateArchive)
          writeFileSync(options.env.RELEASE_PACKAGE, "changed");
        return;
      }
      throw new Error(`Unexpected command ${command} ${args.join(" ")}`);
    },
  };
}

test("candidate orchestration passes the actual packed tarball and local image to smoke", (t) => {
  const root = fixture(t);
  const runner = adapter();
  assert.equal(
    checkCandidate(root, { sha, execute: runner.execute }).imageId,
    id,
  );
  assert.deepEqual(
    runner.calls.map((call) => [call.command, call.args[0]]),
    [
      ["docker", "buildx"],
      ["docker", "image"],
      ["npm", "run"],
      ["docker", "image"],
    ],
  );
});

for (const [change, message] of [
  [{ failBuild: true }, /Docker build failed/],
  [{ failSmoke: true }, /Candidate smoke failed/],
  [{ mutateArchive: true }, /digest mismatch/],
  [{ mutateImage: true }, /image changed/],
]) {
  test(`candidate check propagates ${Object.keys(change)[0]} as a failure`, (t) => {
    const runner = adapter(change);
    assert.throws(
      () => checkCandidate(fixture(t), { sha, execute: runner.execute }),
      message,
    );
    if (change.failBuild)
      assert.equal(
        runner.calls.some((call) => call.command === "npm"),
        false,
      );
  });
}

test("candidate archive requires all configured application entrypoints", (t) => {
  const root = fixture(t);
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json")));
  pkg.files = ["dist/cli.js"];
  writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg));
  const runner = adapter();
  assert.throws(
    () => checkCandidate(root, { sha, execute: runner.execute }),
    /Entrypoint missing/,
  );
  assert.equal(runner.calls.length, 0);
});
