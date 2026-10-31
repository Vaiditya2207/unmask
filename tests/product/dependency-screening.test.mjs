import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import {
  LockfileError,
  parseNpmLockfile,
} from "../../src/core/dependency-graph.mjs";
import { lookupNpmAdvisories } from "../../src/core/advisories.mjs";
import {
  createDependencyScreening,
  screenDependencyGraph,
} from "../../src/server/dependency-screening.mjs";
import { createApp } from "../../src/server/app.mjs";
import { createServer, request } from "node:http";

const tgz = (name, version) =>
  `https://registry.npmjs.org/${name}/-/${name.split("/").at(-1)}-${version}.tgz`;
const registry = (name, version, extra = {}) => ({
  version,
  resolved: tgz(name, version),
  integrity: "sha512-AAAA",
  ...extra,
});
const lockfile = (packages, lockfileVersion = 3) => ({
  name: "app",
  version: "1.0.0",
  lockfileVersion,
  requires: true,
  packages: {
    "": {
      name: "app",
      version: "1.0.0",
      dependencies: { "ua-parser-js": "0.7.29", left: "1.0.0" },
    },
    ...packages,
  },
});
const bound = (spec, fields) => {
  const at = spec.lastIndexOf("@");
  return {
    package: { name: spec.slice(0, at), version: spec.slice(at + 1) },
    reasons: [],
    advisories: [],
    ...fields,
  };
};
const clean = (spec) =>
  bound(spec, { status: "none-reported", complete: true });
const sample = lockfile({
  "node_modules/ua-parser-js": registry("ua-parser-js", "0.7.29"),
  "node_modules/left": registry("left", "1.0.0", {
    dependencies: { "@scope/mid": "2.0.0" },
  }),
  "node_modules/@scope/mid": registry("@scope/mid", "2.0.0", { dev: true }),
  "node_modules/left/node_modules/ua-parser-js": registry(
    "ua-parser-js",
    "0.7.29",
  ),
  "node_modules/gitdep": {
    version: "1.0.0",
    resolved: "git+ssh://git@github.com/x/gitdep.git#abc",
  },
  "node_modules/tarball": {
    version: "1.0.0",
    resolved: "https://evil.example/tarball-1.0.0.tgz",
  },
  "node_modules/aliased": {
    name: "other",
    version: "1.0.0",
    resolved: tgz("other", "1.0.0"),
  },
  "node_modules/bundled": { version: "1.0.0", inBundle: true },
  "node_modules/unresolved": { version: "1.0.0" },
  "node_modules/mismatch": {
    version: "1.0.0",
    resolved: tgz("mismatch", "9.9.9"),
  },
  "node_modules/ranged": {
    version: "^1.0.0",
    resolved: tgz("ranged", "1.0.0"),
  },
  "node_modules/ws": { resolved: "packages/ws", link: true },
  "packages/ws": { name: "ws", version: "0.0.1" },
  "packages/ws/node_modules/nested": registry("nested", "3.0.0"),
});

test("parses lock v2/v3 registry identities and rejects ambiguous or non-registry claims", () => {
  const graph = parseNpmLockfile(JSON.stringify(sample));
  assert.equal(graph.lockfileVersion, 3);
  assert.deepEqual(
    graph.identities.map((item) => [item.spec, item.locationCount, item.dev]),
    [
      ["@scope/mid@2.0.0", 1, true],
      ["left@1.0.0", 1, false],
      ["nested@3.0.0", 1, false],
      ["ua-parser-js@0.7.29", 2, false],
    ],
  );
  assert.deepEqual(
    Object.fromEntries(
      graph.rejected.map((item) => [item.location, item.reason]),
    ),
    {
      "node_modules/gitdep": "non-registry-resolved",
      "node_modules/tarball": "non-registry-resolved",
      "node_modules/aliased": "alias-identity",
      "node_modules/bundled": "bundled-dependency",
      "node_modules/unresolved": "missing-resolved",
      "node_modules/mismatch": "resolved-identity-mismatch",
      "node_modules/ranged": "non-exact-version",
    },
  );
  assert.deepEqual(
    graph.local.map((item) => item.reason),
    ["linked-local", "workspace-package"],
  );
  assert.equal(parseNpmLockfile(lockfile({}, 2)).lockfileVersion, 2);
  for (const [input, reason] of [
    ["{", "invalid-json"],
    [{ lockfileVersion: 1, dependencies: {} }, "unsupported-lockfile-version"],
    [{ lockfileVersion: 3 }, "missing-packages"],
  ])
    assert.throws(
      () => parseNpmLockfile(input),
      (error) => error instanceof LockfileError && error.reason === reason,
    );
  assert.throws(
    () => parseNpmLockfile(sample, { limits: { entries: 3 } }),
    /entry-limit/,
  );
});

test("screening is bounded and never reports unscreened work as complete", async () => {
  const graph = parseNpmLockfile(
    lockfile({
      "node_modules/a": registry("a", "1.0.0"),
      "node_modules/b": registry("b", "1.0.0"),
      "node_modules/c": registry("c", "1.0.0"),
      "node_modules/d": registry("d", "1.0.0"),
    }),
  );
  const seen = [];
  const result = await screenDependencyGraph(graph, {
    limits: { identities: 3, concurrency: 2 },
    lookup: async (spec) => {
      seen.push(spec);
      if (spec === "a@1.0.0")
        return bound(spec, {
          status: "found",
          complete: true,
          advisories: [{ id: "GHSA-test", aliases: [], summary: "Malware" }],
        });
      if (spec === "b@1.0.0") throw new Error("network");
      return clean(spec);
    },
  });
  assert.deepEqual(seen.sort(), ["a@1.0.0", "b@1.0.0", "c@1.0.0"]);
  assert.deepEqual(
    result.dependencies.map((item) => [item.spec, item.status, item.reasons]),
    [
      ["a@1.0.0", "found", []],
      ["b@1.0.0", "unavailable", ["lookup-failed"]],
      ["c@1.0.0", "none-reported", []],
      ["d@1.0.0", "not-screened", ["identity-limit"]],
    ],
  );
  assert.equal(result.status, "advisories-found");
  assert.equal(result.coverage.registryComplete, false);
  assert.equal(result.summary.notScreened, 1);
  const passed = await screenDependencyGraph(
    parseNpmLockfile(lockfile({ "node_modules/c": registry("c", "1.0.0") })),
    { lookup: async (spec) => clean(spec) },
  );
  assert.equal(passed.status, "none-reported");
  assert.deepEqual(passed.coverage, {
    scope: "exact-registry-identities",
    registryComplete: true,
    projectScreened: false,
  });
  assert.equal(passed.root.status, "not-screened");
  const rejectedOnly = await screenDependencyGraph(parseNpmLockfile(sample), {
    lookup: async (spec) => clean(spec),
  });
  assert.ok(rejectedOnly.local.every((item) => item.status === "not-screened"));
  assert.ok(rejectedOnly.rejected.every((item) => item.status === "rejected"));
  assert.equal(rejectedOnly.status, "incomplete");
  assert.equal(rejectedOnly.summary.rejected, 7);
});

test("screening rejects unbound or inconsistent lookups and bounds hung lookups by deadline", async () => {
  const graph = parseNpmLockfile(
    lockfile({
      "node_modules/a": registry("a", "1.0.0"),
      "node_modules/b": registry("b", "1.0.0"),
      "node_modules/c": registry("c", "1.0.0"),
      "node_modules/d": registry("d", "1.0.0"),
      "node_modules/e": registry("e", "1.0.0"),
    }),
  );
  const answers = {
    "a@1.0.0": clean("other@1.0.0"),
    "b@1.0.0": bound("b@1.0.0", {
      status: "none-reported",
      complete: true,
      advisories: [{ id: "GHSA-hidden" }],
    }),
    "c@1.0.0": bound("c@1.0.0", { status: "none-reported", complete: false }),
    "d@1.0.0": bound("d@1.0.0", { status: "found", complete: true }),
  };
  const started = Date.now();
  const result = await screenDependencyGraph(graph, {
    limits: { deadlineMs: 100, concurrency: 5 },
    lookup: (spec) =>
      spec === "e@1.0.0" ? new Promise(() => {}) : answers[spec],
  });
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(
    result.dependencies.map((item) => [item.spec, item.status, item.reasons]),
    [
      ["a@1.0.0", "unavailable", ["identity-mismatch"]],
      ["b@1.0.0", "incomplete", ["inconsistent-lookup-result"]],
      ["c@1.0.0", "unavailable", ["inconsistent-lookup-result"]],
      ["d@1.0.0", "unavailable", ["inconsistent-lookup-result"]],
      ["e@1.0.0", "unavailable", ["time-limit"]],
    ],
  );
  assert.equal(result.dependencies[1].advisories[0].id, "GHSA-hidden");
  assert.equal(result.status, "advisories-found");
  assert.equal(result.coverage.registryComplete, false);
  const caller = new AbortController();
  caller.abort();
  const aborted = await screenDependencyGraph(graph, {
    signal: caller.signal,
    lookup: () => assert.fail("lookup must not start after abort"),
  });
  assert.ok(
    aborted.dependencies.every(
      (item) => item.status === "not-screened" && item.reasons[0] === "aborted",
    ),
  );
});

test("identities expose stable integrity binding metadata", () => {
  const graph = parseNpmLockfile(
    lockfile({
      "node_modules/a": registry("a", "1.0.0"),
      "node_modules/x/node_modules/a": registry("a", "1.0.0", {
        integrity: "sha512-BBBB",
      }),
      "node_modules/b": registry("b", "1.0.0", { integrity: undefined }),
      "node_modules/c": registry("c", "1.0.0"),
    }),
  );
  assert.deepEqual(
    graph.identities.map((item) => [
      item.spec,
      item.integrityStatus,
      item.integrity,
    ]),
    [
      ["a@1.0.0", "conflicting", null],
      ["b@1.0.0", "missing", null],
      ["c@1.0.0", "consistent", "sha512-AAAA"],
    ],
  );
});

const versionInfo = {
  version: "0.0.0",
  commit: "a".repeat(40),
  tarballSha256: "b".repeat(64),
};
async function start(t, advisoryLookup) {
  const app = createApp({
    versionInfo,
    runAnalysis: async () => {
      throw new Error("analysis must not run");
    },
    advisoryLookup,
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
  const url = `http://127.0.0.1:${app.address().port}/api/dependency-screening`;
  return (body, headers = { "content-type": "application/json" }) =>
    fetch(url, { method: "POST", headers, body });
}

test("dependency screening API screens a submitted lockfile over local HTTP with real OSV parsing", async (t) => {
  const queried = [];
  const fakeOsv = async (_url, init) => {
    const { package: pkg, version } = JSON.parse(init.body);
    queried.push(`${pkg.name}@${version}`);
    const vulns =
      pkg.name === "ua-parser-js"
        ? [
            {
              id: "GHSA-pjwm-rvh2-c87w",
              summary: "Embedded malware in ua-parser-js",
            },
          ]
        : [];
    return new Response(JSON.stringify(vulns.length ? { vulns } : {}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const post = await start(t, (spec, options) =>
    lookupNpmAdvisories(spec, { ...options, fetchImpl: fakeOsv }),
  );
  const response = await post(JSON.stringify(sample));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(queried.sort(), [
    "@scope/mid@2.0.0",
    "left@1.0.0",
    "nested@3.0.0",
    "ua-parser-js@0.7.29",
  ]);
  assert.equal(result.status, "advisories-found");
  assert.equal(result.coverage.registryComplete, false);
  const flagged = result.dependencies.find(
    (item) => item.name === "ua-parser-js",
  );
  assert.equal(flagged.status, "found");
  assert.equal(flagged.advisories[0].id, "GHSA-pjwm-rvh2-c87w");
  assert.deepEqual(flagged.locations, [
    "node_modules/ua-parser-js",
    "node_modules/left/node_modules/ua-parser-js",
  ]);
  assert.equal(result.summary.rejected, 7);
  assert.match(result.statement, /not a safety verdict/);

  assert.equal(
    (await post("{}", { "content-type": "text/plain" })).status,
    415,
  );
  const invalid = await post(JSON.stringify({ lockfileVersion: 1 }));
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), {
    error: "invalid-lockfile",
    reason: "unsupported-lockfile-version",
  });
  assert.equal(
    (
      await post("{}", {
        "content-type": "application/json",
        "sec-fetch-site": "cross-site",
      })
    ).status,
    403,
  );
  assert.equal((await post("x".repeat(2 * 1024 * 1024 + 1))).status, 413);
});

test("dependency screening API is unavailable without a lookup and admission-limited", async (t) => {
  const missing = await start(t);
  const response = await missing(JSON.stringify(sample));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "advisory-lookup-unavailable",
  });
  const post = await start(t, async (spec) => clean(spec));
  const body = JSON.stringify(
    lockfile({ "node_modules/c": registry("c", "1.0.0") }),
  );
  for (let i = 0; i < 6; i++) assert.equal((await post(body)).status, 200);
  const limited = await post(body);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
});

test("advisories from partial lookups stay counted and malformed artifact keys are rejected", async () => {
  let page = 0;
  const partialOsv = async () =>
    ++page === 1
      ? new Response(
          JSON.stringify({
            vulns: [{ id: "GHSA-pjwm-rvh2-c87w", summary: "Embedded malware" }],
            next_page_token: "next",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      : new Response("{}", { status: 500 });
  const graph = parseNpmLockfile(
    lockfile({
      "node_modules/ua-parser-js": registry("ua-parser-js", "0.7.29"),
      "node_modules/left-pad/evil": registry("left-pad", "1.3.0"),
      "vendor/evil": registry("evil", "1.0.0"),
      "packages/ws": { name: "ws", version: "0.0.1" },
    }),
  );
  assert.deepEqual(
    graph.rejected.map((item) => [item.location, item.reason]),
    [
      ["node_modules/left-pad/evil", "invalid-location"],
      ["vendor/evil", "invalid-location"],
    ],
  );
  assert.deepEqual(graph.local, [
    { location: "packages/ws", reason: "workspace-package" },
  ]);
  const result = await screenDependencyGraph(graph, {
    lookup: (spec, options) =>
      lookupNpmAdvisories(spec, { ...options, fetchImpl: partialOsv }),
  });
  assert.equal(result.dependencies[0].status, "incomplete");
  assert.equal(result.status, "advisories-found");
  assert.equal(result.summary.found, 0);
  assert.equal(result.summary.advisoryBearing, 1);
  assert.deepEqual(result.advisoryBearing, ["ua-parser-js@0.7.29"]);
  assert.equal(result.coverage.registryComplete, false);
});

test("slow bodies never hold the screening slot and every attempt is bounded", async (t) => {
  const handle = createDependencyScreening({
    lookup: async (spec) => clean(spec),
    limits: { attempts: 4, readers: 2, bodyTimeoutMs: 5000 },
  });
  const server = createServer((req, res) =>
    handle(req, res, (status, value, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(value));
    }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const url = `http://127.0.0.1:${server.address().port}/`;
  const post = (body) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  const pause = () => new Promise((resolve) => setTimeout(resolve, 50));
  const trickle = () => {
    const slow = request(url, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "100" },
    });
    slow.on("error", () => {});
    slow.write("{");
    return slow;
  };
  const body = JSON.stringify(
    lockfile({ "node_modules/c": registry("c", "1.0.0") }),
  );
  const first = trickle();
  await pause();
  assert.equal((await post(body)).status, 200);
  const second = trickle();
  await pause();
  assert.equal((await post(body)).status, 429);
  first.destroy();
  second.destroy();
  await pause();
  assert.equal((await post(body)).status, 200);
  const exhausted = await post(body);
  assert.equal(exhausted.status, 429);
  assert.ok(Number(exhausted.headers.get("retry-after")) > 0);
});
