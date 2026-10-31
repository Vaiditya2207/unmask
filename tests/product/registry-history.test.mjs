import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { createApp } from "../../src/server/app.mjs";

const metadata = (version, publisher = "alice", license = "MIT") => ({
  name: "example",
  version,
  _npmUser: { name: publisher },
  license,
  engines: { node: ">=20" },
  repository: { type: "git", url: "https://example.test/repo" },
  deprecated: "",
});
const history = {
  name: "example",
  time: {
    created: "2020-01-01T00:00:00.000Z",
    modified: "2026-10-31T00:00:00.000Z",
    "1.0.0": "2026-01-01T00:00:00.000Z",
    "1.1.0": "2026-02-01T00:00:00.000Z",
    "2.0.0": "2026-03-01T00:00:00.000Z",
  },
  versions: {
    "2.0.0": metadata("2.0.0", "bob", "Apache-2.0"),
    "1.0.0": metadata("1.0.0"),
    "1.1.0": metadata("1.1.0"),
  },
};
async function start(t, document = history, options = {}) {
  const app = createApp({
    versionInfo: {
      version: "test",
      commit: "a".repeat(40),
      tarballSha256: "b".repeat(64),
    },
    runAnalysis: async () => {
      assert.fail("no package check should run");
    },
    registryFacts: {
      fetchImpl: async (url) => {
        assert.equal(url, "https://registry.npmjs.org/example");
        return Response.json(document);
      },
      ...options,
    },
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
  const get = (query = "?package=example", init) =>
    fetch(
      `http://127.0.0.1:${app.address().port}/api/registry/history${query}`,
      init,
    );
  get.facts = () =>
    fetch(
      `http://127.0.0.1:${app.address().port}/api/registry/facts?package=example%401.0.0`,
    );
  return get;
}

test("history route orders by recorded publish time and compares the predecessor outside the page", async (t) => {
  const get = await start(t);
  const response = await get("?package=example&limit=1");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "recorded-history");
  assert.equal(body.timeline.length, 1);
  const newest = body.timeline[0];
  assert.equal(newest.version, "2.0.0");
  assert.equal(newest.releasedAt, "2026-03-01T00:00:00.000Z");
  assert.equal(newest.comparison.againstVersion, "1.1.0");
  assert.deepEqual(newest.comparison.publisher, {
    status: "changed",
    before: "alice",
    after: "bob",
  });
  assert.deepEqual(
    newest.comparison.metadataChanges.map((item) => item.field),
    ["license"],
  );
  assert.equal(newest.claims.publisher.pointer, "/versions/2.0.0/_npmUser");
  assert.equal(body.coverage.omitted, 2);
  assert.equal(body.scope.historicalEdits, "not-assessed-single-snapshot");
  assert.equal(body.scope.safetyVerdict, "not-provided");
});

test("unchanged snapshot fields do not turn into a safety claim", async (t) => {
  const get = await start(t);
  const body = await (await get()).json();
  const middle = body.timeline[1];
  assert.equal(middle.comparison.publisher.status, "unchanged");
  assert.deepEqual(middle.comparison.metadataChanges, []);
  assert.equal(
    body.timeline[2].comparison.status,
    "not-assessed-no-predecessor",
  );
  assert.match(body.scope.limitation, /not.*safety/i);
});

test("time-only removed versions remain visible and missing publishers cannot imply unchanged ownership", async (t) => {
  const fixture = structuredClone(history);
  delete fixture.versions["1.1.0"];
  delete fixture.versions["2.0.0"]._npmUser;
  const get = await start(t, fixture);
  const body = await (await get()).json();
  assert.equal(body.timeline[1].metadataStatus, "not-recorded");
  assert.equal(body.timeline[0].comparison.publisher.status, "not-assessed");
  assert.equal(body.timeline[0].comparison.status, "partial");
  assert.ok(body.timeline[0].comparison.unassessedFields.includes("license"));
});

test("malformed dates and undated releases remain counted while identity-mismatched metadata is not trusted", async (t) => {
  const fixture = structuredClone(history);
  fixture.time["1.0.0"] = "yesterday";
  fixture.versions["1.1.0"].name = "other";
  fixture.versions["3.0.0"] = metadata("3.0.0");
  fixture.time.bad = "2026-04-01T00:00:00.000Z";
  const get = await start(t, fixture);
  const body = await (await get()).json();
  assert.equal(body.coverage.undatedVersions, 2);
  assert.equal(body.coverage.invalidVersionKeys, 1);
  assert.equal(body.timeline[1].metadataStatus, "identity-mismatch");
  assert.equal(body.timeline[0].comparison.publisher.status, "not-assessed");
});

test("equal publish timestamps cannot establish a publisher transition", async (t) => {
  const fixture = structuredClone(history);
  fixture.time["2.0.0"] = fixture.time["1.1.0"];
  const get = await start(t, fixture);
  const body = await (await get()).json();
  assert.equal(
    body.timeline[0].comparison.status,
    "not-assessed-ambiguous-time",
  );
});

test("a packument without usable dates reports history unavailable rather than an empty clean result", async (t) => {
  const get = await start(t, {
    name: "example",
    versions: { "1.0.0": metadata("1.0.0") },
  });
  const body = await (await get()).json();
  assert.equal(body.status, "history-unavailable");
  assert.equal(body.coverage.undatedVersions, 1);
  assert.deepEqual(body.timeline, []);
});

test("history validates names, query keys, pagination bounds and methods before fetching", async (t) => {
  const get = await start(t, history, {
    fetchImpl: async () => {
      assert.fail("invalid request must not fetch");
    },
  });
  for (const query of [
    "",
    "?package=example@1.0.0",
    "?package=https://evil.test",
    "?package=example&limit=0",
    "?package=example&limit=101",
    "?package=example&limit=1.5",
    "?package=example&limit=1&limit=2",
    "?package=example&unknown=1",
  ]) {
    assert.equal((await get(query)).status, 400, query);
  }
  assert.equal((await get("?package=example", { method: "POST" })).status, 405);
});

test("history shares bounded fetch/admission with facts and rejects excessive record counts", async (t) => {
  const get = await start(t, history, { maxRequests: 1 });
  assert.equal((await get()).status, 200);
  assert.equal((await get.facts()).status, 429);
  assert.equal((await get()).status, 429);
  const huge = {
    name: "example",
    time: Object.fromEntries(
      Array.from({ length: 5001 }, (_, index) => [
        `1.0.${index}`,
        "2026-01-01T00:00:00.000Z",
      ]),
    ),
  };
  const capped = await start(t, huge);
  const response = await capped();
  assert.equal(response.status, 502);
  assert.equal((await response.json()).reason, "registry-history-cap");
});
