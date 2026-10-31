import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { compareInventories } from "../../src/core/compare.mjs";
import { test } from "node:test";
import { createApp } from "../../src/server/app.mjs";

const hash = "a".repeat(64);
function fixture() {
  return {
    inputs: { claim: { name: "example", version: "1.0.0" } },
    files: [
      {
        path: "src/change.js",
        originalPath: "package/src/change.js",
        size: 8,
        artifactSha256: hash,
        sourceSha256: "b".repeat(64),
        state: "changed",
        evidenceIds: [],
      },
      {
        path: "same.js",
        originalPath: "package/same.js",
        size: 1,
        artifactSha256: hash,
        sourceSha256: hash,
        state: "byte-identical",
        evidenceIds: [],
      },
      {
        path: "new.js",
        originalPath: "package/new.js",
        size: 2,
        artifactSha256: hash,
        state: "artifact-only",
        evidenceIds: [],
      },
      {
        path: null,
        originalPath: "prefixless.js",
        size: 3,
        artifactSha256: hash,
        state: "not-compared",
        reason: "prefixless",
        evidenceIds: [],
      },
    ],
    evidence: [],
    coverage: {
      sourceOnly: ["old.js"],
      sourceComplete: true,
      inventory: { complete: true },
    },
    failures: [],
    policy: { exitCode: 0, findings: [] },
    model: { status: "disabled" },
  };
}
async function serve(t, report = fixture(), options = {}) {
  let calls = 0;
  const app = createApp({
    versionInfo: {
      version: "0.1.2",
      commit: "a".repeat(40),
      tarballSha256: hash,
    },
    runAnalysis: async () => {
      calls++;
      return report;
    },
    enrichJob: async () => ({}),
    ...options,
  });
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        app.closeAllConnections();
        app.close(resolve);
      }),
  );
  const origin = `http://127.0.0.1:${app.address().port}`;
  const submitted = await fetch(`${origin}/check`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "package=example%401.0.0",
  });
  const path = submitted.headers.get("location");
  for (let i = 0; i < 50; i++) {
    if ((await fetch(origin + path + ".json")).status !== 202) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return {
    get: (suffix) => fetch(origin + path + suffix),
    origin,
    path,
    calls: () => calls,
  };
}

test("inventory exposes stored artifact/source states in stable bounded pages", async (t) => {
  const s = await serve(t);
  const response = await s.get("/files.json?limit=2&offset=1");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^application\/json/);
  const body = await response.json();
  assert.equal(body.total, 5);
  assert.equal(body.nextOffset, 3);
  assert.deepEqual(
    body.files.map((file) => [file.path, file.state]),
    [
      ["old.js", "removed"],
      [null, "not-compared"],
    ],
  );
  assert.equal(body.files[0].artifactSha256, null);
  assert.equal(body.files[0].sourceSha256, null);
  assert.match(body.limitations.join(" "), /not.*release/i);
  assert.equal(s.calls(), 1);
});

test("inventory filters exact states and literal path prefixes", async (t) => {
  const s = await serve(t);
  for (const [state, path, comparisonState] of [
    ["changed", "src/change.js", "changed"],
    ["added", "new.js", "artifact-only"],
    ["removed", "old.js", "source-only"],
    ["identical", "same.js", "byte-identical"],
  ]) {
    const body = await (await s.get(`/files.json?state=${state}`)).json();
    assert.equal(body.total, 1);
    assert.equal(body.files[0].path, path);
    assert.equal(body.files[0].comparisonState, comparisonState);
  }
  const body = await (await s.get("/files.json?prefix=src%2F")).json();
  assert.equal(body.total, 1);
  assert.equal(body.files[0].artifactSha256, hash);
  assert.deepEqual(
    (await (await s.get("/files.json?offset=99")).json()).files,
    [],
  );
});

test("inventory rejects invalid pagination, ambiguous query keys and identity aliases", async (t) => {
  const s = await serve(t);
  for (const query of [
    "limit=0",
    "limit=101",
    "limit=1.5",
    "offset=-1",
    "offset=01",
    "offset=9007199254740992",
    "limit=2&limit=3",
    "state=clean",
    "unknown=x",
    "prefix=..%2F",
    "prefix=%FF",
    "prefix=%00",
    "prefix=%252e%252e%252f",
  ]) {
    const response = await s.get(`/files.json?${query}`);
    assert.equal(response.status, 400, query);
    assert.equal((await response.json()).error, "invalid-query");
  }
  assert.equal(
    (await fetch(`${s.origin}/r/${"f".repeat(32)}/files.json`)).status,
    404,
  );
  assert.equal(
    (await fetch(`${s.origin}/r/${s.path.slice(3).toUpperCase()}/files.json`))
      .status,
    404,
  );
});

test("inventory caps page count and serializes hostile paths as inert JSON", async (t) => {
  const report = fixture();
  report.files = Array.from({ length: 140 }, (_, i) => ({
    ...report.files[0],
    path: `${String(i).padStart(3, "0")}-<script>.js`,
    originalPath: `package/${i}.js`,
  }));
  report.coverage.sourceOnly = [];
  const s = await serve(t, report);
  const response = await s.get("/files.json?limit=100");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  const text = await response.text();
  assert.doesNotMatch(text, /<script>/);
  const body = JSON.parse(text);
  assert.equal(body.files.length, 100);
  assert.equal(body.nextOffset, 100);
  assert.equal(body.files[0].path, "000-<script>.js");
  assert.ok(Buffer.byteLength(text) <= 131072);
});

test("inventory reports pending and expired state without starting more analysis", async (t) => {
  let resolve;
  const pending = new Promise((done) => {
    resolve = done;
  });
  const s = await serve(t, fixture(), { runAnalysis: () => pending });
  const response = await s.get("/files.json");
  assert.equal(response.status, 202);
  assert.equal(response.headers.get("retry-after"), "3");
  assert.equal((await response.json()).error, "report-pending");
  resolve(fixture());
  let now = 0;
  const expired = await serve(t, fixture(), {
    clock: { now: () => now, setTimeout, clearTimeout },
    limits: { reportTtlMs: 10 },
  });
  now = 11;
  assert.equal((await expired.get("/files.json")).status, 404);
  assert.equal(expired.calls(), 1);
});

test("inventory byte cap preserves pagination across large escaped paths", async (t) => {
  const report = fixture();
  report.files = Array.from({ length: 100 }, (_, i) => ({
    ...report.files[0],
    path: `${i}-${"<".repeat(4000)}`,
    originalPath: `${i}-${">".repeat(4000)}`,
  }));
  report.coverage.sourceOnly = [];
  const s = await serve(t, report);
  const response = await s.get("/files.json?limit=100");
  const text = await response.text();
  assert.ok(Buffer.byteLength(text) <= 131072);
  const body = JSON.parse(text);
  assert.ok(body.files.length > 0 && body.files.length < 100);
  assert.equal(body.nextOffset, body.files.length);
  const next = await (
    await s.get(`/files.json?limit=100&offset=${body.nextOffset}`)
  ).json();
  assert.notEqual(next.files[0].path, body.files.at(-1).path);
});

test("inventory response budget includes the escaped filter prefix", async (t) => {
  const report = fixture();
  const prefix = "<".repeat(2500);
  report.files = Array.from({ length: 10 }, (_, i) => ({
    ...report.files[0],
    path: `${prefix}${"<".repeat(1500)}${i}`,
    originalPath: `${">".repeat(2500)}${i}`,
  }));
  report.coverage.sourceOnly = [];
  const s = await serve(t, report);
  const response = await s.get(
    `/files.json?limit=100&prefix=${encodeURIComponent(prefix)}`,
  );
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.ok(Buffer.byteLength(text) <= 131072);
  assert.ok(JSON.parse(text).nextOffset > 0);
});

function withEvidence() {
  const report = fixture();
  report.inputs.artifact = { sha256: "c".repeat(64) };
  report.inputs.sourceArchive = { sha256: "d".repeat(64) };
  for (const [index, side] of ["artifact", "source"].entries()) {
    const evidence = {
      id: `ev-${String(index + 1).repeat(64)}`,
      side,
      blobDigest: side === "artifact" ? "c".repeat(64) : "d".repeat(64),
      path: "src/change.js",
      originalPath:
        side === "artifact" ? "package/src/change.js" : "repo/src/change.js",
      fileSha256: side === "artifact" ? hash : "b".repeat(64),
      size: 8,
      range: [0, 8],
      excerpt: "<x>\nnew!",
      excerptRange: [0, 8],
    };
    report.evidence.push(evidence);
    report.files[0].evidenceIds.push(evidence.id);
  }
  return report;
}

test("drilldown returns only recorded evidence bound to the selected report file", async (t) => {
  const report = withEvidence();
  report.evidence.push({
    ...report.evidence[0],
    id: `ev-${"3".repeat(64)}`,
    path: "other.js",
    excerpt: "private!",
  });
  report.files[0].evidenceIds.push(report.evidence.at(-1).id);
  const s = await serve(t, report);
  const response = await s.get("/file.json?path=src%2Fchange.js");
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.doesNotMatch(text, /<x>|private!/);
  const body = JSON.parse(text);
  assert.equal(body.file.state, "changed");
  assert.equal(body.file.artifactSha256, hash);
  assert.equal(body.evidence.length, 2);
  assert.equal(body.invalidEvidenceOmitted, 1);
  assert.equal(body.evidenceStatus, "partial");
  assert.deepEqual(
    body.evidence.map((e) => e.side),
    ["artifact", "source"],
  );
  assert.equal(body.evidence[0].excerpt, "<x>\nnew!");
  assert.deepEqual(body.evidence[0].excerptRange, [0, 8]);
  assert.equal(body.evidence[0].blobDigest, "c".repeat(64));
  assert.equal(s.calls(), 1);
});

test("drilldown rejects traversal, encoded aliases, duplicate keys and nonexistent paths", async (t) => {
  const s = await serve(t, withEvidence());
  for (const query of [
    "",
    "path=",
    "path=..%2Fsecret",
    "path=%2Fetc%2Fpasswd",
    "path=C%3A%2Fx",
    "path=src%5Cchange.js",
    "path=src%2F.%2Fchange.js",
    "path=%252e%252e%252fsecret",
    "path=src%00x",
    "path=%FF",
    "path=%2",
    "path=src%2Fchange.js&path=same.js",
    "path=same.js&originalPath=package%2Fsame.js",
    "path=same.js&raw=true",
  ]) {
    assert.equal((await s.get(`/file.json?${query}`)).status, 400, query);
  }
  for (const query of [
    "path=absent.js",
    "path=package%2Fsrc%2Fchange.js",
    "originalPath=package%2Fsrc%2Fchange.js",
  ]) {
    const response = await s.get(`/file.json?${query}`);
    assert.equal(response.status, 404, query);
    assert.equal((await response.json()).error, "file-unavailable");
  }
  assert.equal(
    (await s.get("/file.json?originalPath=prefixless.js")).status,
    200,
  );
});

test("drilldown preserves missing evidence for identical, added and source-only files", async (t) => {
  const s = await serve(t, fixture());
  for (const [path, state] of [
    ["same.js", "identical"],
    ["new.js", "added"],
    ["old.js", "removed"],
  ]) {
    const response = await s.get(`/file.json?path=${path}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.file.state, state);
    assert.deepEqual(body.evidence, []);
    assert.equal(body.evidenceStatus, "unavailable");
    assert.match(
      body.limitations.join(" "),
      /not.*safety|not.*establish safety/,
    );
  }
});

test("drilldown bounds UTF8 excerpts, evidence count and total serialized bytes", async (t) => {
  const report = withEvidence();
  const text = "😀".repeat(1000) + "<script>";
  report.files[0].size = 4008;
  report.evidence = Array.from({ length: 50 }, (_, i) => ({
    ...report.evidence[0],
    id: `ev-${i.toString(16).padStart(64, "0")}`,
    size: 4008,
    range: [0, 4008],
    excerptRange: [0, 4008],
    excerpt: text,
  }));
  report.files[0].evidenceIds = report.evidence.map((item) => item.id);
  const s = await serve(t, report);
  const response = await s.get("/file.json?path=src%2Fchange.js");
  assert.equal(response.status, 200);
  const raw = await response.text();
  assert.ok(Buffer.byteLength(raw) <= 131072);
  const body = JSON.parse(raw);
  assert.equal(body.evidence.length, 32);
  assert.equal(body.evidenceOmitted, 18);
  assert.equal(body.evidence[0].excerptTruncated, true);
  assert.equal(body.evidence[0].excerpt, "😀".repeat(512));
  assert.deepEqual(body.evidence[0].excerptRange, [0, 2048]);
  assert.deepEqual(body.evidence[0].recordedExcerptRange, [0, 4008]);
});

test("drilldown omits mismatched hashes, input provenance and invalid excerpt ranges", async (t) => {
  const report = withEvidence();
  report.evidence[0].fileSha256 = "e".repeat(64);
  report.evidence[1].blobDigest = "f".repeat(64);
  const s = await serve(t, report);
  const body = await (await s.get("/file.json?path=src%2Fchange.js")).json();
  assert.deepEqual(body.evidence, []);
  assert.equal(body.invalidEvidenceOmitted, 2);
  const invalid = withEvidence();
  invalid.evidence[0].excerptRange = [0, 99];
  const other = await serve(t, invalid);
  const second = await (
    await other.get("/file.json?path=src%2Fchange.js")
  ).json();
  assert.equal(second.evidence[0].excerpt, null);
  assert.equal(second.evidence[0].excerptStatus, "invalid-recorded-range");
});

test("drilldown uses actual comparison evidence for encoded Unicode and prefixless identities", async (t) => {
  const sha = (text) => createHash("sha256").update(text).digest("hex");
  const entry = (path, text, originalPath) => ({
    path,
    originalPath,
    type: "file",
    size: Buffer.byteLength(text),
    sha256: sha(text),
    content: Buffer.from(text),
  });
  const artifact = {
    digest: { sha256: sha("artifact archive") },
    complete: true,
    failures: [],
    entries: [
      entry("space + café.js", "abc", "package/space + café.js"),
      entry(null, "hello", "prefixless.js"),
    ],
  };
  const source = {
    digest: { sha256: sha("source archive") },
    complete: true,
    failures: [],
    entries: [entry("space + café.js", "adc", "repo/space + café.js")],
  };
  const comparison = compareInventories(artifact, source);
  const report = {
    ...fixture(),
    ...comparison,
    inputs: {
      claim: { name: "example", version: "1.0.0" },
      artifact: artifact.digest,
      sourceArchive: source.digest,
    },
  };
  const s = await serve(t, report);
  const body = await (
    await s.get(`/file.json?path=${encodeURIComponent("space + café.js")}`)
  ).json();
  assert.deepEqual(
    body.evidence.map((item) => [item.side, item.range, item.excerpt]),
    [
      ["artifact", [1, 2], "b"],
      ["source", [1, 2], "d"],
    ],
  );
  const prefixless = await (
    await s.get("/file.json?originalPath=prefixless.js")
  ).json();
  assert.equal(prefixless.file.path, null);
  assert.equal(prefixless.evidence[0].excerpt, "hello");
});

test("drilldown byte budget includes long escaped file identities and evidence metadata", async (t) => {
  const report = withEvidence();
  report.files[0].originalPath = "<".repeat(4000);
  const original = report.evidence[0];
  report.evidence = Array.from({ length: 32 }, (_, i) => ({
    ...original,
    id: `ev-${i.toString(16).padStart(64, "0")}`,
    originalPath: "<".repeat(4000),
  }));
  report.files[0].evidenceIds = report.evidence.map((item) => item.id);
  const s = await serve(t, report);
  const response = await s.get("/file.json?path=src%2Fchange.js");
  const text = await response.text();
  assert.ok(Buffer.byteLength(text) <= 131072);
  const body = JSON.parse(text);
  assert.ok(body.evidence.length > 0 && body.evidence.length < 32);
  assert.equal(body.evidenceOmitted, 32 - body.evidence.length);
  assert.equal(body.evidenceStatus, "partial");
});

test("drilldown shares pending, expired and failed report lifecycle without analysis on GET", async (t) => {
  let resolve;
  const pending = new Promise((done) => {
    resolve = done;
  });
  const s = await serve(t, fixture(), { runAnalysis: () => pending });
  assert.equal((await s.get("/file.json?path=same.js")).status, 202);
  resolve(fixture());
  const failed = await serve(t, fixture(), {
    runAnalysis: async () => {
      throw new Error("internal path should stay private");
    },
  });
  const response = await failed.get("/file.json?path=same.js");
  assert.equal(response.status, 409);
  assert.doesNotMatch(await response.text(), /internal path/);
  let now = 0;
  const expired = await serve(t, fixture(), {
    clock: { now: () => now, setTimeout, clearTimeout },
    limits: { reportTtlMs: 10 },
  });
  now = 11;
  assert.equal((await expired.get("/file.json?path=same.js")).status, 404);
  assert.equal(expired.calls(), 1);
});

test("drilldown includes source-only recorded excerpts and additional same-file evidence", async (t) => {
  const report = withEvidence();
  report.evidence.push({
    ...report.evidence[1],
    id: `ev-${"4".repeat(64)}`,
    path: "old.js",
    originalPath: "repo/old.js",
  });
  report.evidence.push({
    ...report.evidence[0],
    id: `ev-${"5".repeat(64)}`,
    range: [0, 3],
    excerpt: "<x>",
    excerptRange: [0, 3],
  });
  const s = await serve(t, report);
  const old = await (await s.get("/file.json?path=old.js")).json();
  assert.equal(old.file.artifactSha256, null);
  assert.equal(old.file.sourceSha256, "b".repeat(64));
  assert.equal(old.evidence[0].side, "source");
  assert.equal(old.evidence[0].excerpt, "<x>\nnew!");
  const changed = await (await s.get("/file.json?path=src%2Fchange.js")).json();
  assert.equal(changed.evidence.length, 3);
});

test("drilldown withholds conflicting source-only hashes and duplicate evidence IDs", async (t) => {
  const report = withEvidence();
  const old = {
    ...report.evidence[1],
    id: `ev-${"6".repeat(64)}`,
    path: "old.js",
    originalPath: "repo/old.js",
  };
  report.evidence.push(old, {
    ...old,
    id: `ev-${"7".repeat(64)}`,
    fileSha256: "e".repeat(64),
  });
  report.evidence.push({ ...report.evidence[0] });
  const s = await serve(t, report);
  const removed = await (await s.get("/file.json?path=old.js")).json();
  assert.equal(removed.file.sourceSha256, null);
  assert.deepEqual(removed.evidence, []);
  assert.equal(removed.invalidEvidenceOmitted, 2);
  const changed = await (await s.get("/file.json?path=src%2Fchange.js")).json();
  assert.deepEqual(
    changed.evidence.map((item) => item.side),
    ["source"],
  );
  assert.equal(changed.invalidEvidenceOmitted, 1);
});
