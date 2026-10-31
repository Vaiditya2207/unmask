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

for (const field of ["tags", "releases"]) {
  test(`planner rejects a downgrade below the maximum stable ${field} version`, () => {
    assert.throws(
      () =>
        planRelease({
          ...input(),
          version: "1.2.0",
          [field]: ["v1.0.0", "v2.0.0", "v1.1.0"],
        }),
      /must increase/,
    );
  });
}

test("planner rejects equality even when an existing stable tag omits v", () => {
  assert.throws(
    () => planRelease({ ...input(), tags: ["1.2.3"] }),
    /must increase/,
  );
});

test("planner compares numeric segments rather than strings", () => {
  assert.equal(
    planRelease({ ...input(), version: "1.10.0", tags: ["v1.9.999"] }).version,
    "1.10.0",
  );
  assert.throws(
    () =>
      planRelease({ ...input(), version: "1.9.999", releases: ["v1.10.0"] }),
    /must increase/,
  );
});

test("planner preserves precision for integers beyond Number.MAX_SAFE_INTEGER", () => {
  assert.throws(
    () =>
      planRelease({
        ...input(),
        version: "9007199254740992.0.1",
        tags: ["v9007199254740993.0.0"],
      }),
    /must increase/,
  );
  assert.equal(
    planRelease({
      ...input(),
      version: "9007199254740993.0.0",
      releases: ["v9007199254740992.999999999999999999.999999999999999999"],
    }).tag,
    "v9007199254740993.0.0",
  );
});

test("planner ignores prerelease and unrelated refs when finding stable maximum", () => {
  assert.equal(
    planRelease({
      ...input(),
      tags: ["v1.2.2", "v999.0.0-rc.1", "archive-2026", "v01.2.3"],
    }).version,
    "1.2.3",
  );
});
