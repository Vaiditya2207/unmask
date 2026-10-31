import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkPackage } from "../../scripts/check-package.mjs";

test("real npm archive excludes research, local secrets, tests and automation", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "unmask-package-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "output"));
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "unmask-fixture",
      version: "1.0.0",
      private: true,
      files: ["dist"],
      scripts: { prepack: 'node -e "process.exit(99)"' },
    }),
  );
  for (const file of [
    "README.md",
    "LICENSE",
    "dist/cli.js",
    "internal/notes.md",
    "research/raw.json",
    "scripts/private.mjs",
    "tests/private.mjs",
    ".env",
    "HACKATHON.md",
  ]) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), "Fixture content\n");
  }
  const result = checkPackage(root, path.join(root, "output"));
  assert.deepEqual(result.files.sort(), [
    "LICENSE",
    "README.md",
    "dist/cli.js",
    "package.json",
  ]);
  assert.match(result.digest, /^sha256:[a-f0-9]{64}$/);
  assert.ok(result.size > 0);
});
