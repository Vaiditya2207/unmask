import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import { preflight } from "../../src/cli/preflight.mjs";

const integrity = (spec) =>
  `sha512-${createHash("sha512").update(spec).digest("base64")}`;
function lock(specs) {
  const packages = { "": { name: "app", version: "1.0.0" } };
  for (const spec of specs) {
    const at = spec.lastIndexOf("@");
    const name = spec.slice(0, at);
    const version = spec.slice(at + 1);
    packages[`node_modules/${name}`] = {
      version,
      resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
      integrity: integrity(spec),
    };
  }
  return JSON.stringify({ name: "app", lockfileVersion: 3, packages });
}
const clean = () => ({
  policy: { exitCode: 0, findings: [] },
  coverage: { complete: true },
});

test("an advisory block on a changed identity is a finding even when the hosted report has none", async () => {
  const screened = [];
  const result = await preflight({
    baselineText: lock(["left-pad@1.3.0"]),
    lockfileText: lock([
      "left-pad@1.3.0",
      "chalk@5.4.0",
      "evil@1.0.0",
      "flaky@1.0.0",
    ]),
    checkPackage: async () => clean(),
    screenAdvisories: async (items) => {
      screened.push(...items.map((item) => `${item.name}@${item.version}`));
      return new Map([
        ["chalk@5.4.0", { decision: "allow", reasons: [], advisories: [] }],
        [
          "evil@1.0.0",
          {
            decision: "block",
            reasons: ["known-malware"],
            advisories: ["MAL-2026-0001"],
          },
        ],
        [
          "flaky@1.0.0",
          {
            decision: "unknown",
            reasons: ["hosted-unavailable"],
            advisories: [],
          },
        ],
      ]);
    },
  });
  assert.deepEqual(screened, ["chalk@5.4.0", "evil@1.0.0", "flaky@1.0.0"]);
  assert.equal(result.status, "findings");
  assert.equal(result.exitCode, 3);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.advisoryScreened, 2);
  assert.deepEqual(
    result.checks.map((item) => [item.name, item.advisory.decision]),
    [
      ["chalk", "allow"],
      ["evil", "block"],
      ["flaky", "unknown"],
    ],
  );
});

test("a failed advisory screening keeps preflight incomplete instead of passing", async () => {
  const result = await preflight({
    baselineText: lock([]),
    lockfileText: lock(["chalk@5.4.0"]),
    checkPackage: async () => clean(),
    screenAdvisories: async () => {
      throw new Error("service down");
    },
  });
  assert.equal(result.checks[0].exitCode, 0);
  assert.deepEqual(result.checks[0].advisory, {
    decision: "unknown",
    reasons: ["advisory-screening-unavailable"],
    advisories: [],
  });
  assert.equal(result.status, "incomplete");
  assert.equal(result.exitCode, 2);
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

test("preflight blocks the same known-malware identity the install guard blocks, through the real hosted app", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "unmask-preflight-adv-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const looked = [];
  const server = createApp({
    versionInfo: {
      version: "0.0.0",
      commit: "b".repeat(40),
      tarballSha256: "c".repeat(64),
    },
    async runAnalysis(spec) {
      const at = spec.lastIndexOf("@");
      const manifest = { name: spec.slice(0, at), version: spec.slice(at + 1) };
      const file = path.join(root, manifest.name);
      await writeFile(`${file}.tgz`, await archive(manifest, "package"));
      await writeFile(`${file}-src.tgz`, await archive(manifest, "root"));
      const report = await analyzeLocal({
        tarballPath: `${file}.tgz`,
        sourceArchivePath: `${file}-src.tgz`,
        sourceRoot: "root",
        commit: "d".repeat(40),
        claim: manifest,
      });
      report.model = { status: "unavailable", reason: "fixture" };
      return report;
    },
    async advisoryLookup(spec) {
      looked.push(spec);
      const at = spec.lastIndexOf("@");
      const name = spec.slice(0, at);
      const malicious = name === "sneaky-helper";
      return {
        package: { name, version: spec.slice(at + 1) },
        status: malicious ? "found" : "none-reported",
        complete: true,
        advisories: malicious
          ? [
              {
                id: "MAL-2026-0001",
                aliases: [],
                summary: "Fixture malicious package",
                affected: [
                  {
                    package: { ecosystem: "npm", name },
                    ecosystemSeverity: "CRITICAL",
                  },
                ],
              },
            ]
          : [],
      };
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
  const baseline = path.join(root, "base.json");
  const lockfile = path.join(root, "package-lock.json");
  await writeFile(baseline, lock(["left-pad@1.3.0"]));
  await writeFile(lockfile, lock(["left-pad@1.3.0", "sneaky-helper@2.0.1"]));
  const write = process.stdout.write;
  let out = "";
  process.stdout.write = (chunk) => ((out += chunk), true);
  let code;
  try {
    code = await main(
      ["preflight", "--baseline", baseline, "--lockfile", lockfile, "--json"],
      {
        env: {
          UNMASK_SERVER_URL: `http://127.0.0.1:${server.address().port}`,
        },
        hostedLimits: { pollMs: 1, totalTimeoutMs: 5000 },
      },
    );
  } finally {
    process.stdout.write = write;
  }
  const result = JSON.parse(out);
  assert.deepEqual(looked, ["sneaky-helper@2.0.1"]);
  assert.equal(result.checks[0].exitCode, 0);
  assert.deepEqual(result.checks[0].advisory, {
    decision: "block",
    reasons: ["known-malware"],
    advisories: ["MAL-2026-0001"],
  });
  assert.equal(result.status, "findings");
  assert.equal(code, 3);
});
