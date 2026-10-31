import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { checkCandidate } from "../../scripts/check-candidate.mjs";
import { buildFixture } from "./build-fixture.mjs";

const id = `sha256:${"b".repeat(64)}`;
function fixture(t) {
  const f = buildFixture(t, {
    clean: true,
    configure({ root, pkg }) {
      pkg.private = false;
      pkg.publishConfig = {
        registry: "https://registry.npmjs.org/",
        access: "public",
      };
      pkg.scripts["test:product"] = "fixture";
      pkg.scripts["test:release"] = "fixture";
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
      for (const file of [
        "src/server/main.mjs",
        "src/viewer/shell.mjs",
        "tests/product/example.test.mjs",
      ]) {
        mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        writeFileSync(path.join(root, file), "export const fixture = true;\n");
      }
      writeFileSync(path.join(root, "Dockerfile"), "FROM scratch\n");
      writeFileSync(
        path.join(root, ".dockerignore"),
        readFileSync(new URL("../../.dockerignore", import.meta.url)),
      );
      writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg));
      writeFileSync(
        path.join(root, "release.config.json"),
        JSON.stringify(config),
      );
    },
  });
  f.build();
  return f;
}
function adapter({
  sha,
  failBuild = false,
  failSmoke = false,
  mutateArchive = false,
  mutateImage = false,
  wrongTarballLabel = false,
} = {}) {
  let inspections = 0,
    binding;
  const calls = [];
  return {
    calls,
    execute(command, args, options) {
      calls.push({ command, args, options });
      if (command === "docker" && args[0] === "buildx") {
        if (failBuild) throw new Error("Docker build failed");
        const context = args.at(-1);
        assert.notEqual(context, options.cwd);
        assert.equal(existsSync(path.join(context, "src")), false);
        assert.equal(existsSync(path.join(context, "dist")), false);
        binding = JSON.parse(
          readFileSync(path.join(context, "candidate.json")),
        );
        assert.equal(binding.commit, sha);
        return;
      }
      if (command === "docker" && args[0] === "image")
        return JSON.stringify([
          {
            Id: mutateImage && inspections++ ? `sha256:${"c".repeat(64)}` : id,
            Os: "linux",
            Architecture: "amd64",
            Config: {
              Labels: {
                "org.opencontainers.image.revision": binding.commit,
                "org.opencontainers.image.version": binding.version,
                "io.unmask.tarball.sha256": wrongTarballLabel
                  ? "d".repeat(64)
                  : binding.packageDigest.slice(7),
                "io.unmask.lockfile.sha256": binding.lockDigest.slice(7),
              },
            },
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

test("candidate builds only its exact archive context then passes that archive/image to smoke", (t) => {
  const f = fixture(t),
    runner = adapter({ sha: f.sha });
  assert.equal(
    checkCandidate(f.root, { sha: f.sha, execute: runner.execute }).imageId,
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
  [{ wrongTarballLabel: true }, /identity differs/],
]) {
  test(`candidate check propagates ${Object.keys(change)[0]} as a failure`, (t) => {
    const f = fixture(t),
      runner = adapter({ sha: f.sha, ...change });
    assert.throws(
      () => checkCandidate(f.root, { sha: f.sha, execute: runner.execute }),
      message,
    );
    if (change.failBuild || change.wrongTarballLabel)
      assert.equal(
        runner.calls.some((call) => call.command === "npm"),
        false,
      );
  });
}

test("candidate archive requires all configured application entrypoints", (t) => {
  const f = fixture(t);
  f.pkg.files = ["dist/cli/main.mjs"];
  writeFileSync(path.join(f.root, "package.json"), JSON.stringify(f.pkg));
  const sha = f.commit();
  f.build();
  const runner = adapter({ sha });
  assert.throws(
    () => checkCandidate(f.root, { sha, execute: runner.execute }),
    /Entrypoint missing/,
  );
  assert.equal(runner.calls.length, 0);
});
