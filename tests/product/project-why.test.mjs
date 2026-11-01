import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseLockfile } from "../../src/cli/lockfile.mjs";
import { explainWhy, parseQuery } from "../../src/cli/why.mjs";
import { main } from "../../src/cli/main.mjs";

const pkg = (name, version, extra = {}) => ({
  version,
  resolved: `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${version}.tgz`,
  integrity: "sha512-AAAA",
  ...extra,
});
const lockText = JSON.stringify({
  name: "app",
  lockfileVersion: 3,
  packages: {
    "": {
      name: "app",
      workspaces: ["packages/web"],
      dependencies: { a: "^1.0.0", "@s/b": "2.0.0", alias: "npm:real@1.0.0" },
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
    "node_modules/alias": pkg("real", "1.0.0", { name: "real" }),
    "node_modules/orphan-a": pkg("orphan-a", "1.0.0", {
      dependencies: { "orphan-b": "1" },
    }),
    "node_modules/orphan-b": pkg("orphan-b", "1.0.0", {
      dependencies: { "orphan-a": "1" },
    }),
    "node_modules/web": { resolved: "packages/web", link: true },
    "packages/web": {
      name: "web",
      version: "0.0.1",
      dependencies: { a: "1.0.0", c: "2.0.0" },
    },
    "packages/web/node_modules/c": pkg("c", "2.0.0"),
  },
});
const lock = parseLockfile(lockText);
const chains = (match) =>
  match.paths.map((trail) => trail.map((step) => step.label).join(" > "));

test("why explains every transitive path through cycles and workspaces", () => {
  const result = explainWhy(lock, parseQuery("c@1.0.0"));
  assert.equal(result.matches.length, 1);
  const [match] = result.matches;
  assert.equal(match.direct, false);
  assert.deepEqual(chains(match).sort(), [
    "app (root) > @s/b@2.0.0 > a@1.0.0 > c@1.0.0",
    "app (root) > a@1.0.0 > c@1.0.0",
    "web@0.0.1 (workspace) > a@1.0.0 > c@1.0.0",
  ]);
  assert.equal(match.paths[0][0].dependencyType, "prod");
  assert.equal(match.paths[0].at(-1).dependencyType, null);
});

test("why reports duplicates per location with direct workspace placement", () => {
  const result = explainWhy(lock, parseQuery("c"));
  assert.deepEqual(
    result.matches.map((m) => [m.key, m.version, m.direct, chains(m).length]),
    [
      ["node_modules/@s/b/node_modules/c", "2.0.0", false, 1],
      ["node_modules/c", "1.0.0", false, 3],
      ["packages/web/node_modules/c", "2.0.0", true, 1],
    ],
  );
  assert.deepEqual(chains(result.matches[0]), [
    "app (root) > @s/b@2.0.0 > c@2.0.0",
  ]);
  assert.match(result.limitations.join(" "), /3 locations \(2 versions\)/);
  assert.match(result.limitations.join(" "), /Workspaces are treated/);
});

test("why handles dev, alias, truncation, orphan cycles and unresolved peers", () => {
  const dev = explainWhy(lock, parseQuery("d")).matches[0];
  assert.equal(dev.dev, true);
  assert.equal(dev.direct, true);
  assert.equal(dev.paths[0][0].dependencyType, "dev");
  const alias = explainWhy(lock, parseQuery("alias")).matches[0];
  assert.deepEqual([alias.name, alias.alias], ["real", "alias"]);
  assert.equal(explainWhy(lock, parseQuery("real")).matches.length, 1);
  const capped = explainWhy(lock, parseQuery("c@1.0.0"), { maxPaths: 1 });
  assert.equal(capped.matches[0].paths.length, 1);
  assert.equal(capped.matches[0].truncated, true);
  const orphan = explainWhy(lock, parseQuery("orphan-a"));
  assert.deepEqual(orphan.matches[0].paths, []);
  assert.match(orphan.limitations.join(" "), /extraneous/);
  const missing = explainWhy(lock, parseQuery("missing"));
  assert.equal(missing.found, false);
  assert.deepEqual(missing.unresolvedEdges, [
    { from: "node_modules/c", name: "missing", range: "1", type: "peer" },
  ]);
  for (const bad of ["", "Bad", "a@^1", "a@latest", "@s"])
    assert.throws(() => parseQuery(bad), { code: "invalid-package" });
});

test("why explains workspace packages instead of reporting them absent", () => {
  const ws = parseLockfile(
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { name: "ws-root", workspaces: ["packages/*"] },
        "node_modules/a": { resolved: "packages/a", link: true },
        "node_modules/b": { resolved: "packages/b", link: true },
        "packages/a": { version: "1.0.0", dependencies: { b: "1.0.0" } },
        "packages/b": { version: "1.0.0" },
      },
    }),
  );
  const b = explainWhy(ws, parseQuery("b"));
  assert.equal(b.found, true);
  assert.deepEqual(
    b.matches.map((m) => [m.key, m.workspace, chains(m)]),
    [["packages/b", true, ["a@1.0.0 (workspace) > b@1.0.0 (workspace)"]]],
  );
  assert.match(b.limitations.join(" "), /part of the project itself/);
  const a = explainWhy(ws, parseQuery("a"));
  assert.deepEqual(a.matches[0].paths, []);
  assert.doesNotMatch(a.limitations.join(" "), /extraneous/);
});

test("unmask why CLI prints paths, JSON and honest not-found errors", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "unmask-why-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockfile = path.join(root, "package-lock.json");
  await writeFile(lockfile, lockText);
  let stdout = "";
  let stderr = "";
  const out = process.stdout.write;
  const err = process.stderr.write;
  process.stdout.write = (chunk) => ((stdout += chunk), true);
  process.stderr.write = (chunk) => ((stderr += chunk), true);
  const codes = [];
  try {
    codes.push(await main(["why", "c@2.0.0", "--lockfile", lockfile]));
    codes.push(await main(["why", "d", "--lockfile", lockfile, "--json"]));
    codes.push(await main(["why", "nope", "--lockfile", lockfile]));
    codes.push(await main(["why", "missing", "--lockfile", lockfile]));
    codes.push(await main(["why", "c", "--max-paths", "0"]));
    codes.push(await main(["why"]));
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
  assert.deepEqual(codes, [0, 0, 2, 2, 2, 2]);
  assert.match(
    stderr,
    /package-not-locked: Declared by node_modules\/c \(peer\) but has no locked entry/,
  );
  assert.match(
    stdout,
    /c@2\.0\.0 at node_modules\/@s\/b\/node_modules\/c \(transitive\): 1 path\(s\)\n {2}app \(root\) -> @s\/b@2\.0\.0 -> c@2\.0\.0/,
  );
  assert.match(stdout, /web@0\.0\.1 \(workspace\) -> c@2\.0\.0/);
  assert.match(stdout, /"dependencyType": "dev"/);
  assert.match(stderr, /package-not-in-lockfile/);
  assert.match(stderr, /invalid-option/);
  assert.match(stderr, /usage/);
});
