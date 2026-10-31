import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import tar from "tar-stream";
import { analyzeLocal } from "../../src/core/pipeline.mjs";
import { createApp } from "../../src/server/app.mjs";

const entrypoint = fileURLToPath(
  new URL("../../src/cli/main.mjs", import.meta.url),
);
const integrity = (name, version) =>
  `sha512-${Buffer.from(name + version).toString("base64")}`;
function entry(name, version, { withIntegrity = true } = {}) {
  return {
    version,
    resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
    ...(withIntegrity ? { integrity: integrity(name, version) } : {}),
  };
}
function lock(packages) {
  return JSON.stringify({
    lockfileVersion: 3,
    packages: { "": { name: "app" }, ...packages },
  });
}
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
async function fixtureReport(root, spec, install) {
  const [name, version] = spec.split("@");
  const manifest = { name, version };
  const tarballPath = path.join(root, `${name}.tgz`);
  const sourceArchivePath = path.join(root, `${name}-source.tgz`);
  await writeFile(
    tarballPath,
    await archive(
      install ? { ...manifest, scripts: { install } } : manifest,
      "package",
    ),
  );
  await writeFile(sourceArchivePath, await archive(manifest, "root"));
  const report = await analyzeLocal({
    tarballPath,
    sourceArchivePath,
    sourceRoot: "root",
    commit: "d".repeat(40),
    claim: manifest,
  });
  report.model = { status: "unavailable", reason: "synthetic-hosted-route" };
  return report;
}

test("real watch process checks atomically rewritten dependency changes, tampering and cancellation through a loopback service", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "unmask-continuous-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockfile = path.join(root, "package-lock.json");
  const atomicWrite = async (text) => {
    const temporary = path.join(root, `.package-lock.${Date.now()}.tmp`);
    await writeFile(temporary, text);
    await rename(temporary, lockfile);
  };
  const specs = [];
  const server = createApp({
    versionInfo: {
      version: "0.0.0",
      commit: "b".repeat(40),
      tarballSha256: "c".repeat(64),
    },
    runAnalysis: async (spec) => {
      specs.push(spec);
      if (spec === "slow@1.0.0") return new Promise(() => {});
      return fixtureReport(root, spec, spec === "evil@1.0.0" ? "inert" : null);
    },
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

  await atomicWrite(
    lock({ "node_modules/left-pad": entry("left-pad", "1.3.0") }),
  );
  const child = spawn(
    process.execPath,
    [
      entrypoint,
      "watch",
      "--lockfile",
      lockfile,
      "--debounce-ms",
      "100",
      "--json",
    ],
    {
      env: {
        PATH: process.env.PATH,
        UNMASK_SERVER_URL: `http://127.0.0.1:${server.address().port}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const killer = setTimeout(() => child.kill("SIGKILL"), 30000);
  t.after(() => clearTimeout(killer));
  let stdout = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  const events = () =>
    stdout
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line));
  const results = () => events().filter((event) => event.type === "result");
  async function until(predicate, label) {
    for (let i = 0; i < 1500 && !predicate(); i++) await delay(10);
    assert.ok(predicate(), `${label}\n${stdout}`);
  }

  await until(() => events().length === 1, "baseline event");
  assert.deepEqual(
    { type: events()[0].type, audited: events()[0].audited },
    { type: "baseline", audited: false },
  );
  assert.deepEqual(specs, [], "the baseline itself is not checked");

  await atomicWrite(
    lock({
      "node_modules/left-pad": entry("left-pad", "1.3.0"),
      "node_modules/evil": entry("evil", "1.0.0"),
    }),
  );
  await until(() => results().length === 1, "added dependency checked");
  const added = results()[0].result;
  assert.deepEqual(specs, ["evil@1.0.0"]);
  assert.equal(added.status, "findings");
  assert.equal(added.exitCode, 3);
  assert.deepEqual(added.checks[0].findings, ["lifecycle-source-absent"]);

  await atomicWrite(
    lock({
      "node_modules/left-pad": entry("left-pad", "1.3.0", {
        withIntegrity: false,
      }),
      "node_modules/evil": entry("evil", "1.0.0"),
    }),
  );
  await until(() => results().length === 2, "integrity removal checked");
  const tampered = results()[1].result;
  assert.deepEqual(specs, ["evil@1.0.0", "left-pad@1.3.0"]);
  assert.deepEqual(
    tampered.changes.added.map((item) => [item.name, item.reason, item.bound]),
    [["left-pad", "source-changed", false]],
  );
  assert.equal(tampered.checks[0].exitCode, 0);
  assert.equal(tampered.coverage.unbound, 1);
  assert.equal(tampered.status, "incomplete");
  assert.equal(tampered.exitCode, 2);

  await atomicWrite(
    lock({
      "node_modules/left-pad": entry("left-pad", "1.3.0", {
        withIntegrity: false,
      }),
      "node_modules/evil": entry("evil", "1.0.0"),
      "node_modules/slow": entry("slow", "1.0.0"),
    }),
  );
  await until(() => specs.includes("slow@1.0.0"), "hosted check in flight");
  child.kill("SIGINT");
  const [code] = await once(child, "exit");
  assert.equal(code, 130);
  const cancelled = results().at(-1).result;
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.exitCode, 2);
  assert.deepEqual(
    cancelled.checks.map((item) => [item.name, item.status]),
    [["slow", "cancelled"]],
  );
  assert.match(stdout, /in-progress run was cancelled and claims no result\n$/);
});
