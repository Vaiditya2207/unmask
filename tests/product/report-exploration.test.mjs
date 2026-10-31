import assert from "node:assert/strict";
import { once } from "node:events";
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
