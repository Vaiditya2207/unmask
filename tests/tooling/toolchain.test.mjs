import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkToolchain } from "../../scripts/check-toolchain.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "unmask-toolchain-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = {
    name: "fixture",
    version: "0.0.0",
    engines: { node: "24.22.2" },
    devDependencies: { prettier: "3.9.10" },
  };
  const lock = {
    name: pkg.name,
    version: pkg.version,
    lockfileVersion: 3,
    packages: {
      "": structuredClone(pkg),
      "node_modules/prettier": {
        version: "3.9.10",
        resolved: "https://registry.npmjs.org/prettier/-/prettier-3.9.10.tgz",
        integrity: `sha512-${Buffer.alloc(64, 7).toString("base64")}`,
      },
    },
  };
  const save = () => {
    writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg));
    writeFileSync(path.join(root, "package-lock.json"), JSON.stringify(lock));
    writeFileSync(path.join(root, ".nvmrc"), "24.22.2\n");
  };
  save();
  return { root, pkg, lock, save };
}

test("exact Node and dependency pins agree with root and installed lock records", (t) => {
  const f = fixture(t);
  assert.equal(checkToolchain(f.root, { runtime: "24.22.2" }).dependencies, 1);
});

for (const [label, mutate] of [
  [
    "ranged dependency",
    (f) => {
      f.pkg.devDependencies.prettier = "^3.9.10";
      f.lock.packages[""].devDependencies.prettier = "^3.9.10";
    },
  ],
  [
    "lock dependency drift",
    (f) => {
      f.lock.packages["node_modules/prettier"].version = "3.9.9";
    },
  ],
  [
    "package identity drift",
    (f) => {
      f.lock.version = "1.0.0";
    },
  ],
  [
    "missing byte integrity",
    (f) => {
      delete f.lock.packages["node_modules/prettier"].integrity;
    },
  ],
  [
    "unexpected dependency origin",
    (f) => {
      f.lock.packages["node_modules/prettier"].resolved =
        "https://other.invalid/archive.tgz";
    },
  ],
  [
    "Node pin drift",
    (f) => {
      f.pkg.engines.node = "24.22.1";
    },
  ],
]) {
  test(`toolchain rejects ${label} without executing package code`, (t) => {
    const f = fixture(t);
    mutate(f);
    f.save();
    assert.throws(
      () => checkToolchain(f.root, { runtime: "24.22.2" }),
      /pin|lock|identity|integrity|origin|Node/i,
    );
  });
}

test("toolchain refuses a different running Node version", (t) => {
  const f = fixture(t);
  assert.throws(
    () => checkToolchain(f.root, { runtime: "22.0.0" }),
    /Node|runtime/i,
  );
});
