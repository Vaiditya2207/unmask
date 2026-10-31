import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import tar from "tar-stream";
import { analyzeLocal } from "../../src/core/pipeline.mjs";
import { createApp } from "../../src/server/app.mjs";
import { main } from "../../src/cli/main.mjs";
import { lockDiff, preflight } from "../../src/cli/preflight.mjs";

const registry = (name, version) =>
  `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${version}.tgz`;
const integrity = (name, version) =>
  `sha512-${Buffer.from(`${name}@${version}`).toString("base64")}`;
function lock(packages) {
  const entries = { "": { name: "app", version: "1.0.0" } };
  for (const [location, entry] of Object.entries(packages)) {
    const name = location.slice(location.lastIndexOf("node_modules/") + 13);
    entries[location] =
      typeof entry === "string"
        ? {
            version: entry,
            resolved: registry(name, entry),
            integrity: integrity(name, entry),
          }
        : entry;
  }
  return JSON.stringify({ name: "app", lockfileVersion: 3, packages: entries });
}
const base = lock({
  "node_modules/left-pad": "1.3.0",
  "node_modules/chalk": "5.3.0",
});
async function temp(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "unmask-preflight-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function report(exitCode, ruleIds = []) {
  return {
    policy: { exitCode, findings: ruleIds.map((ruleId) => ({ ruleId })) },
    coverage: { complete: exitCode !== 2 },
  };
}
async function capture(fn) {
  const write = process.stdout.write;
  let out = "";
  process.stdout.write = (chunk) => ((out += chunk), true);
  try {
    return { code: await fn(), out };
  } finally {
    process.stdout.write = write;
  }
}

test("lockDiff reports new, source-changed, removed and unsupported entries", () => {
  const head = lock({
    "node_modules/left-pad": {
      version: "1.3.0",
      resolved: registry("left-pad", "1.3.0"),
      integrity: "sha512-dGFtcGVyZWQ=",
    },
    "node_modules/chalk": "5.4.0",
    "node_modules/x/node_modules/chalk": "5.4.0",
    "node_modules/aliased": {
      name: "@scope/real",
      version: "2.0.0",
      resolved: registry("@scope/real", "2.0.0"),
    },
    "node_modules/gitdep": {
      version: "1.0.0",
      resolved: "git+ssh://git@example.com/repo.git#abc",
    },
    "node_modules/ranged": { version: "^1.0.0" },
  });
  const diff = lockDiff(base, head);
  assert.deepEqual(
    diff.added.map((item) => [item.name, item.version, item.reason]),
    [
      ["left-pad", "1.3.0", "source-changed"],
      ["chalk", "5.4.0", "new-identity"],
      ["@scope/real", "2.0.0", "new-identity"],
    ],
  );
  assert.deepEqual(diff.added[1].paths, [
    "node_modules/chalk",
    "node_modules/x/node_modules/chalk",
  ]);
  assert.deepEqual(diff.removed, [{ name: "chalk", version: "5.3.0" }]);
  assert.deepEqual(diff.unsupported, [
    { path: "node_modules/gitdep", reason: "non-registry-source" },
    { path: "node_modules/ranged", reason: "inexact-version" },
  ]);
  assert.deepEqual(
    diff.added.map((item) => item.bound),
    [true, true, false],
  );
});

test("dropping integrity or resolved for an unchanged version is a change that stays unverified", async () => {
  for (const entry of [
    { version: "1.3.0", resolved: registry("left-pad", "1.3.0") },
    { version: "1.3.0", integrity: integrity("left-pad", "1.3.0") },
  ]) {
    const head = lock({
      "node_modules/left-pad": entry,
      "node_modules/chalk": "5.3.0",
    });
    const result = await preflight({
      baselineText: base,
      lockfileText: head,
      checkPackage: async () => report(0),
    });
    assert.deepEqual(
      result.changes.added.map((item) => [item.name, item.reason, item.bound]),
      [["left-pad", "source-changed", false]],
    );
    assert.equal(result.checks[0].status, "completed");
    assert.equal(result.checks[0].bound, false);
    assert.equal(result.coverage.unbound, 1);
    assert.equal(result.coverage.checked, 0);
    assert.equal(result.status, "incomplete");
    assert.equal(result.exitCode, 2);
  }
});

test("a finding stays the status and exit when a later check is cancelled", async () => {
  const controller = new AbortController();
  const result = await preflight({
    baselineText: base,
    lockfileText: lock({
      "node_modules/left-pad": "1.3.0",
      "node_modules/chalk": "5.3.0",
      "node_modules/evil": "1.0.0",
      "node_modules/later": "1.0.0",
    }),
    signal: controller.signal,
    checkPackage: async () => {
      controller.abort();
      return report(3, ["lifecycle-source-absent"]);
    },
  });
  assert.equal(result.status, "findings");
  assert.equal(result.exitCode, 3);
  assert.equal(result.cancelled, true);
  assert.deepEqual(
    result.checks.map((item) => item.status),
    ["completed", "cancelled"],
  );
});

test("preflight statuses: findings beat incomplete, limits and failures stay visible", async () => {
  const head = lock({
    "node_modules/left-pad": "1.3.0",
    "node_modules/chalk": "5.4.0",
    "node_modules/evil": "1.0.0",
    "node_modules/flaky": "1.0.0",
  });
  const calls = [];
  const result = await preflight({
    baselineText: base,
    lockfileText: head,
    maxChecks: 2,
    checkPackage: async (spec) => {
      calls.push(spec);
      if (spec === "evil@1.0.0") return report(3, ["lifecycle-source-absent"]);
      return report(0);
    },
  });
  assert.deepEqual(calls, ["chalk@5.4.0", "evil@1.0.0"]);
  assert.equal(result.status, "findings");
  assert.equal(result.exitCode, 3);
  assert.equal(result.coverage.complete, false);
  assert.deepEqual(result.checks[2], {
    name: "flaky",
    version: "1.0.0",
    status: "not-checked",
    reason: "max-checks",
  });

  const unavailable = await preflight({
    baselineText: base,
    lockfileText: lock({
      "node_modules/left-pad": "1.3.0",
      "node_modules/flaky": "1.0.0",
    }),
    checkPackage: async () => {
      throw new Error("network down");
    },
  });
  assert.equal(unavailable.status, "incomplete");
  assert.equal(unavailable.exitCode, 2);
  assert.equal(unavailable.checks[0].reason, "internal-check-error");

  const unchanged = await preflight({
    baselineText: base,
    lockfileText: base,
    checkPackage: () => assert.fail("no check for unchanged lockfile"),
  });
  assert.equal(unchanged.status, "pass");
  assert.equal(unchanged.exitCode, 0);
  assert.match(unchanged.note, /does not mean safe/);
});

test("preflight rejects invalid lockfiles and missing baseline with exit 2", async (t) => {
  const root = await temp(t);
  const good = path.join(root, "base.json");
  const bad = path.join(root, "package-lock.json");
  await writeFile(good, base);
  await writeFile(bad, '{"lockfileVersion": 3, "packages": {');
  assert.equal(
    await main(["preflight", "--baseline", good, "--lockfile", bad], {
      checkPackage: () => assert.fail("no check on invalid lockfile"),
    }),
    2,
  );
  assert.equal(await main(["preflight", "--lockfile", good]), 2);
  assert.equal(
    await main(["preflight", "--baseline", good, "--max-checks", "0"]),
    2,
  );
});

async function archive(manifest, prefix) {
  const pack = tar.pack();
  const chunks = [];
  const drain = (async () => {
    for await (const chunk of pack) chunks.push(chunk);
  })();
  pack.entry({ name: `${prefix}/package.json` }, JSON.stringify(manifest));
  pack.finalize();
  await drain;
  return gzipSync(Buffer.concat(chunks));
}

test("preflight checks changed identity through the real hosted app over local HTTP", async (t) => {
  const root = await temp(t);
  const manifest = { name: "fixture", version: "1.0.0" };
  const tarballPath = path.join(root, "artifact.tgz");
  const sourceArchivePath = path.join(root, "source.tgz");
  await writeFile(
    tarballPath,
    await archive({ ...manifest, scripts: { install: "inert" } }, "package"),
  );
  await writeFile(sourceArchivePath, await archive(manifest, "root"));
  const fixture = await analyzeLocal({
    tarballPath,
    sourceArchivePath,
    sourceRoot: "root",
    commit: "d".repeat(40),
    claim: manifest,
  });
  fixture.model = { status: "unavailable", reason: "synthetic-hosted-route" };
  const specs = [];
  const server = createApp({
    versionInfo: {
      version: "0.0.0",
      commit: "b".repeat(40),
      tarballSha256: "c".repeat(64),
    },
    runAnalysis: async (spec) => (specs.push(spec), fixture),
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
  const baseline = path.join(root, "base.json");
  const lockfile = path.join(root, "package-lock.json");
  await writeFile(baseline, base);
  await writeFile(
    lockfile,
    lock({
      "node_modules/left-pad": "1.3.0",
      "node_modules/chalk": "5.3.0",
      "node_modules/fixture": "1.0.0",
    }),
  );
  const { code, out } = await capture(() =>
    main(
      ["preflight", "--baseline", baseline, "--lockfile", lockfile, "--json"],
      {
        env: {
          UNMASK_SERVER_URL: `http://127.0.0.1:${server.address().port}`,
        },
        hostedLimits: { pollMs: 1, totalTimeoutMs: 5000 },
      },
    ),
  );
  const result = JSON.parse(out);
  assert.deepEqual(specs, ["fixture@1.0.0"]);
  assert.equal(code, 3);
  assert.equal(result.schema, "unmask-preflight-1");
  assert.equal(result.status, "findings");
  assert.deepEqual(result.checks, [
    {
      name: "fixture",
      version: "1.0.0",
      status: "completed",
      bound: true,
      exitCode: 3,
      findings: ["lifecycle-source-absent"],
      coverageComplete: true,
    },
  ]);
  assert.equal(result.coverage.complete, true);
});
