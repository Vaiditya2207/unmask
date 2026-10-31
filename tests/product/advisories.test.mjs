import assert from "node:assert/strict";
import { test } from "node:test";
import { lookupNpmAdvisories } from "../../src/core/advisories.mjs";

const endpoint = "https://api.osv.dev/v1/query";
const clock = {
  now: () => Date.parse("2026-11-01T00:00:00Z"),
  setTimeout,
  clearTimeout,
};
const record = (id = "GHSA-synthetic-0001") => ({
  id,
  summary: "Synthetic advisory",
  aliases: ["CVE-2099-0001"],
  modified: "2026-10-30T12:00:00Z",
  published: "2026-01-01T00:00:00Z",
  severity: [
    { type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" },
  ],
  database_specific: { severity: "HIGH" },
  references: [{ type: "ADVISORY", url: "https://example.invalid/advisory" }],
  affected: [
    {
      package: { name: "fixture", ecosystem: "npm" },
      ranges: [
        { type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.0.1" }] },
      ],
      versions: ["1.0.0"],
    },
  ],
});
function scripted(responses) {
  const requests = [];
  return {
    requests,
    fetchImpl: async (url, options) => {
      requests.push({ url, ...options, body: JSON.parse(options.body) });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      if (next instanceof Response) return next;
      assert.notEqual(next, undefined, "Unexpected extra OSV request");
      return Response.json(next);
    },
  };
}
const lookup = (responses, options = {}) =>
  lookupNpmAdvisories("fixture@1.0.0", {
    clock,
    ...scripted(responses),
    ...options,
  });
test("exact npm query returns bounded OSV declarations without a runtime or policy verdict", async () => {
  const f = scripted([{ vulns: [record()] }]);
  const result = await lookupNpmAdvisories("@scope/fixture@1.0.0-beta.1", {
    clock,
    ...f,
  });
  assert.equal(result.schemaVersion, "1");
  assert.equal(result.source, "OSV");
  assert.deepEqual(result.package, {
    name: "@scope/fixture",
    version: "1.0.0-beta.1",
    ecosystem: "npm",
  });
  assert.equal(result.queriedAt, "2026-11-01T00:00:00.000Z");
  assert.equal(result.status, "found");
  assert.equal(result.complete, true);
  assert.deepEqual(result.reasons, []);
  assert.equal(result.advisories[0].id, "GHSA-synthetic-0001");
  assert.deepEqual(result.advisories[0].severity, record().severity);
  assert.equal(result.advisories[0].severitySource, "OSV-declaration");
  assert.equal(result.advisories[0].databaseSeverity, "HIGH");
  assert.deepEqual(result.advisories[0].affected[0].ranges[0].events, [
    { introduced: "0" },
    { fixed: "1.0.1" },
  ]);
  assert.deepEqual(result.advisories[0].references, record().references);
  assert.equal(Object.hasOwn(result, "policy"), false);
  assert.equal(Object.hasOwn(result.advisories[0], "cvssScore"), false);
  assert.equal(f.requests.length, 1);
  const req = f.requests[0];
  assert.equal(req.url, endpoint);
  assert.equal(req.method, "POST");
  assert.equal(req.redirect, "manual");
  assert.equal(req.credentials, "omit");
  assert.deepEqual(req.body, {
    package: { name: "@scope/fixture", ecosystem: "npm" },
    version: "1.0.0-beta.1",
  });
  assert.deepEqual(req.headers, {
    "content-type": "application/json",
    accept: "application/json",
  });
});
for (const value of [{}, { vulns: [] }])
  test("successful empty response is explicitly none-reported, never safe", async () => {
    const r = await lookup([value]);
    assert.equal(r.status, "none-reported");
    assert.equal(r.complete, true);
    assert.equal(r.advisories.length, 0);
  });
test("token-only pages continue and IDs are deduplicated across bounded pages", async () => {
  const f = scripted([
    { next_page_token: "opaque-1" },
    { vulns: [record(), record()], next_page_token: "opaque-2" },
    { vulns: [record("GHSA-synthetic-0002"), record()] },
  ]);
  const r = await lookupNpmAdvisories("fixture@1.0.0", { clock, ...f });
  assert.equal(r.status, "found");
  assert.equal(r.pagesFetched, 3);
  assert.equal(r.advisories.length, 2);
  assert.deepEqual(
    f.requests.map((x) => x.body.page_token),
    [undefined, "opaque-1", "opaque-2"],
  );
  assert.equal(JSON.stringify(r).includes("opaque"), false);
});
for (const spec of [
  "fixture@latest",
  "fixture@^1.0.0",
  "https://example.invalid/x",
  "fixture",
  null,
  "SYNTHETIC_SECRET",
]) {
  test(
    "invalid input cannot make a request or echo it: " + String(spec),
    async () => {
      const r = await lookupNpmAdvisories(spec, {
        clock,
        fetchImpl: () => assert.fail("Invalid input fetched"),
      });
      assert.equal(r.status, "unavailable");
      assert.deepEqual(r.reasons, ["invalid-package-spec"]);
      assert.equal(r.package, null);
      assert.equal(JSON.stringify(r).includes("SYNTHETIC_SECRET"), false);
    },
  );
}
for (const response of [
  new Response("SYNTHETIC_SECRET", { status: 429 }),
  new Response("SYNTHETIC_SECRET", { status: 503 }),
  new Response(null, {
    status: 302,
    headers: { location: "https://evil.invalid/secret" },
  }),
  new Response("bad-json", { headers: { "content-type": "application/json" } }),
  Response.json({ error: { message: "SYNTHETIC_SECRET" } }),
  Response.json({ vulns: null }),
]) {
  test("failed or malformed response never becomes none-reported", async () => {
    const r = await lookup([response]);
    assert.equal(r.status, "unavailable");
    assert.equal(r.complete, false);
    assert.ok(r.reasons.length);
    assert.doesNotMatch(JSON.stringify(r), /SYNTHETIC_SECRET|evil.invalid/);
  });
}
test("later page failure preserves prior records as incomplete", async () => {
  const r = await lookup([
    { vulns: [record()], next_page_token: "next" },
    new Error("SYNTHETIC_SECRET token=secret"),
  ]);
  assert.equal(r.status, "incomplete");
  assert.equal(r.advisories.length, 1);
  assert.equal(r.complete, false);
  assert.deepEqual(r.reasons, ["request-failed"]);
  assert.doesNotMatch(JSON.stringify(r), /SYNTHETIC_SECRET|token=/);
});
for (const type of ["declared", "streamed"]) {
  test("response bytes are bounded: " + type, async () => {
    const headers = {
      "content-type": "application/json",
      ...(type === "declared" ? { "content-length": "1048577" } : {}),
    };
    const response = new Response('"' + "x".repeat(1048576) + '"', { headers });
    const r = await lookup([response]);
    assert.equal(r.status, "unavailable");
    assert.deepEqual(r.reasons, ["response-limit"]);
  });
}
test("three-page cap includes token-only pages and discloses unfinished results", async () => {
  const f = scripted([
    { next_page_token: "1" },
    { next_page_token: "2" },
    { next_page_token: "3" },
  ]);
  const r = await lookupNpmAdvisories("fixture@1.0.0", { clock, ...f });
  assert.equal(f.requests.length, 3);
  assert.equal(r.status, "incomplete");
  assert.equal(r.complete, false);
  assert.deepEqual(r.reasons, ["page-limit"]);
});
test("repeated pagination token stops rather than spending more requests", async () => {
  const f = scripted([
    { vulns: [record()], next_page_token: "same" },
    { next_page_token: "same" },
  ]);
  const r = await lookupNpmAdvisories("fixture@1.0.0", { clock, ...f });
  assert.equal(f.requests.length, 2);
  assert.equal(r.status, "incomplete");
  assert.deepEqual(r.reasons, ["pagination-loop"]);
});
test("advisory cap preserves one hundred records and never labels truncation complete", async () => {
  const r = await lookup([
    { vulns: Array.from({ length: 101 }, (_, i) => record(`TEST-${i}`)) },
  ]);
  assert.equal(r.advisories.length, 100);
  assert.equal(r.status, "incomplete");
  assert.deepEqual(r.reasons, ["advisory-limit"]);
});
test("record fields and HTTPS references stay bounded and invalid items are visible", async () => {
  const data = record();
  data.summary = "x".repeat(3000);
  data.aliases = Array.from({ length: 25 }, (_, i) => `CVE-2099-${i}`);
  data.references.push(
    { type: "WEB", url: "http://insecure.invalid" },
    { type: "WEB", url: "https://user:secret@example.invalid" },
  );
  const r = await lookup([{ vulns: [data, { summary: "missing ID" }] }]);
  assert.equal(r.status, "incomplete");
  assert.equal(r.advisories.length, 1);
  assert.ok(Buffer.byteLength(r.advisories[0].summary) <= 2048);
  assert.ok(r.advisories[0].aliases.length <= 16);
  assert.deepEqual(r.advisories[0].references, record().references);
  assert.ok(r.reasons.includes("record-limit"));
  assert.ok(r.reasons.includes("invalid-record"));
  assert.doesNotMatch(JSON.stringify(r), /user:secret|insecure.invalid/);
});
function controlledClock() {
  let callback;
  return {
    now: () => Date.parse("2026-11-01T00:00:00Z"),
    setTimeout(fn) {
      callback = fn;
      return 1;
    },
    clearTimeout() {},
    expire() {
      callback();
    },
  };
}
test("deadline settles even an injected fetch that ignores abort", async () => {
  const c = controlledClock();
  let requestSignal;
  const promise = lookupNpmAdvisories("fixture@1.0.0", {
    clock: c,
    fetchImpl: (_url, options) => {
      requestSignal = options.signal;
      return new Promise(() => {});
    },
  });
  c.expire();
  const r = await promise;
  assert.equal(r.status, "unavailable");
  assert.deepEqual(r.reasons, ["timeout"]);
  assert.equal(requestSignal.aborted, true);
});
test("deadline bounds stalled response body and preserves earlier pages", async () => {
  const c = controlledClock();
  let cancel = false;
  const f = scripted([{ vulns: [record()], next_page_token: "2" }]);
  let requests = 0;
  const promise = lookupNpmAdvisories("fixture@1.0.0", {
    clock: c,
    fetchImpl: async (...args) => {
      requests++;
      if (requests === 1) return f.fetchImpl(...args);
      return new Response(
        new ReadableStream({
          start() {
            queueMicrotask(() => c.expire());
          },
          cancel() {
            cancel = true;
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  const r = await promise;
  assert.equal(r.status, "incomplete");
  assert.equal(r.advisories.length, 1);
  assert.deepEqual(r.reasons, ["timeout"]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancel, true);
});
test("pre-aborted signal avoids any fetch", async () => {
  const controller = new AbortController();
  controller.abort("SYNTHETIC_SECRET");
  const r = await lookupNpmAdvisories("fixture@1.0.0", {
    clock,
    signal: controller.signal,
    fetchImpl: () => assert.fail("Aborted input fetched"),
  });
  assert.equal(r.status, "unavailable");
  assert.deepEqual(r.reasons, ["aborted"]);
  assert.doesNotMatch(JSON.stringify(r), /SYNTHETIC_SECRET/);
});
test("external abort cancels in-flight lookup without disclosing its reason", async () => {
  const controller = new AbortController();
  const promise = lookupNpmAdvisories("fixture@1.0.0", {
    clock,
    signal: controller.signal,
    fetchImpl: () => new Promise(() => {}),
  });
  controller.abort(new Error("SYNTHETIC_SECRET"));
  const r = await promise;
  assert.equal(r.status, "unavailable");
  assert.deepEqual(r.reasons, ["aborted"]);
  assert.doesNotMatch(JSON.stringify(r), /SYNTHETIC_SECRET/);
});

test("oversized severity vectors and version identifiers are omitted rather than rewritten", async () => {
  const data = record();
  data.severity[0].score = "CVSS:3.1/" + "X".repeat(600);
  data.affected[0].versions = ["1.0.0", "x".repeat(300)];
  data.affected[0].ranges[0].events.push({ fixed: "y".repeat(300) });
  const result = await lookup([{ vulns: [data] }]);
  assert.equal(result.status, "incomplete");
  assert.deepEqual(result.reasons, ["record-limit"]);
  assert.deepEqual(result.advisories[0].severity, []);
  assert.deepEqual(result.advisories[0].affected[0].versions, ["1.0.0"]);
  assert.deepEqual(result.advisories[0].affected[0].ranges[0].events, [
    { introduced: "0" },
    { fixed: "1.0.1" },
  ]);
  assert.equal(result.advisories[0].truncated, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test("transport bounds cannot be expanded by caller overrides", async () => {
  const result = await lookupNpmAdvisories("fixture@1.0.0", {
    clock,
    limits: { pages: 4 },
    fetchImpl: () => assert.fail("Invalid limits fetched"),
  });
  assert.equal(result.status, "unavailable");
  assert.deepEqual(result.reasons, ["invalid-limits"]);
});
