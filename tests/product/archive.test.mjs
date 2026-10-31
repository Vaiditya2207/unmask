import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { createHash, randomBytes } from "node:crypto";
import tar from "tar-stream";
const headers = {
  encode({ name, type, size }) {
    const b = Buffer.alloc(512);
    b.write(name, 0, 100);
    b.write(size.toString(8).padStart(11, "0") + "\0", 124, 12);
    b[156] = { file: 48, "pax-header": 120, "gnu-long-path": 76, fifo: 54 }[
      type
    ];
    b.write("ustar\0", 257);
    b.write("00", 263);
    b.fill(32, 148, 156);
    b.write(
      b
        .reduce((sum, n) => sum + n, 0)
        .toString(8)
        .padStart(6, "0") + "\0 ",
      148,
      8,
    );
    return b;
  },
  encodePax({ name }) {
    const value = " path=" + name + "\n";
    let length = Buffer.byteLength(value) + 1;
    while (String(length).length + Buffer.byteLength(value) !== length)
      length = String(length).length + Buffer.byteLength(value);
    return Buffer.from(String(length) + value);
  },
};
import { readArchive } from "../../src/core/archive.mjs";

async function archive(entries) {
  const pack = tar.pack();
  const chunks = [];
  const done = (async () => {
    for await (const chunk of pack) chunks.push(chunk);
  })();
  for (const item of entries) {
    const { body = "", ...header } = item;
    pack.entry(
      header,
      header.type && header.type !== "file" ? undefined : body,
    );
  }
  pack.finalize();
  await done;
  return gzipSync(Buffer.concat(chunks));
}
function rawArchive(items) {
  const chunks = [];
  for (const {
    name = "package/x",
    type = "file",
    body = Buffer.alloc(0),
    size = body.length,
  } of items) {
    chunks.push(
      headers.encode({
        name,
        type,
        size,
        mode: 0o644,
        uid: 0,
        gid: 0,
        mtime: new Date(0),
      }),
      body,
      Buffer.alloc((512 - (body.length % 512)) % 512),
    );
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}
const options = { kind: "artifact" };
test("hashes original gzip bytes and strips exactly one component", async () => {
  const bytes = await archive([
    { name: "prefix/lib/x.js", body: "abc" },
    { name: "loose", body: "x" },
  ]);
  const result = await readArchive(bytes, options);
  assert.equal(result.complete, true);
  assert.equal(
    result.digest.sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  assert.equal(result.digest.sha512.length, 128);
  assert.deepEqual(
    result.entries.map((e) => e.path),
    ["lib/x.js", null],
  );
  assert.equal(
    result.entries[0].sha256,
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.equal(result.entries[0].content.toString(), "abc");
});
test("links are inert with raw targets and never hashed", async () => {
  const result = await readArchive(
    await archive([
      { name: "package/a", type: "symlink", linkname: "/outside" },
      { name: "package/b", type: "link", linkname: "../outside" },
    ]),
    options,
  );
  assert.equal(result.complete, true);
  assert.deepEqual(
    result.entries.map((e) => [e.type, e.linkTarget, e.content, e.sha256]),
    [
      ["symlink", "/outside", null, undefined],
      ["hardlink", "../outside", null, undefined],
    ],
  );
});
for (const name of [
  "../outside",
  "/outside",
  "package/../outside",
  "C:/outside",
  "package\\outside",
]) {
  test(`rejects unsafe original path ${name}`, async () => {
    const result = await readArchive(
      await archive([{ name, body: "x" }]),
      options,
    );
    assert.equal(result.complete, false);
    assert.ok(result.failures.some((f) => f.code === "unsafe-path"));
  });
}
test("rejects traversal in PAX override", async () => {
  const result = await readArchive(
    await archive([
      { name: "package/ok", pax: { path: "../outside" }, body: "x" },
    ]),
    options,
  );
  assert.equal(result.complete, false);
  assert.ok(result.failures.some((f) => f.code === "unsafe-path"));
});
test("rejects original metadata path traversal even when PAX override is safe", async () => {
  const result = await readArchive(
    rawArchive([
      {
        name: "../outside",
        type: "pax-header",
        body: headers.encodePax({ name: "package/ok" }),
      },
      { name: "package/ok", body: Buffer.from("x") },
    ]),
    options,
  );
  assert.equal(result.complete, false);
  assert.ok(result.failures.some((f) => f.code === "unsafe-path"));
});
for (const names of [
  ["package/A", "package/a"],
  ["a/x", "b/x"],
  ["package/é", "package/e\u0301"],
  ["package/x", "package/x"],
]) {
  test(`rejects path collision ${JSON.stringify(names)}`, async () => {
    const result = await readArchive(
      await archive(names.map((name) => ({ name, body: "x" }))),
      options,
    );
    assert.equal(result.complete, false);
    assert.ok(result.failures.some((f) => f.code === "path-collision"));
  });
}
test("retention cap discards content but streams full hash across shared archives", async () => {
  const budget = { limitBytes: 4, usedBytes: 0 };
  const bytes = await archive([
    { name: "package/a", body: "abc" },
    { name: "package/b", body: "xyz" },
  ]);
  const first = await readArchive(bytes, {
    ...options,
    retentionBudget: budget,
  });
  const second = await readArchive(bytes, {
    ...options,
    retentionBudget: budget,
  });
  assert.equal(first.complete, true);
  assert.equal(budget.usedBytes, 3);
  assert.equal(first.entries[1].inspection, "retention-cap");
  assert.equal(first.entries[1].content, null);
  assert.equal(
    first.entries[1].sha256,
    createHash("sha256").update("xyz").digest("hex"),
  );
  assert.equal(second.totals.retainedBytes, 0);
});
test("per-file retention cap preserves full hash without retaining a prefix", async () => {
  const result = await readArchive(
    await archive([{ name: "p/x", body: "abcdef" }]),
    { ...options, limits: { fileBytes: 2 } },
  );
  assert.equal(result.entries[0].inspection, "size-cap");
  assert.equal(result.entries[0].content, null);
  assert.equal(
    result.entries[0].sha256,
    createHash("sha256").update("abcdef").digest("hex"),
  );
});
for (const [limits, code] of [
  [{ compressedBytes: 1 }, "compressed-cap"],
  [{ expandedBytes: 512 }, "expanded-cap"],
  [{ entries: 1 }, "entry-cap"],
  [{ ratio: 1 }, "ratio-cap"],
  [{ parseMs: 0 }, "parse-timeout"],
]) {
  test(`enforces ${code} with incomplete lower-bound inventory`, async () => {
    const result = await readArchive(
      await archive([
        { name: "p/a", body: "abc" },
        { name: "p/b", body: "def" },
      ]),
      { ...options, limits },
    );
    assert.equal(result.complete, false);
    assert.ok(
      result.failures.some((f) => f.code === code),
      JSON.stringify(result.failures),
    );
  });
}
test("declared huge file is rejected before allocation or retention reservation", async () => {
  const budget = { limitBytes: 134217728, usedBytes: 0 };
  const result = await readArchive(rawArchive([{ size: 2 ** 40 }]), {
    ...options,
    retentionBudget: budget,
  });
  assert.equal(result.complete, false);
  assert.equal(budget.usedBytes, 0);
});
test("malformed gzip, truncated tar, unsupported entry and oversized metadata become data failures", async () => {
  for (const bytes of [
    Buffer.from("invalid"),
    gzipSync(Buffer.alloc(13)),
    rawArchive([{ type: "fifo" }]),
    rawArchive([{ type: "pax-header", size: 100000 }]),
  ]) {
    const result = await readArchive(bytes, options);
    assert.equal(result.complete, false);
    assert.ok(result.failures.length > 0);
  }
});
test("source archives require explicit root and reject entries outside it", async () => {
  const bytes = await archive([{ name: "repo-sha/package.json", body: "{}" }]);
  assert.equal((await readArchive(bytes, { kind: "source" })).complete, false);
  assert.equal(
    (await readArchive(bytes, { kind: "source", sourceRoot: "other" }))
      .complete,
    false,
  );
  const result = await readArchive(bytes, {
    kind: "source",
    sourceRoot: "repo-sha",
  });
  assert.equal(result.complete, true);
  assert.equal(result.entries[0].path, "package.json");
});
test("rejects true GNU path overrides with traversal and accepts safe GNU override", async () => {
  const bad = await readArchive(
    rawArchive([
      {
        name: "LongLink",
        type: "gnu-long-path",
        body: Buffer.from("../outside\0"),
      },
      { name: "package/ok", body: Buffer.from("abc") },
    ]),
    options,
  );
  assert.equal(bad.complete, false);
  assert.ok(bad.failures.some((f) => f.code === "unsafe-path"));
  const good = await readArchive(
    rawArchive([
      {
        name: "LongLink",
        type: "gnu-long-path",
        body: Buffer.from("package/long/path\0"),
      },
      { name: "package/ok", body: Buffer.from("abc") },
    ]),
    options,
  );
  assert.equal(good.complete, true);
  assert.equal(good.entries[0].path, "long/path");
});
test("accepts safe PAX override and rejects PAX embedded NUL or malformed lengths", async () => {
  const good = await readArchive(
    await archive([
      {
        name: "package/original",
        pax: { path: "package/effective" },
        body: "abc",
      },
    ]),
    options,
  );
  assert.equal(good.complete, true);
  assert.equal(good.entries[0].originalPath, "package/effective");
  for (const body of [
    Buffer.from("0 path=x\n"),
    Buffer.from("999 path=x\n"),
    headers.encodePax({ name: "package/evil\0tail" }),
  ]) {
    const bad = await readArchive(
      rawArchive([
        { name: "PaxHeader", type: "pax-header", body },
        { name: "package/x", body: Buffer.from("abc") },
      ]),
      options,
    );
    assert.equal(bad.complete, false);
  }
});
test("rejects implicit parent case collisions and non-directory shadowing in either order", async () => {
  for (const names of [
    ["package/A/x", "package/a/y"],
    ["package/a", "package/a/x"],
    ["package/a/x", "package/a"],
  ]) {
    const result = await readArchive(
      await archive(names.map((name) => ({ name, body: "x" }))),
      options,
    );
    assert.equal(result.complete, false);
    assert.ok(result.failures.some((f) => f.code === "path-collision"));
  }
});
test("declared entry sizes cannot reserve beyond expanded budget", async () => {
  const budget = { limitBytes: 134217728, usedBytes: 0 };
  const result = await readArchive(rawArchive([{ size: 1000000 }]), {
    ...options,
    limits: { expandedBytes: 10000 },
    retentionBudget: budget,
  });
  assert.equal(result.complete, false);
  assert.ok(result.failures.some((f) => f.code === "expanded-cap"));
  assert.equal(budget.usedBytes, 0);
});
test("truncated file releases reserved retention and leaves no partial entry", async () => {
  const bytes = rawArchive([{ size: 10000, body: Buffer.from("short") }]);
  const budget = { limitBytes: 134217728, usedBytes: 0 };
  const result = await readArchive(bytes, {
    ...options,
    retentionBudget: budget,
  });
  assert.equal(result.complete, false);
  assert.equal(result.entries.length, 0);
  assert.equal(budget.usedBytes, 0);
});
test("valid directories may arrive after implicit parents without being duplicate files", async () => {
  const result = await readArchive(
    await archive([
      { name: "package/a/x", body: "x" },
      { name: "package/a", type: "directory" },
    ]),
    options,
  );
  assert.equal(result.complete, true);
});
test("rejects aligned truncation and nonzero data following tar termination", async () => {
  const full = rawArchive([{ body: Buffer.from("abc") }]);
  const { gunzipSync } = await import("node:zlib");
  const raw = gunzipSync(full);
  for (const body of [
    raw.subarray(0, raw.length - 1024),
    Buffer.concat([raw, raw.subarray(0, 1024)]),
    Buffer.alloc(0),
  ]) {
    const result = await readArchive(gzipSync(body), options);
    assert.equal(result.complete, false);
  }
});
test("bounds path metadata before building path indexes", async () => {
  const result = await readArchive(
    await archive([{ name: "package/" + "x".repeat(4096), body: "x" }]),
    options,
  );
  assert.equal(result.complete, false);
  assert.ok(result.failures.some((f) => f.code === "path-cap"));
});
test("rejects absolute paths introduced by prefix stripping", async () => {
  const result = await readArchive(
    await archive([{ name: "package/C:/outside", body: "x" }]),
    options,
  );
  assert.equal(result.complete, false);
  assert.ok(result.failures.some((f) => f.code === "unsafe-path"));
});
test("stream-hashes multiple decompressor chunks beyond retention", async () => {
  const body = randomBytes(100001);
  const result = await readArchive(
    await archive([{ name: "package/large", body }]),
    { ...options, limits: { fileBytes: 16 } },
  );
  assert.equal(result.complete, true);
  assert.equal(result.entries[0].content, null);
  assert.equal(result.entries[0].size, 100001);
  assert.equal(
    result.entries[0].sha256,
    createHash("sha256").update(body).digest("hex"),
  );
});
test("programming contract violations remain exceptions", async () => {
  await assert.rejects(readArchive("not a Buffer", options), TypeError);
  await assert.rejects(
    readArchive(Buffer.alloc(0), { kind: "unknown" }),
    TypeError,
  );
  await assert.rejects(
    readArchive(Buffer.alloc(0), { ...options, limits: { entries: -1 } }),
    TypeError,
  );
  await assert.rejects(
    readArchive(Buffer.alloc(0), {
      ...options,
      retentionBudget: { limitBytes: 1, usedBytes: 2 },
    }),
    TypeError,
  );
});
test("consecutive local PAX headers replace size before any retention allocation", async () => {
  let used = 0,
    peak = 0;
  const budget = {
    limitBytes: 134217728,
    get usedBytes() {
      return used;
    },
    set usedBytes(value) {
      used = value;
      peak = Math.max(peak, value);
    },
  };
  const bytes = rawArchive([
    { name: "PaxHeader", type: "pax-header", body: Buffer.from("10 size=0\n") },
    {
      name: "PaxHeader",
      type: "pax-header",
      body: headers.encodePax({ name: "package/data" }),
    },
    { name: "package/data", size: 3000 },
  ]);
  const result = await readArchive(bytes, {
    ...options,
    limits: { expandedBytes: 4000 },
    retentionBudget: budget,
  });
  assert.equal(result.complete, false);
  assert.ok(
    result.failures.some((f) => f.code === "expanded-cap"),
    JSON.stringify(result.failures),
  );
  assert.equal(peak, 0);
});
test("deep narrow path fixtures hit depth cap before building path indexes", async () => {
  const bytes = await archive(
    Array.from({ length: 32 }, (_, i) => ({
      name: `package/p${i}/${"x/".repeat(1000)}f`,
      body: Buffer.alloc(256, i),
    })),
  );
  const result = await readArchive(bytes, {
    ...options,

    retentionBudget: { limitBytes: 0, usedBytes: 0 },
  });
  assert.equal(result.complete, false);
  assert.ok(result.failures.some((f) => f.code === "path-depth-cap"));
  assert.equal(result.totals.regularFiles, 0);
  assert.equal(result.limits.pathDepth, 64);
});
test("original and mapped indexes share an aggregate node cap before allocation", async () => {
  const bytes = await archive(
    ["a", "b", "c", "d"].map((name) => ({
      name: `package/${name}/f`,
      body: "x",
    })),
  );
  const result = await readArchive(bytes, {
    ...options,
    limits: { pathNodes: 9 },
  });
  assert.equal(result.complete, false);
  assert.ok(result.failures.some((f) => f.code === "path-node-cap"));
  assert.equal(result.totals.regularFiles, 2);
  assert.equal(result.limits.pathNodes, 9);
});
test("valid consecutive PAX replacement uses the later header and hashes all bytes", async () => {
  const body = Buffer.alloc(3000, 42);
  const bytes = rawArchive([
    { name: "PaxHeader", type: "pax-header", body: Buffer.from("10 size=0\n") },
    {
      name: "PaxHeader",
      type: "pax-header",
      body: headers.encodePax({ name: "package/data" }),
    },
    { name: "package/data", body },
  ]);
  const result = await readArchive(bytes, {
    ...options,
    limits: { expandedBytes: 7000 },
  });
  assert.equal(result.complete, true);
  assert.equal(result.entries[0].size, 3000);
  assert.equal(
    result.entries[0].sha256,
    createHash("sha256").update(body).digest("hex"),
  );
});
test("configured depth and path byte caps report actual limits at their boundary", async () => {
  const valid = await readArchive(
    await archive([{ name: "p/a/f", body: "x" }]),
    { ...options, limits: { pathDepth: 3, pathBytes: 5 } },
  );
  assert.equal(valid.complete, true);
  assert.equal(valid.limits.pathDepth, 3);
  assert.equal(valid.limits.pathBytes, 5);
  assert.equal(valid.limits.metadataBytes, 65536);
  const deep = await readArchive(
    await archive([{ name: "p/a/b/f", body: "x" }]),
    { ...options, limits: { pathDepth: 3 } },
  );
  assert.ok(deep.failures.some((f) => f.code === "path-depth-cap"));
  const wide = await readArchive(
    await archive([{ name: "p/long", body: "x" }]),
    { ...options, limits: { pathBytes: 5 } },
  );
  assert.ok(wide.failures.some((f) => f.code === "path-cap"));
});
test("default node budget stops actual component Map allocations at 40000", async () => {
  const bytes = await archive(
    Array.from({ length: 10001 }, (_, i) => ({
      name: `package/p${i}/f`,
      body: createHash("sha256").update(String(i)).digest(),
    })),
  );
  const OriginalMap = globalThis.Map;
  let allocations = 0;
  let result;
  globalThis.Map = class CountedMap extends OriginalMap {
    constructor(...args) {
      super(...args);
      allocations++;
    }
  };
  try {
    result = await readArchive(bytes, {
      ...options,
      retentionBudget: { limitBytes: 0, usedBytes: 0 },
    });
  } finally {
    globalThis.Map = OriginalMap;
  }
  assert.equal(result.complete, false);
  assert.ok(result.failures.some((f) => f.code === "path-node-cap"));
  assert.equal(result.limits.pathNodes, 40000);
  assert.equal(allocations, 40002);
  assert.equal(result.totals.regularFiles, 9999);
});
test("caller options cannot raise the enforced default caps", async () => {
  const bytes = await archive([{ name: "p/f", body: "x" }]);
  for (const [name, value] of Object.entries({
    compressedBytes: 52428801,
    expandedBytes: 262144001,
    entries: 20001,
    ratio: 101,
    fileBytes: 10485761,
    parseMs: 30001,
    metadataBytes: 65537,
    pathBytes: 4097,
    pathDepth: 65,
    pathNodes: 40001,
  })) {
    await assert.rejects(
      readArchive(bytes, { ...options, limits: { [name]: value } }),
      TypeError,
      name,
    );
  }
});
