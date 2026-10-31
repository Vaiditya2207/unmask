import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { checkPackage } from "../../scripts/check-package.mjs";
import { buildFixture } from "./build-fixture.mjs";

function preflight(
  t,
  {
    enabled,
    tamper = false,
    mode = "npm-preflight",
    preparation = "immutable-denied",
  },
) {
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
      const sourceFiles = [
        "src/cli/main.mjs",
        "src/server/main.mjs",
        "src/viewer/shell.mjs",
      ];
      for (const file of [
        ...sourceFiles.slice(1),
        "tests/product/example.test.mjs",
      ]) {
        mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        writeFileSync(path.join(root, file), "export const fixture = true;\n");
      }
      writeFileSync(path.join(root, "Dockerfile"), "FROM scratch\n");
      writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg));
      writeFileSync(
        path.join(root, "release.config.json"),
        JSON.stringify({
          enabled: true,
          npmPublishEnabled: enabled,
          approvedPackageName: pkg.name,
          sourceFiles,
          cli: "dist/cli/main.mjs",
          server: "dist/server/main.mjs",
          web: "dist/viewer/shell.mjs",
          dockerfile: "Dockerfile",
          productTestDirectory: "tests/product",
        }),
      );
      writeFileSync(
        path.join(root, ".gitignore"),
        "dist/\noutput/\nartifacts/\n",
      );
      writeFileSync(
        path.join(root, "no-network.mjs"),
        mode === "prepare"
          ? preparation !== "immutable-denied"
            ? `globalThis.fetch = async url => { const p = new URL(url).pathname; if (p.endsWith("/tags") || p.endsWith("/releases")) return Response.json([]); if (p.endsWith("/immutable-releases")) return Response.json({enabled:true}); if (p === "/token") return Response.json({token:"test-only-not-a-credential"}); return new Response(null, {status:${preparation === "ghcr-clear" ? 404 : 200}}); };\n`
            : 'globalThis.fetch = async url => { const p = new URL(url).pathname; return p.endsWith("/tags") || p.endsWith("/releases") ? Response.json([]) : new Response(null, {status: 403}); };\n'
          : 'globalThis.fetch = () => { throw new Error("Network forbidden in npm preflight"); };\n',
      );
    },
  });
  f.build();
  const directory = path.join(f.root, "artifacts");
  mkdirSync(directory);
  const artifact = checkPackage(f.root, directory, {
    expectedSha: f.sha,
    requireClean: true,
  });
  writeFileSync(
    path.join(directory, "release-plan.json"),
    JSON.stringify({
      sha: f.sha,
      version: f.pkg.version,
      imageRef: `ghcr.io/example/unmask:sha-${f.sha}`,
      artifact,
    }),
  );
  if (tamper)
    writeFileSync(path.join(directory, artifact.filename), "replaced");
  return spawnSync(
    process.execPath,
    [
      "--import",
      path.join(f.root, "no-network.mjs"),
      fileURLToPath(new URL("../../scripts/release.mjs", import.meta.url)),
      mode,
    ],
    {
      cwd: f.root,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_REPOSITORY: "example/unmask",
        GITHUB_SHA: f.sha,
        GITHUB_REF: "refs/heads/main",
        GITHUB_ACTOR: "fixture",
        GITHUB_RUN_ID: "1",
        GITHUB_TOKEN: "test-only-not-a-credential",
        CHECKS_RESULT: "success",
        NODE_AUTH_TOKEN: "test-only-not-a-credential",
      },
    },
  );
}

test("npm preflight refuses disabled configuration without network", (t) => {
  const result = preflight(t, { enabled: false });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /gate is closed/);
  assert.doesNotMatch(result.stderr, /Network forbidden/);
});

test("enabled npm preflight needs no extra variable and never authenticates or publishes", (t) => {
  const result = preflight(t, { enabled: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /authentication and publication were not attempted/,
  );
});

test("npm preflight refuses replacement archive bytes", (t) => {
  const result = preflight(t, {
    enabled: true,
    tamper: true,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /digest mismatch/);
  assert.doesNotMatch(result.stderr, /Network forbidden/);
});

test("prepare checks GitHub immutability access before a first npm publication can run", (t) => {
  const result = preflight(t, {
    enabled: true,
    mode: "prepare",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /GitHub GET immutable-releases failed \(403\)/);
});

test("prepare refuses an occupied GHCR tag before a first npm publication can run", (t) => {
  const result = preflight(t, {
    enabled: true,
    mode: "prepare",
    preparation: "ghcr-conflict",
  });
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /Image tag .* unavailable for creation.*never overwrite/,
  );
});

test("prepare packs the exact inert candidate when immutable settings and GHCR availability pass", (t) => {
  const result = preflight(t, {
    enabled: true,
    mode: "prepare",
    preparation: "ghcr-clear",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Prepared v1\.0\.0.*nothing published/);
});
