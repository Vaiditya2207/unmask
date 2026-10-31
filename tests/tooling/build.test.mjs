import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkPackage } from "../../scripts/check-package.mjs";
import { buildProduct, verifyBuild } from "../../scripts/build.mjs";
import { buildFixture } from "./build-fixture.mjs";

function externalize(t, root, name) {
  const outside = mkdtempSync(path.join(os.tmpdir(), "unmask-build-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  renameSync(path.join(root, name), path.join(outside, name));
  symlinkSync(path.join(outside, name), path.join(root, name), "dir");
}

test("a clean tracked src symlink cannot import external product bytes", (t) => {
  const f = buildFixture(t);
  externalize(t, f.root, "src");
  f.commit();
  assert.equal(
    execFileSync("git", ["status", "--porcelain"], {
      cwd: f.root,
      encoding: "utf8",
    }),
    "",
  );
  assert.throws(() => buildProduct(f.root), /directory.*src/i);
});

test("build reads reject a parent symlink escaping the repository", (t) => {
  const f = buildFixture(t);
  externalize(t, f.root, "scripts");
  f.commit();
  assert.throws(() => buildProduct(f.root), /contain|outside|escape/i);
});

test("clean release verification rejects a symlinked dist root", (t) => {
  const f = buildFixture(t, {
    clean: true,
    configure({ root }) {
      writeFileSync(path.join(root, ".gitignore"), "dist\noutput/\n");
    },
  });
  f.build();
  externalize(t, f.root, "dist");
  assert.equal(
    execFileSync("git", ["status", "--porcelain"], {
      cwd: f.root,
      encoding: "utf8",
    }),
    "",
  );
  assert.throws(
    () => verifyBuild(f.root, { expectedSha: f.sha, requireClean: true }),
    /directory.*dist/i,
  );
});

test("declared product bin cannot pass packing before a build", (t) => {
  const f = buildFixture(t);
  assert.throws(
    () => checkPackage(f.root, path.join(f.root, "output")),
    /build|entrypoint/i,
  );
});

test("source changes invalidate dist instead of packing the previous product", (t) => {
  const f = buildFixture(t);
  f.build();
  writeFileSync(
    path.join(f.root, "src/cli/main.mjs"),
    'console.log("changed");\n',
  );
  assert.throws(
    () => checkPackage(f.root, path.join(f.root, "output")),
    /stale|source|build/i,
  );
});

test("freshness covers modules outside the declared CLI entrypoint", (t) => {
  const f = buildFixture(t);
  mkdirSync(path.join(f.root, "src/core"));
  writeFileSync(
    path.join(f.root, "src/core/report.mjs"),
    "export const value = 1;\n",
  );
  f.build();
  writeFileSync(
    path.join(f.root, "src/core/report.mjs"),
    "export const value = 2;\n",
  );
  assert.throws(
    () => checkPackage(f.root, path.join(f.root, "output")),
    /stale|source|build/i,
  );
});

test("product input formats cannot be silently omitted from freshness checks", (t) => {
  const f = buildFixture(t);
  f.build();
  writeFileSync(path.join(f.root, "src/cli/config.json"), "{}");
  assert.throws(
    () => checkPackage(f.root, path.join(f.root, "output")),
    /unsupported|input/i,
  );
});

test("changed built bytes cannot retain a valid build identity", (t) => {
  const f = buildFixture(t);
  f.build();
  writeFileSync(
    path.join(f.root, "dist/cli/main.mjs"),
    'console.log("replaced");\n',
  );
  assert.throws(
    () => checkPackage(f.root, path.join(f.root, "output")),
    /digest|bytes|build/i,
  );
});

test("clean release identity binds the actual checkout and rejects another SHA", (t) => {
  const f = buildFixture(t, { clean: true });
  f.build();
  const result = checkPackage(f.root, path.join(f.root, "output"), {
    expectedSha: f.sha,
    requireClean: true,
  });
  assert.ok(result.build);
  assert.equal(result.build.commit, f.sha);
  assert.equal(result.build.dirty, false);
  assert.throws(
    () =>
      checkPackage(f.root, path.join(f.root, "output"), {
        expectedSha: "f".repeat(40),
        requireClean: true,
      }),
    /commit|SHA/i,
  );
});

test("diagnostic dirty builds remain usable but cannot become release artifacts", (t) => {
  const f = buildFixture(t, { clean: true });
  writeFileSync(
    path.join(f.root, "src/cli/main.mjs"),
    'console.log("dirty");\n',
  );
  f.build();
  assert.ok(checkPackage(f.root, path.join(f.root, "output")).digest);
  assert.throws(
    () =>
      checkPackage(f.root, path.join(f.root, "output"), {
        expectedSha: f.sha,
        requireClean: true,
      }),
    /dirty|clean|commit/i,
  );
});
