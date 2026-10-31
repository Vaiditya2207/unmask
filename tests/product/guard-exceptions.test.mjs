import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { main } from "../../src/cli/main.mjs";
import { runExceptions } from "../../src/cli/exceptions.mjs";
import {
  activeExceptionFor,
  readGuardConfig,
} from "../../src/core/guard-config.mjs";

const NOW = new Date("2026-11-01T00:00:00.000Z");
async function project(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "unmask-exceptions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function io(cwd, now = NOW) {
  const out = [],
    err = [];
  return {
    runtime: {
      cwd,
      now: () => now,
      stdout: { write: (text) => out.push(text) },
      stderr: { write: (text) => err.push(text) },
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}
const add = (spec, ...extra) => [
  "add",
  spec,
  "--reason",
  "Vendor patch reviewed in SEC-12",
  "--expires",
  "2026-12-01",
  ...extra,
];

test("exceptions add stores an exact expiring entry and prints an audit line", async (t) => {
  const root = await project(t);
  const run = io(root);
  assert.equal(
    await main(["exceptions", ...add("left-pad@1.3.0")], run.runtime),
    0,
  );
  assert.match(
    run.out(),
    /^audit: added exception left-pad@1\.3\.0 expires=2026-12-01T00:00:00\.000Z reason="Vendor patch reviewed in SEC-12" file=.*\.unmask\.json\n$/,
  );
  const saved = JSON.parse(await readFile(path.join(root, ".unmask.json")));
  assert.deepEqual(saved, {
    schemaVersion: 1,
    profile: "strict",
    exceptions: [
      {
        name: "left-pad",
        version: "1.3.0",
        reason: "Vendor patch reviewed in SEC-12",
        expires: "2026-12-01T00:00:00.000Z",
        created: "2026-11-01T00:00:00.000Z",
      },
    ],
  });
  const { config } = await readGuardConfig(root);
  const identity = { name: "left-pad", version: "1.3.0" };
  assert.equal(
    activeExceptionFor(config, identity, { now: NOW }).reason,
    saved.exceptions[0].reason,
  );
  assert.equal(
    activeExceptionFor(
      config,
      { name: "left-pad", version: "1.3.1" },
      { now: NOW },
    ),
    null,
  );
  assert.equal(
    activeExceptionFor(config, identity, { now: NOW, knownMalware: true }),
    null,
  );
  const later = new Date("2026-12-02T00:00:00.000Z");
  assert.equal(activeExceptionFor(config, identity, { now: later }), null);
});

test("exceptions refuse wildcards, ranges, tags, past or long expiry, bad reasons and duplicates", async (t) => {
  const root = await project(t);
  assert.equal(
    await runExceptions(add("@scope/pkg@2.0.0"), io(root).runtime),
    0,
  );
  const cases = [
    [add("left-pad@*"), "invalid-package-spec"],
    [add("left-pad@^1.0.0"), "invalid-package-spec"],
    [add("left-pad@latest"), "invalid-package-spec"],
    [add("*@1.0.0"), "invalid-package-spec"],
    [add("@scope/pkg@2.0.0"), "duplicate-exception"],
    [
      ["add", "a@1.0.0", "--reason", "Reviewed fix", "--expires", "2026-10-01"],
      "expired-exception",
    ],
    [
      ["add", "a@1.0.0", "--reason", "Reviewed fix", "--expires", "2027-06-01"],
      "invalid-expiry",
    ],
    [
      ["add", "a@1.0.0", "--reason", "Reviewed fix", "--expires", "soon"],
      "invalid-expiry",
    ],
    [
      ["add", "a@1.0.0", "--reason", "x\u001b[2J", "--expires", "2026-11-20"],
      "invalid-reason",
    ],
    [
      [
        "add",
        "a@1.0.0",
        "--reason",
        `token npm_${"a".repeat(36)}`,
        "--expires",
        "2026-11-20",
      ],
      "invalid-reason",
    ],
    [["add", "a@1.0.0", "--expires", "2026-11-20"], "usage"],
    [["remove", "a@1.0.0"], "missing-exception"],
    [["list", "--reason", "x"], "usage"],
  ];
  for (const [args, code] of cases) {
    const run = io(root);
    assert.equal(await runExceptions(args, run.runtime), 2, args.join(" "));
    assert.match(run.err(), new RegExp(`^${code}:`), args.join(" "));
  }
  const { config } = await readGuardConfig(root);
  assert.deepEqual(
    config.exceptions.map((e) => `${e.name}@${e.version}`),
    ["@scope/pkg@2.0.0"],
  );
  assert.deepEqual((await readdir(root)).sort(), [".unmask.json"]);
});

test("expired entries stay visible, are never applied and can be pruned with audit output", async (t) => {
  const root = await project(t);
  await runExceptions(add("old@1.0.0"), io(root).runtime);
  await runExceptions(
    [
      "add",
      "fresh@2.0.0",
      "--reason",
      "Reviewed fix",
      "--expires",
      "2027-01-15",
    ],
    io(root).runtime,
  );
  const later = new Date("2026-12-15T00:00:00.000Z");
  let run = io(root, later);
  assert.equal(await runExceptions(["list"], run.runtime), 0);
  assert.match(run.out(), /1 active, 1 expired/);
  assert.match(run.out(), /old@1\.0\.0 EXPIRED \(not applied\)/);
  assert.match(run.out(), /fresh@2\.0\.0 active/);
  run = io(root, later);
  assert.equal(
    await runExceptions(["check", "old@1.0.0", "--json"], run.runtime),
    0,
  );
  assert.equal(JSON.parse(run.out()).exception, null);
  run = io(root, later);
  assert.equal(await runExceptions(["prune"], run.runtime), 0);
  assert.match(run.out(), /^audit: pruned exception old@1\.0\.0 /);
  assert.match(run.out(), /Pruned 1 expired exception\(s\)/);
  run = io(root, later);
  assert.equal(await runExceptions(["remove", "fresh@2.0.0"], run.runtime), 0);
  assert.match(run.out(), /^audit: removed exception fresh@2\.0\.0 /);
  assert.equal((await readGuardConfig(root)).config.exceptions, undefined);
});

test("hand-edited exceptions are validated on load", async (t) => {
  const root = await project(t);
  const file = path.join(root, ".unmask.json");
  const entry = {
    name: "a",
    version: "1.0.0",
    reason: "Reviewed fix",
    created: "2026-11-01T00:00:00.000Z",
    expires: "2026-11-10T00:00:00.000Z",
  };
  for (const [exceptions, code] of [
    [[{ ...entry, version: "1.x" }], "invalid-package-spec"],
    [[{ ...entry, expires: "2027-11-10T00:00:00.000Z" }], "invalid-expiry"],
    [[{ ...entry, expires: "2026-11-10" }], "invalid-config"],
    [[{ ...entry, scope: "*" }], "invalid-config"],
    [[entry, entry], "duplicate-exception"],
  ]) {
    await writeFile(
      file,
      JSON.stringify({ schemaVersion: 1, profile: "strict", exceptions }),
      { mode: 0o600 },
    );
    const run = io(root);
    assert.equal(await runExceptions(["list"], run.runtime), 2, code);
    assert.match(run.err(), new RegExp(`^${code}:`));
  }
});
