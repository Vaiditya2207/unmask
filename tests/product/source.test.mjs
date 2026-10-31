import test from "node:test";
import assert from "node:assert/strict";
import { selectSourcePackage } from "../../src/core/source.mjs";
const file = (path, body) => ({
  path,
  originalPath: `repo/${path}`,
  type: "file",
  size: Buffer.byteLength(body),
  content: Buffer.from(body),
  inspection: "retained",
});
const inventory = (entries) => ({ entries, complete: true });
test("selects unique matching monorepo manifest and preserves inert links", () => {
  const result = selectSourcePackage(
    inventory([
      file("packages/a/package.json", '{"name":"wanted"}'),
      file("packages/b/package.json", '{"name":"other"}'),
      { path: "packages/a/link", type: "symlink", linkTarget: "/outside" },
    ]),
    { packageName: "wanted" },
  );
  assert.equal(result.status, "selected");
  assert.equal(result.directory, "packages/a");
  assert.equal(result.manifest.name, "wanted");
  assert.deepEqual(
    result.entries.map((e) => e.path),
    ["link", "package.json"],
  );
});
test("explicit usable directory wins over name inference including root", () => {
  const inv = inventory([
    file("package.json", '{"name":"root"}'),
    file("packages/a/package.json", '{"name":"wanted"}'),
  ]);
  assert.equal(
    selectSourcePackage(inv, { directory: "", packageName: "wanted" }).manifest
      .name,
    "root",
  );
  assert.equal(
    selectSourcePackage(inv, {
      directory: "packages/a",
      packageName: "different",
    }).status,
    "selected",
  );
});
test("ambiguous manifests and incomplete automatic selection remain unresolved", () => {
  const inv = inventory([
    file("a/package.json", '{"name":"wanted"}'),
    file("b/package.json", '{"name":"wanted"}'),
  ]);
  assert.equal(
    selectSourcePackage(inv, { packageName: "wanted" }).status,
    "unresolved",
  );
  assert.equal(
    selectSourcePackage({ ...inv, complete: false }, { packageName: "wanted" })
      .status,
    "unresolved",
  );
});
test("refuses symlink and hardlink package roots or ancestors even with regular descendants", () => {
  for (const type of ["symlink", "hardlink"]) {
    const inv = inventory([
      { path: "packages", type, linkTarget: "elsewhere" },
      file("packages/a/package.json", '{"name":"wanted"}'),
    ]);
    assert.equal(
      selectSourcePackage(inv, { directory: "packages/a" }).status,
      "unresolved",
    );
    assert.equal(
      selectSourcePackage(inv, { packageName: "wanted" }).status,
      "unresolved",
    );
  }
});
test("refuses traversal and missing directories", () => {
  const inv = inventory([
    file("x/package.json", "broken"),
    file("y/package.json", "[]"),
  ]);
  for (const directory of ["../x", "/x", "missing"])
    assert.equal(selectSourcePackage(inv, { directory }).status, "unresolved");
});

test("explicit directory keeps comparison files when manifest is unavailable", () => {
  for (const [entry, reason] of [
    [null, "missing"],
    [file("a/package.json", "broken"), "invalid-json"],
    [
      {
        ...file("a/package.json", "{}"),
        content: null,
        inspection: "size-cap",
      },
      "size-cap",
    ],
    [
      {
        ...file("a/package.json", "{}"),
        content: null,
        inspection: "retention-cap",
      },
      "retention-cap",
    ],
  ]) {
    const result = selectSourcePackage(
      inventory([file("a/index.js", "abc"), ...(entry ? [entry] : [])]),
      { directory: "a" },
    );
    assert.equal(result.status, "selected");
    assert.equal(result.manifest, null);
    assert.equal(result.reason, reason);
    assert.ok(result.entries.some((e) => e.path === "index.js"));
  }
});
test("source selection refuses unsafe paths introduced by package mapping", () => {
  const result = selectSourcePackage(
    inventory([
      file("a/package.json", '{"name":"wanted"}'),
      file("a/C:/outside", "abc"),
    ]),
    { directory: "a" },
  );
  assert.equal(result.status, "unresolved");
});
