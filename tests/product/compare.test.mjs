import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { compareInventories } from "../../src/core/compare.mjs";

const digest = (text) => createHash("sha256").update(text).digest("hex");
function file(path, text, options = {}) {
  const content = Buffer.from(text);
  return {
    path,
    originalPath: `package/${path}`,
    type: "file",
    size: content.length,
    sha256: digest(content),
    content,
    inspection: "retained",
    ...options,
  };
}
function inventory(entries, options = {}) {
  return {
    digest: { sha256: digest("original archive") },
    entries,
    complete: true,
    failures: [],
    ...options,
  };
}

test("every artifact regular byte is counted across exhaustive correspondence states", () => {
  const artifact = inventory([
    file("same", "abc"),
    file("changed", "x"),
    file("added", "zz"),
    file(null, "p", { originalPath: "prefixless" }),
    {
      type: "symlink",
      path: "link",
      originalPath: "package/link",
      size: 0,
      linkTarget: "same",
    },
  ]);
  const source = inventory([
    file("same", "abc"),
    file("changed", "y"),
    file("omitted", "hello"),
  ]);
  const result = compareInventories(artifact, source);
  assert.deepEqual(
    result.files.map((f) => [f.path, f.state]),
    [
      [null, "not-compared"],
      ["added", "artifact-only"],
      ["changed", "changed"],
      ["same", "byte-identical"],
    ],
  );
  assert.deepEqual(result.coverage.inventory, {
    files: 4,
    bytes: 7,
    complete: true,
    lowerBound: false,
  });
  assert.deepEqual(result.coverage.compared, { files: 2, bytes: 4 });
  assert.deepEqual(result.coverage.states["not-compared"], {
    files: 1,
    bytes: 1,
  });
  assert.deepEqual(result.coverage.unresolved, { files: 3, bytes: 4 });
  assert.deepEqual(result.coverage.syntaxInspected, { files: 0, bytes: 0 });
  assert.deepEqual(result.coverage.modelReviewed, { files: 0, bytes: 0 });
  assert.deepEqual(result.coverage.links, { artifact: 1, source: 0 });
  assert.deepEqual(result.coverage.sourceOnly, ["omitted"]);
  assert.equal(result.files[0].reason, "prefixless");
});

test("links at or above matching source paths never establish absence or identity", () => {
  for (const type of ["symlink", "hardlink"]) {
    const result = compareInventories(
      inventory([file("dir/a", "abc"), file("dir", "z")]),
      inventory([
        {
          type,
          path: "dir",
          originalPath: "root/dir",
          size: 0,
          linkTarget: "../elsewhere",
        },
      ]),
    );
    assert.ok(
      result.files.every(
        (f) => f.state === "not-compared" && f.reason === "source-link",
      ),
    );
    assert.ok(
      result.files.every((f) => f.sourceLink.linkTarget === "../elsewhere"),
    );
    assert.equal(result.coverage.compared.bytes, 0);
  }
});

test("incomplete source can match observed files but cannot prove absent paths", () => {
  const result = compareInventories(
    inventory([file("known", "abc"), file("absent", "x")]),
    inventory([file("known", "abc")], { complete: false }),
  );
  assert.equal(
    result.files.find((f) => f.path === "known").state,
    "byte-identical",
  );
  assert.equal(
    result.files.find((f) => f.path === "absent").reason,
    "source-incomplete",
  );
  assert.equal(result.coverage.complete, false);
  assert.equal("percentage" in result.coverage, false);
});

test("missing source is artifact inspection with zero correspondence, not claimed absence", () => {
  const result = compareInventories(inventory([file("a", "abc")]), null);
  assert.equal(result.files[0].state, "not-compared");
  assert.equal(result.files[0].reason, "source-unavailable");
  assert.equal(result.coverage.sourceAvailable, false);
  assert.equal(result.coverage.complete, true);
});

test("unretained binaries and huge files still use size and digest for correspondence", () => {
  const huge = file("huge", "", {
    size: 20000000,
    sha256: digest("huge content"),
    content: null,
    inspection: "size-cap",
  });
  const result = compareInventories(
    inventory([huge]),
    inventory([{ ...huge, size: 19999999 }]),
  );
  assert.equal(result.files[0].state, "changed");
  assert.equal(result.files[0].localization, "whole-file");
  assert.equal(result.coverage.inventory.bytes, 20000000);
  assert.equal(
    compareInventories(inventory([huge]), inventory([huge])).files[0].state,
    "byte-identical",
  );
});

test("retained changes expose bounded half-open byte spans with deterministic provenance IDs", () => {
  const a = inventory([file("a", "oneXXend")]);
  const b = inventory([file("a", "oneYend")]);
  const result = compareInventories(a, b);
  const changed = result.files[0];
  assert.equal(changed.localization, "byte-spans");
  assert.deepEqual(changed.spans, { artifact: [3, 5], source: [3, 4] });
  assert.deepEqual(
    result.evidence.map((e) => e.range),
    [
      [3, 5],
      [3, 4],
    ],
  );
  assert.deepEqual(
    result.evidence.map((e) => e.excerpt),
    ["XX", "Y"],
  );
  assert.ok(
    result.evidence.every(
      (e) => e.blobDigest === a.digest.sha256 && e.id.startsWith("ev-"),
    ),
  );
  assert.deepEqual(result, compareInventories(a, b));
  assert.notEqual(
    result.evidence[0].id,
    compareInventories({ ...a, digest: { sha256: digest("other archive") } }, b)
      .evidence[0].id,
  );
  assert.equal(JSON.stringify(result).includes('"type":"Buffer"'), false);
});

test("incomplete artifact bytes are explicitly lower bounds and input order is irrelevant", () => {
  const entries = [file("z", "abc"), file("a", "def")];
  const first = compareInventories(
    inventory(entries, { complete: false }),
    null,
  );
  const second = compareInventories(
    inventory([...entries].reverse(), { complete: false }),
    null,
  );
  assert.deepEqual(first, second);
  assert.equal(first.coverage.inventory.lowerBound, true);
  assert.equal(first.coverage.complete, false);
});

test("nested inert source links choose the same ancestor regardless of inventory order", () => {
  const a = inventory([file("dir/sub/a", "abc")]);
  const links = [
    {
      type: "symlink",
      path: "dir",
      originalPath: "root/dir",
      size: 0,
      linkTarget: "first",
    },
    {
      type: "hardlink",
      path: "dir/sub",
      originalPath: "root/dir/sub",
      size: 0,
      linkTarget: "second",
    },
  ];
  assert.deepEqual(
    compareInventories(a, inventory(links)),
    compareInventories(a, inventory([...links].reverse())),
  );
  const near = compareInventories(
    inventory([file("directory/a", "x")]),
    inventory(links),
  );
  assert.equal(near.files[0].state, "artifact-only");
});

test("empty files, insertions and deletions retain exact half-open evidence ranges", () => {
  for (const [a, b, spans] of [
    ["", "x", { artifact: [0, 0], source: [0, 1] }],
    ["xy", "x", { artifact: [1, 2], source: [1, 1] }],
  ]) {
    const result = compareInventories(
      inventory([file("a", a)]),
      inventory([file("a", b)]),
    );
    assert.deepEqual(result.files[0].spans, spans);
    assert.equal(result.coverage.inventory.bytes, Buffer.byteLength(a));
  }
});

test("evidence excerpts are bounded and binary retained data is not rendered as text", () => {
  const result = compareInventories(
    inventory([
      file("a", "x".repeat(4096)),
      file("b", Buffer.from([255, 0, 254])),
    ]),
    null,
  );
  assert.equal(result.evidence[0].excerpt.length, 512);
  assert.deepEqual(result.evidence[0].excerptRange, [0, 512]);
  assert.equal(result.evidence[1].excerpt, undefined);
});

test("invalid inventory hashes and duplicate paths cannot silently become correspondence", () => {
  assert.throws(
    () =>
      compareInventories(
        inventory([file("a", "x", { sha256: digest("different") })]),
        null,
      ),
    TypeError,
  );
  assert.throws(
    () => compareInventories(inventory([file("a", "x"), file("a", "y")]), null),
    TypeError,
  );
});

test("inert links retain raw provenance separately from regular-byte denominators", () => {
  const result = compareInventories(
    inventory([
      {
        type: "symlink",
        path: "link",
        originalPath: "odd/link",
        size: 0,
        linkTarget: "../../untrusted",
      },
    ]),
    null,
  );
  assert.deepEqual(result.coverage.inventory, {
    files: 0,
    bytes: 0,
    complete: true,
    lowerBound: false,
  });
  assert.deepEqual(result.coverage.linkEntries, [
    {
      side: "artifact",
      path: "link",
      originalPath: "odd/link",
      type: "symlink",
      linkTarget: "../../untrusted",
    },
  ]);
});
