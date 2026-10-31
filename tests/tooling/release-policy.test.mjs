import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  planRelease,
  verifyAsset,
  validatePackageFiles,
} from "../../scripts/release-policy.mjs";

const sha = "a".repeat(40);
const input = () => ({
  version: "1.2.3",
  sha,
  ref: "refs/heads/main",
  checks: "success",
  ready: true,
  tags: [],
  releases: [],
});

test("planner binds stable version, exact source and deployment digest", () => {
  const plan = planRelease(input());
  assert.equal(plan.tag, "v1.2.3");
  assert.equal(plan.sha, sha);
  assert.equal(plan.imageTag, `sha-${sha}`);
});

for (const field of ["tags", "releases"]) {
  test(`planner refuses an existing version in ${field}, including reruns`, () => {
    assert.throws(
      () => planRelease({ ...input(), [field]: ["v1.2.3"] }),
      /already exists/,
    );
  });
}

for (const [change, message] of [
  [{ version: "0.0.0" }, /positive stable/],
  [{ version: "01.2.3" }, /positive stable/],
  [{ version: "1.2.3-rc.1" }, /positive stable/],
  [{ sha: "main" }, /full commit/],
  [{ ref: "refs/pull/4/merge" }, /main/],
  [{ checks: "failure" }, /checks/],
  [{ checks: "skipped" }, /checks/],
  [{ ready: false }, /ready/],
]) {
  test(`planner fails closed for ${JSON.stringify(change)}`, () => {
    assert.throws(() => planRelease({ ...input(), ...change }), message);
  });
}

test("asset integrity binds actual bytes and rejects a changed archive", () => {
  const bytes = Buffer.from("actual artifact bytes");
  const expected = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  assert.equal(verifyAsset(bytes, expected), expected);
  assert.throws(
    () => verifyAsset(Buffer.from("changed"), expected),
    /digest mismatch/,
  );
});

test("package file allowlist rejects internal files even under dist", () => {
  validatePackageFiles(["package.json", "README.md", "LICENSE", "dist/cli.js"]);
  for (const file of [
    "HACKATHON.md",
    ".env",
    "internal/review.md",
    "research/results.json",
    "dist/internal/notes.md",
    "dist/.env",
    "dist/private.internal.md",
    "../outside",
    "dist/../secret",
  ]) {
    assert.throws(
      () => validatePackageFiles(["package.json", file]),
      /not allowed/,
    );
  }
});
