import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { createApp } from "../../src/server/app.mjs";

const release = {
  name: "@scope/example",
  version: "1.2.3",
  maintainers: [{ name: "maintainer", email: "not-returned@example.test" }],
  _npmUser: { name: "publisher", email: "not-returned@example.test" },
  deprecated: "Use the maintained fork",
  license: "MIT",
  engines: { node: ">=20" },
  repository: {
    type: "git",
    url: "git+https://github.com/example/example.git",
  },
};
async function start(t, registryFacts = {}) {
  const server = createApp({
    versionInfo: {
      version: "test",
      commit: "a".repeat(40),
      tarballSha256: "b".repeat(64),
    },
    runAnalysis: async () => {
      throw new Error("Analysis must not run");
    },
    registryFacts,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return (path, options) =>
    fetch(`http://127.0.0.1:${server.address().port}${path}`, options);
}
const factsPath = "/api/registry/facts?package=%40scope%2Fexample%401.2.3";

test("registry facts are reachable and separate observed identity from unverified declarations", async (t) => {
  const get = await start(t, {
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://registry.npmjs.org/%40scope%2Fexample/1.2.3");
      assert.equal(options.redirect, "error");
      assert.equal(options.credentials, "omit");
      return Response.json(release);
    },
  });
  const response = await get(factsPath);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.identity, { name: "@scope/example", version: "1.2.3" });
  assert.equal(
    body.verifiedObservations.documentIdentity,
    "matches-exact-request",
  );
  assert.equal(
    body.source.url,
    "https://registry.npmjs.org/%40scope%2Fexample/1.2.3",
  );
  assert.match(body.source.retrievedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(body.source.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(body.unverifiedClaims.maintainers.value, [
    { name: "maintainer" },
  ]);
  assert.equal(body.unverifiedClaims.publisher.value.name, "publisher");
  assert.equal(
    body.unverifiedClaims.deprecated.value,
    "Use the maintained fork",
  );
  assert.equal(body.unverifiedClaims.license.value, "MIT");
  assert.deepEqual(body.unverifiedClaims.engines.value, { node: ">=20" });
  assert.equal(body.unverifiedClaims.repository.pointer, "/repository");
  assert.equal(body.scope.safetyVerdict, "not-provided");
  assert.equal(body.scope.modelAssessment, "not-performed-metadata-only");
  assert.doesNotMatch(JSON.stringify(body), /not-returned/);
});

test("missing, malformed and oversized claims remain explicit rather than becoming verified or absent", async (t) => {
  const get = await start(t, {
    fetchImpl: async () =>
      Response.json({
        name: release.name,
        version: release.version,
        license: 42,
        deprecated: "x".repeat(9000),
        engines: { node: 20 },
      }),
  });
  const body = await (await get(factsPath)).json();
  assert.equal(body.unverifiedClaims.maintainers.status, "not-recorded");
  assert.equal(body.unverifiedClaims.license.status, "invalid-type");
  assert.equal(body.unverifiedClaims.engines.status, "invalid-type");
  assert.equal(body.unverifiedClaims.deprecated.status, "omitted-limit");
  assert.ok(!Object.hasOwn(body.unverifiedClaims.deprecated, "value"));
});

test("rejects ambiguous identities and methods before any registry request", async (t) => {
  const get = await start(t, {
    fetchImpl: async () => {
      assert.fail("must not fetch");
    },
  });
  for (const query of [
    "",
    "?package=example@latest",
    "?package=example@1.0.0&package=other@1.0.0",
    "?package=example@1.0.0&url=https://evil.test",
    "?package=../example@1.0.0",
    "?package=example@9007199254740992.0.0",
  ]) {
    assert.equal((await get("/api/registry/facts" + query)).status, 400, query);
  }
  assert.equal((await get(factsPath, { method: "POST" })).status, 405);
});

test("refuses registry identity substitution, redirects and invalid JSON without leaking errors", async (t) => {
  for (const fetchImpl of [
    async () => Response.json({ ...release, name: "other" }),
    async () =>
      new Response("{}", {
        status: 302,
        headers: { location: "https://evil.test" },
      }),
    async () => new Response("not json"),
    async () => {
      throw new Error("private-transport-detail");
    },
  ]) {
    const get = await start(t, { fetchImpl });
    const response = await get(factsPath);
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.status, "unavailable");
    assert.doesNotMatch(JSON.stringify(body), /private-transport-detail/);
  }
});

test("bounds registry bytes and wall time even if a transport ignores abort", async (t) => {
  const huge = await start(t, {
    maxBytes: 100,
    fetchImpl: async () => new Response("x".repeat(101)),
  });
  assert.equal((await huge(factsPath)).status, 502);
  const hang = await start(t, {
    timeoutMs: 20,
    fetchImpl: () => new Promise(() => {}),
  });
  const response = await hang(factsPath);
  assert.equal(response.status, 504);
  assert.equal((await response.json()).reason, "acquisition-timeout");
});

test("caps global concurrent lookups and lookup admissions", async (t) => {
  let finish;
  const get = await start(t, {
    maxConcurrent: 1,
    maxRequests: 2,
    fetchImpl: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const first = get(factsPath);
  for (let i = 0; !finish && i < 100; i++)
    await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(
    typeof finish,
    "function",
    "lookup must reach registry transport",
  );
  const busy = await get(factsPath);
  assert.equal(busy.status, 429);
  finish(Response.json(release));
  assert.equal((await first).status, 200);
  const second = get(factsPath);
  const previous = finish;
  for (let i = 0; finish === previous && i < 100; i++)
    await new Promise((resolve) => setTimeout(resolve, 1));
  assert.notEqual(finish, previous, "second lookup reaches transport");
  finish(Response.json(release));
  assert.equal((await second).status, 200);
  assert.equal((await get(factsPath)).status, 429);
});

test("valid maintainer lists over the item cap report omission rather than invalid type", async (t) => {
  const get = await start(t, {
    fetchImpl: async () =>
      Response.json({
        ...release,
        maintainers: Array.from({ length: 101 }, () => ({ name: "member" })),
      }),
  });
  const body = await (await get(factsPath)).json();
  assert.equal(body.unverifiedClaims.maintainers.status, "omitted-limit");
});
