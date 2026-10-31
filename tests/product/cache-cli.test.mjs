import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  symlink,
  rm,
  realpath,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { main } from "../../src/cli/main.mjs";
import { createReport } from "../../src/core/report.mjs";
import { compareInventories } from "../../src/core/compare.mjs";

function report(digest = "a") {
  return createReport({
    inputs: {
      artifact: { sha256: digest.repeat(64), sha512: "b".repeat(128) },
      claim: { name: "fixture", version: "1.0.0" },
      limits: { maxEntries: 1 },
    },
    source: { status: "unresolved", method: "unresolved", alternatives: [] },
    comparison: compareInventories(
      {
        digest: { sha256: digest.repeat(64) },
        entries: [],
        complete: true,
        failures: [],
      },
      null,
    ),
    manifests: {
      artifact: { status: "unavailable" },
      source: { status: "unavailable" },
      registry: { status: "unavailable" },
    },
  });
}
async function fixture(t) {
  const cwd = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "unmask-cache-cli-")),
  );
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const filename = path.join(cwd, "report.json");
  await writeFile(filename, JSON.stringify(report()));
  const cacheDir = path.join(cwd, "cache");
  const root = path.join(cacheDir, "unmask-reports-v1");
  return { cwd, filename, cacheDir, root };
}
async function run(f, args, now = Date.UTC(2026, 0, 15)) {
  const output = [];
  const code = await main(
    ["cache", ...args, "--cache-dir", f.cacheDir, "--json"],
    {
      cwd: f.cwd,
      now: () => now,
      stdout: { write: (text) => output.push(text) },
      env: new Proxy(
        {},
        {
          get() {
            throw new Error("Environment forbidden");
          },
        },
      ),
      fetchImpl: () => {
        throw new Error("Network forbidden");
      },
    },
  );
  return { code, value: output.length ? JSON.parse(output.join("")) : null };
}

test("cache imports a real report, inspects scope and age, and preserves repeated import age", async (t) => {
  const f = await fixture(t);
  const first = await run(f, ["import", "--report", f.filename]);
  assert.equal(first.code, 0);
  const second = await run(
    f,
    ["import", "--report", f.filename],
    Date.UTC(2026, 0, 17),
  );
  assert.equal(second.code, 0);
  assert.equal(second.value.imported, false);
  const result = await run(f, ["inspect"], Date.UTC(2026, 0, 18));
  assert.equal(result.code, 0);
  assert.equal(result.value.entries.length, 1);
  assert.equal(result.value.entries[0].ageSeconds, 3 * 86400);
  assert.deepEqual(result.value.entries[0].scope, {
    package: "fixture@1.0.0",
    artifactSha256: "a".repeat(64),
  });
  assert.equal(result.value.entries[0].modelStatus, "disabled");
});

test("prune previews and deletes only explicitly bounded expired owned reports", async (t) => {
  const f = await fixture(t);
  assert.equal((await run(f, ["import", "--report", f.filename])).code, 0);
  await writeFile(f.filename, JSON.stringify(report("c")));
  assert.equal((await run(f, ["import", "--report", f.filename])).code, 0);
  await writeFile(path.join(f.cacheDir, "outside.txt"), "preserve");
  const args = ["prune", "--older-than-days", "1", "--limit", "1"];
  const preview = await run(f, args, Date.UTC(2026, 0, 18));
  assert.equal(preview.code, 0);
  assert.equal(preview.value.deleted, 0);
  assert.equal(preview.value.candidates.length, 1);
  assert.equal((await run(f, ["inspect"])).value.entries.length, 2);
  const applied = await run(f, [...args, "--apply"], Date.UTC(2026, 0, 18));
  assert.equal(applied.code, 0);
  assert.equal(applied.value.deleted, 1);
  assert.equal((await run(f, ["inspect"])).value.entries.length, 1);
  assert.equal(
    await readFile(path.join(f.cacheDir, "outside.txt"), "utf8"),
    "preserve",
  );
  assert.equal(await readFile(f.filename, "utf8"), JSON.stringify(report("c")));
});

test("cache refuses an unmarked directory without adopting or deleting files", async (t) => {
  const f = await fixture(t);
  await mkdir(f.root, { recursive: true });
  await writeFile(path.join(f.root, "keep.json"), "unrelated");
  for (const args of [
    ["inspect"],
    ["import", "--report", f.filename],
    ["prune", "--older-than-days", "0", "--limit", "10", "--apply"],
  ]) {
    assert.equal((await run(f, args)).code, 2);
  }
  assert.deepEqual(await readdir(f.root), ["keep.json"]);
});

test("cache refuses a linked root, parent and report input", async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.cwd, "outside");
  await mkdir(outside);
  await symlink(outside, f.cacheDir);
  assert.equal((await run(f, ["import", "--report", f.filename])).code, 2);
  assert.deepEqual(await readdir(outside), []);
  await rm(f.cacheDir);
  await mkdir(f.cacheDir);
  await symlink(outside, f.root);
  assert.equal((await run(f, ["inspect"])).code, 2);
  await rm(f.root);
  const linkedInput = path.join(f.cwd, "linked.json");
  await symlink(f.filename, linkedInput);
  assert.equal((await run(f, ["import", "--report", linkedInput])).code, 2);
});

test("cache refuses linked entries and corruption before deleting any candidates", async (t) => {
  const f = await fixture(t);
  assert.equal((await run(f, ["import", "--report", f.filename])).code, 0);
  const target = path.join(f.cwd, "private.txt");
  await writeFile(target, "SYNTHETIC_PRIVATE_VALUE");
  const linked = path.join(f.root, "f".repeat(64) + ".json");
  await symlink(target, linked);
  assert.equal(
    (
      await run(f, [
        "prune",
        "--older-than-days",
        "0",
        "--limit",
        "10",
        "--apply",
      ])
    ).code,
    2,
  );
  assert.equal(await readFile(target, "utf8"), "SYNTHETIC_PRIVATE_VALUE");
  await rm(linked);
  await writeFile(linked, "{broken}");
  assert.equal(
    (
      await run(f, [
        "prune",
        "--older-than-days",
        "0",
        "--limit",
        "10",
        "--apply",
      ])
    ).code,
    2,
  );
  assert.equal(
    (await readdir(f.root)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .length,
    2,
  );
});

test("cache rejects nonreport inputs and unsafe or missing deletion bounds", async (t) => {
  const f = await fixture(t);
  await writeFile(f.filename, '{"unrelated":"DO_NOT_PRINT"}');
  assert.equal((await run(f, ["import", "--report", f.filename])).code, 2);
  for (const args of [
    ["prune", "--apply"],
    ["prune", "--older-than-days", "0", "--limit", "0", "--apply"],
    ["prune", "--older-than-days", "-1", "--limit", "1"],
    ["prune", "--older-than-days", "0", "--limit", "101"],
    ["inspect", "--apply"],
    ["inspect", "--cache-dir", f.cacheDir],
  ])
    assert.equal((await run(f, args)).code, 2);
});

test("cache import refuses a full cache without making it uninspectable", async (t) => {
  const { createHash } = await import("node:crypto");
  const f = await fixture(t);
  assert.equal((await run(f, ["import", "--report", f.filename])).code, 0);
  for (let index = 1; index < 500; index++) {
    const value = report();
    value.run.timings = { fixture: index };
    const id = createHash("sha256").update(JSON.stringify(value)).digest("hex");
    await writeFile(
      path.join(f.root, id + ".json"),
      JSON.stringify({
        owner: "unmask-local-report-cache",
        schemaVersion: "1",
        cachedAt: Date.UTC(2026, 0, 15),
        report: value,
      }) + "\n",
    );
  }
  await writeFile(f.filename, JSON.stringify(report("c")));
  assert.equal((await run(f, ["import", "--report", f.filename])).code, 2);
  const inspection = await run(f, ["inspect"]);
  assert.equal(inspection.code, 0);
  assert.equal(inspection.value.entries.length, 500);
});

test("cache refuses hardlinks, foreign files and linked lock markers", async (t) => {
  const { link } = await import("node:fs/promises");
  const f = await fixture(t);
  assert.equal((await run(f, ["import", "--report", f.filename])).code, 0);
  const target = path.join(f.cwd, "preserve.txt");
  await writeFile(target, "preserve");
  const hardlink = path.join(f.root, "f".repeat(64) + ".json");
  await link(target, hardlink);
  assert.equal((await run(f, ["inspect"])).code, 2);
  await rm(hardlink);
  const foreign = path.join(f.root, "foreign.txt");
  await writeFile(foreign, "preserve");
  assert.equal(
    (
      await run(f, [
        "prune",
        "--older-than-days",
        "0",
        "--limit",
        "1",
        "--apply",
      ])
    ).code,
    2,
  );
  await rm(foreign);
  await symlink(target, path.join(f.root, ".unmask-write.lock"));
  assert.equal((await run(f, ["inspect"])).code, 2);
  assert.equal(await readFile(target, "utf8"), "preserve");
});

test("cache refuses altered ownership metadata and oversized import files", async (t) => {
  const f = await fixture(t);
  assert.equal((await run(f, ["import", "--report", f.filename])).code, 0);
  const marker = path.join(f.root, ".unmask-owner.json");
  await writeFile(marker, '{"owner":"foreign","schemaVersion":"1"}\n');
  assert.equal((await run(f, ["inspect"])).code, 2);
  assert.equal(
    (await readdir(f.root)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .length,
    1,
  );
  await writeFile(f.filename, " ".repeat(16 * 1024 * 1024 + 1));
  assert.equal((await run(f, ["import", "--report", f.filename])).code, 2);
});
