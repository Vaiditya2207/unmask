import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import {
  LockfileError,
  parseNpmLockfile,
} from "../../src/core/dependency-graph.mjs";
import { lookupNpmAdvisories } from "../../src/core/advisories.mjs";
import { screenDependencyGraph } from "../../src/server/dependency-screening.mjs";
import { createApp } from "../../src/server/app.mjs";

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
        return {
          status: "found",
          complete: true,
          reasons: [],
          advisories: [{ id: "GHSA-test", aliases: [], summary: "Malware" }],
        };
      if (spec === "b@1.0.0") throw new Error("network");
      return {
        status: "none-reported",
        complete: true,
        reasons: [],
        advisories: [],
      };
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
  assert.equal(result.complete, false);
  assert.equal(result.summary.notScreened, 1);
  const clean = await screenDependencyGraph(
    parseNpmLockfile(lockfile({ "node_modules/c": registry("c", "1.0.0") })),
    {
      lookup: async () => ({
        status: "none-reported",
        complete: true,
        reasons: [],
        advisories: [],
      }),
    },
  );
  assert.equal(clean.status, "none-reported");
  assert.equal(clean.complete, true);
  const rejectedOnly = await screenDependencyGraph(parseNpmLockfile(sample), {
    lookup: async () => ({
      status: "none-reported",
      complete: true,
      advisories: [],
    }),
  });
  assert.equal(rejectedOnly.status, "incomplete");
  assert.equal(rejectedOnly.summary.rejected, 7);
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
  assert.equal(result.complete, false);
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
  const post = await start(t, async () => ({
    status: "none-reported",
    complete: true,
    reasons: [],
    advisories: [],
  }));
  const body = JSON.stringify(
    lockfile({ "node_modules/c": registry("c", "1.0.0") }),
  );
  for (let i = 0; i < 6; i++) assert.equal((await post(body)).status, 200);
  const limited = await post(body);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
});
