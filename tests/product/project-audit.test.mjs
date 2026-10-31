import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  exactTargets,
  parseLockfile,
  readLockfile,
  resolveEdge,
} from "../../src/cli/lockfile.mjs";
import { auditLock } from "../../src/cli/audit.mjs";
import { main } from "../../src/cli/main.mjs";
import { LocalInputError } from "../../src/core/pipeline.mjs";

const tgz = (name, version) =>
  `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${version}.tgz`;
const pkg = (name, version, extra = {}) => ({
  version,
  resolved: tgz(name, version),
  integrity: "sha512-" + createHash("sha512").update("tgz").digest("base64"),
  ...extra,
});
const tgzSha512 = createHash("sha512").update("tgz").digest("hex");
const bound = (exitCode, findings = []) => ({
  policy: { exitCode, findings },
  inputs: { artifact: { sha512: tgzSha512 } },
});
function fixtureLock() {
  return {
    name: "app",
    lockfileVersion: 3,
    packages: {
      "": {
        name: "app",
        workspaces: ["packages/web"],
        dependencies: { a: "^1.0.0", "@s/b": "2.0.0", gitdep: "github:x/y" },
        devDependencies: { d: "1.0.0" },
      },
      "node_modules/a": pkg("a", "1.0.0", { dependencies: { c: "^1.0.0" } }),
      "node_modules/@s/b": pkg("@s/b", "2.0.0", {
        dependencies: { c: "^2.0.0", a: "^1.0.0" },
      }),
      "node_modules/@s/b/node_modules/c": pkg("c", "2.0.0", {
        dependencies: { "@s/b": "^2.0.0" },
      }),
      "node_modules/c": pkg("c", "1.0.0", {
        peerDependencies: { missing: "1" },
      }),
      "node_modules/d": pkg("d", "1.0.0", { dev: true }),
      "node_modules/gitdep": {
        version: "1.0.0",
        resolved: "git+ssh://git@github.com/x/y.git#" + "f".repeat(40),
      },
      "node_modules/web": { resolved: "packages/web", link: true },
      "packages/web": {
        name: "web",
        version: "0.0.1",
        dependencies: { a: "1.0.0", c: "2.0.0" },
      },
      "packages/web/node_modules/c": pkg("c", "2.0.0"),
    },
  };
}
const text = (value) => JSON.stringify(value);

test("lockfile parser rejects malformed, unsupported and invalid shapes", () => {
  for (const [input, code] of [
    ["{", "lockfile-invalid"],
    ["[]", "lockfile-invalid"],
    [text({ lockfileVersion: 1, dependencies: {} }), "lockfile-unsupported"],
    [text({ lockfileVersion: 3 }), "lockfile-invalid"],
    [text({ lockfileVersion: 3, packages: { x: {} } }), "lockfile-invalid"],
    [
      text({ lockfileVersion: 2, packages: { "": { dependencies: [] } } }),
      "lockfile-invalid",
    ],
    [
      text({
        lockfileVersion: 3,
        packages: { "": {}, "node_modules/a": "1.0.0" },
      }),
      "lockfile-invalid",
    ],
  ])
    assert.throws(() => parseLockfile(input), { code });
  assert.throws(
    () => parseLockfile(text(fixtureLock()), { maxBytes: 10, maxEntries: 9 }),
    { code: "lockfile-invalid" },
  );
});

test("lockfile classifies registry, URL, git, inexact and invalid entries", () => {
  const lock = parseLockfile(
    text({
      lockfileVersion: 2,
      packages: {
        "": {},
        "node_modules/ok": pkg("ok", "1.2.3-rc.1"),
        "node_modules/@s/ok": pkg("@s/ok", "1.0.0"),
        "node_modules/alias": pkg("real", "1.0.0", { name: "real" }),
        "node_modules/foreign": {
          version: "1.0.0",
          resolved: "https://example.com/other.tgz",
        },
        "node_modules/evil": {
          version: "1.0.0",
          resolved: "https://evil.example/evil/-/evil-1.0.0.tgz",
        },
        "node_modules/nores": { version: "1.0.0" },
        "node_modules/http": {
          version: "1.0.0",
          resolved: "http://registry.npmjs.org/http/-/http-1.0.0.tgz",
        },
        "node_modules/local": { version: "1.0.0", resolved: "file:../local" },
        "node_modules/urlver": { version: "https://example.com/x.tgz" },
        "node_modules/range": { version: "^1.0.0" },
        "node_modules/BAD": pkg("BAD", "1.0.0"),
        "node_modules/nover": {},
      },
    }),
  );
  const kinds = Object.fromEntries(
    [...lock.entries.values()].map((e) => [e.key, [e.kind, e.reason]]),
  );
  assert.deepEqual(kinds, {
    "": ["root", null],
    "node_modules/ok": ["registry", null],
    "node_modules/@s/ok": ["registry", null],
    "node_modules/alias": ["registry", null],
    "node_modules/foreign": ["url", "non-registry-source"],
    "node_modules/evil": ["url", "non-registry-source"],
    "node_modules/nores": ["registry", null],
    "node_modules/http": ["url", "non-registry-source"],
    "node_modules/local": ["url", "non-registry-source"],
    "node_modules/urlver": ["url", "non-registry-source"],
    "node_modules/range": ["invalid", "inexact-version"],
    "node_modules/BAD": ["invalid", "invalid-name"],
    "node_modules/nover": ["invalid", "missing-version"],
  });
  assert.equal(lock.entries.get("node_modules/ok").bound, true);
  assert.equal(lock.entries.get("node_modules/nores").bound, false);
  const { targets, skipped, considered } = exactTargets(lock);
  assert.equal(considered, 12);
  assert.deepEqual(
    targets.map((t) => t.spec),
    ["@s/ok@1.0.0", "nores@1.0.0", "ok@1.2.3-rc.1", "real@1.0.0"],
  );
  assert.deepEqual(skipped, {
    "non-registry-source": 5,
    "inexact-version": 1,
    "invalid-name": 1,
    "missing-version": 1,
  });
});

test("exact targets deduplicate locations and honour omitDev", () => {
  const lock = parseLockfile(text(fixtureLock()));
  const all = exactTargets(lock);
  assert.deepEqual(
    all.targets.map((t) => [t.spec, t.locations]),
    [
      ["@s/b@2.0.0", ["node_modules/@s/b"]],
      ["a@1.0.0", ["node_modules/a"]],
      ["c@1.0.0", ["node_modules/c"]],
      [
        "c@2.0.0",
        ["node_modules/@s/b/node_modules/c", "packages/web/node_modules/c"],
      ],
      ["d@1.0.0", ["node_modules/d"]],
    ],
  );
  assert.deepEqual(all.skipped, {
    "unresolved-dependency": 1,
    "non-registry-source": 1,
  });
  assert.deepEqual(all.unresolved, [
    { from: "node_modules/c", name: "missing", type: "peer" },
  ]);
  assert.equal(
    exactTargets(lock, { omitDev: true }).targets.some((t) => t.name === "d"),
    false,
  );
});

test("resolveEdge walks nested node_modules, workspaces and links", () => {
  const lock = parseLockfile(text(fixtureLock()));
  assert.equal(resolveEdge(lock, "node_modules/a", "c").key, "node_modules/c");
  assert.equal(
    resolveEdge(lock, "node_modules/@s/b", "c").key,
    "node_modules/@s/b/node_modules/c",
  );
  assert.equal(
    resolveEdge(lock, "node_modules/@s/b/node_modules/c", "@s/b").key,
    "node_modules/@s/b",
  );
  assert.equal(
    resolveEdge(lock, "packages/web", "c").key,
    "packages/web/node_modules/c",
  );
  assert.equal(resolveEdge(lock, "packages/web", "a").key, "node_modules/a");
  assert.equal(resolveEdge(lock, "", "web").key, "packages/web");
  assert.equal(resolveEdge(lock, "node_modules/c", "missing"), null);
});

test("audit statuses, bounds and coverage never treat failures as clean", async () => {
  const lock = parseLockfile(text(fixtureLock()));
  const calls = [];
  const check = async (spec) => {
    calls.push(spec);
    if (spec === "a@1.0.0")
      return {
        policy: {
          exitCode: 3,
          findings: [{ ruleId: "lifecycle-source-absent" }],
        },
        model: { status: "completed" },
      };
    if (spec === "c@1.0.0") return { policy: { exitCode: 2, findings: [] } };
    if (spec === "@s/b@2.0.0")
      throw new LocalInputError("hosted-submit-failed", "HTTP 404");
    return { policy: { exitCode: 0, findings: [] } };
  };
  const result = await auditLock(lock, { check, max: 4, concurrency: 2 });
  assert.equal(calls.length, 4);
  assert.deepEqual(
    result.results.map((r) => [r.spec, r.status]),
    [
      ["@s/b@2.0.0", "failed"],
      ["a@1.0.0", "findings"],
      ["c@1.0.0", "incomplete"],
      ["c@2.0.0", "no-findings"],
      ["d@1.0.0", "not-checked"],
    ],
  );
  assert.equal(result.results[0].error.code, "hosted-submit-failed");
  assert.deepEqual(result.results[1].findings, ["lifecycle-source-absent"]);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.exitCode, 3);
  const clean = await auditLock(
    parseLockfile(
      text({
        lockfileVersion: 3,
        packages: { "": {}, "node_modules/a": pkg("a", "1.0.0") },
      }),
    ),
    { check: async () => bound(0) },
  );
  assert.equal(clean.results[0].binding, "verified");
  assert.equal(clean.coverage.complete, true);
  assert.equal(clean.exitCode, 0);
  const failed = await auditLock(lock, {
    check: async () => {
      throw new Error("boom");
    },
    max: 1,
  });
  assert.equal(failed.exitCode, 2);
  assert.equal(failed.results[0].error.code, "internal");
});

test("audit keeps unbound, mismatched and unreported artifact hashes incomplete", async () => {
  const lock = parseLockfile(
    text({
      lockfileVersion: 3,
      packages: {
        "": {},
        "node_modules/a": pkg("a", "1.0.0"),
        "node_modules/b": pkg("b", "1.0.0"),
        "node_modules/c": { version: "1.0.0" },
        "node_modules/d": pkg("d", "1.0.0", { integrity: "sha1-AAAA" }),
        "node_modules/e": pkg("e", "1.0.0"),
      },
    }),
  );
  const result = await auditLock(lock, {
    max: 5,
    check: async (spec) =>
      spec === "b@1.0.0"
        ? { ...bound(0), inputs: { artifact: { sha512: "f".repeat(128) } } }
        : spec === "e@1.0.0"
          ? { policy: { exitCode: 0, findings: [] } }
          : bound(0),
  });
  assert.deepEqual(
    result.results.map((r) => [r.spec, r.status, r.binding]),
    [
      ["a@1.0.0", "no-findings", "verified"],
      ["b@1.0.0", "no-findings", "mismatch"],
      ["c@1.0.0", "no-findings", "unbound"],
      ["d@1.0.0", "no-findings", "unbound"],
      ["e@1.0.0", "no-findings", "unavailable"],
    ],
  );
  assert.deepEqual(result.coverage.binding, {
    verified: 1,
    mismatch: 1,
    unbound: 2,
    unavailable: 1,
  });
  assert.equal(result.coverage.complete, false);
  assert.equal(result.exitCode, 2);
});

test("lockfile reads are bounded and reject FIFOs and identities parsePackageSpec rejects", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "unmask-lockread-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fifo = path.join(root, "fifo");
  execFileSync("mkfifo", [fifo]);
  await assert.rejects(readLockfile(fifo), { code: "lockfile-unreadable" });
  await assert.rejects(readLockfile(root), { code: "lockfile-unreadable" });
  const big = path.join(root, "big.json");
  await writeFile(big, text(fixtureLock()));
  await assert.rejects(readLockfile(big, { maxBytes: 64, maxEntries: 10 }), {
    code: "lockfile-unreadable",
  });
  assert.equal((await readLockfile(big)).entries.size, 10);
  const lock = parseLockfile(
    text({
      lockfileVersion: 3,
      packages: {
        "": {},
        "node_modules/z": pkg("z", "1.0.0-01"),
        "node_modules/y": pkg("y", "1.0.0-0.1a.10"),
        "node_modules/x~": { version: "1.0.0" },
      },
    }),
  );
  assert.deepEqual(
    [...lock.entries.values()].slice(1).map((e) => e.reason),
    ["inexact-version", null, "invalid-name"],
  );
});

test("lockfile compatibility: legacy names, unresolved, bundled, encoded and traversal entries", async () => {
  const lock = parseLockfile(
    text({
      lockfileVersion: 3,
      packages: {
        "": {
          dependencies: { JSONStream: "1.3.5", a: "1.0.0", gone: "1.0.0" },
        },
        "node_modules/JSONStream": pkg("JSONStream", "1.3.5"),
        "node_modules/a": pkg("a", "1.0.0", {
          optionalDependencies: { fsevents: "2" },
          peerDependencies: { react: "18", vue: "3" },
          peerDependenciesMeta: { react: { optional: true } },
          dependencies: { z: "1" },
        }),
        "node_modules/a/node_modules/z": { version: "1.0.0", inBundle: true },
        "node_modules/@s/e": pkg("@s/e", "1.0.0", {
          resolved: "https://registry.npmjs.org/@s%2fe/-/e-1.0.0.tgz",
        }),
      },
    }),
  );
  const kinds = [...lock.entries.values()].map((e) => [
    e.key,
    e.kind,
    e.reason,
  ]);
  assert.deepEqual(kinds.slice(1), [
    ["node_modules/JSONStream", "invalid", "invalid-name"],
    ["node_modules/a", "registry", null],
    ["node_modules/a/node_modules/z", "bundled", "bundled-dependency"],
    ["node_modules/@s/e", "url", "non-registry-source"],
  ]);
  const { targets, skipped, unresolved } = exactTargets(lock);
  assert.deepEqual(
    targets.map((t) => t.spec),
    ["a@1.0.0"],
  );
  assert.deepEqual(unresolved, [
    { from: "", name: "gone", type: "prod" },
    { from: "node_modules/a", name: "vue", type: "peer" },
  ]);
  assert.deepEqual(skipped, {
    "unresolved-dependency": 2,
    "invalid-name": 1,
    "bundled-dependency": 1,
    "non-registry-source": 1,
  });
  const result = await auditLock(lock, { check: async () => bound(0) });
  assert.equal(result.coverage.complete, false);
  assert.equal(result.exitCode, 2);
  for (const key of [
    "../node_modules/x",
    "node_modules//x",
    "node_modules/./x",
  ])
    assert.throws(
      () =>
        parseLockfile(
          text({
            lockfileVersion: 3,
            packages: { "": {}, [key]: pkg("x", "1.0.0") },
          }),
        ),
      { code: "lockfile-invalid" },
    );
  const conflict = parseLockfile(
    text({
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { a: "1.0.0", b: "1.0.0" } },
        "node_modules/a": pkg("a", "1.0.0"),
        "node_modules/b": pkg("b", "1.0.0", { dependencies: { a: "1.0.0" } }),
        "node_modules/b/node_modules/a": pkg("a", "1.0.0", {
          integrity:
            "sha512-" + createHash("sha512").update("other").digest("base64"),
        }),
      },
    }),
  );
  assert.equal(exactTargets(conflict).targets[0].bound, false);
});

test("unmask audit CLI uses the real hosted transport against a local server", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "unmask-audit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockfile = path.join(root, "package-lock.json");
  await writeFile(
    lockfile,
    text({
      lockfileVersion: 3,
      packages: {
        "": {},
        "node_modules/gone": pkg("gone", "9.9.9"),
        "node_modules/link": { resolved: "x", link: true },
      },
    }),
  );
  const posted = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    posted.push(body);
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("missing");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let stdout = "";
  const write = process.stdout.write;
  process.stdout.write = (chunk) => ((stdout += chunk), true);
  let code;
  try {
    code = await main(["audit", "--lockfile", lockfile, "--json"], {
      env: { UNMASK_SERVER_URL: origin },
      hostedLimits: { pollMs: 1, totalTimeoutMs: 2000, requestTimeoutMs: 1000 },
    });
  } finally {
    process.stdout.write = write;
  }
  assert.equal(code, 2);
  assert.deepEqual(posted, ["package=gone%409.9.9"]);
  const result = JSON.parse(stdout);
  assert.equal(result.results[0].status, "failed");
  assert.equal(result.results[0].error.code, "hosted-submit-failed");
  assert.equal(result.coverage.complete, false);
});

test("unmask audit rejects bad options and unreadable lockfiles with exit 2", async () => {
  const errors = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk) => (errors.push(String(chunk)), true);
  try {
    assert.equal(await main(["audit", "--max", "0"]), 2);
    assert.equal(await main(["audit", "--max", "51"]), 2);
    assert.equal(await main(["audit", "--bogus"]), 2);
    assert.equal(
      await main(["audit", "--lockfile", "/nonexistent/package-lock.json"]),
      2,
    );
  } finally {
    process.stderr.write = write;
  }
  assert.match(errors.join(""), /invalid-option/);
  assert.match(errors.join(""), /unknown-option/);
  assert.match(errors.join(""), /lockfile-unreadable/);
});
