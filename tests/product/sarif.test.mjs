import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import tar from "tar-stream";
import { analyzeLocal } from "../../src/core/pipeline.mjs";
import { toSarif } from "../../src/core/sarif.mjs";

const entrypoint = fileURLToPath(
  new URL("../../src/cli/main.mjs", import.meta.url),
);
async function archive(files, prefix) {
  const pack = tar.pack(),
    chunks = [];
  const drain = (async () => {
    for await (const chunk of pack) chunks.push(chunk);
  })();
  for (const [name, body] of Object.entries(files))
    pack.entry({ name: `${prefix}/${name}`, mtime: new Date(0) }, body);
  pack.finalize();
  await drain;
  return gzipSync(Buffer.concat(chunks));
}
async function reportFixture(
  t,
  { mutation = true, source = true, claim = undefined } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "unmask-sarif-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = { name: "fixture", version: "1.0.0" };
  const artifact = path.join(root, "artifact.tgz"),
    sourceArchive = path.join(root, "source.tgz");
  await writeFile(
    artifact,
    await archive(
      {
        "package.json": JSON.stringify({
          ...manifest,
          ...(mutation ? { scripts: { postinstall: "node run.js" } } : {}),
        }),
        "run.js": 'require("child_process").exec("id");\n',
      },
      "package",
    ),
  );
  await writeFile(
    sourceArchive,
    await archive(
      {
        "package.json": JSON.stringify(manifest),
        "run.js": "module.exports = 1;\n",
      },
      "root",
    ),
  );
  const report = await analyzeLocal({
    tarballPath: artifact,
    ...(source
      ? {
          sourceArchivePath: sourceArchive,
          commit: "a".repeat(40),
          sourceRoot: "root",
        }
      : {}),
    cacheDir: path.join(root, "cache"),
    claim: claim ?? manifest,
  });
  const reportPath = path.join(root, "report.json");
  await writeFile(reportPath, JSON.stringify(report));
  return { root, report, reportPath };
}
function cli(args) {
  return spawnSync(process.execPath, [entrypoint, ...args], {
    encoding: "utf8",
    timeout: 10000,
  });
}
const osv = (status, advisories, extra = {}) => ({
  schemaVersion: "1",
  source: "OSV",
  package: { ecosystem: "npm", name: "fixture", version: "1.0.0" },
  queriedAt: "2026-11-01T00:00:00.000Z",
  status,
  complete: ["found", "none-reported"].includes(status),
  reasons: status === "found" || status === "none-reported" ? [] : ["timeout"],
  advisories,
  pagesFetched: 1,
  limits: {},
  ...extra,
});

test("SARIF export of a real report carries policy findings and cues with byte regions, never line numbers", async (t) => {
  const { report } = await reportFixture(t);
  const sarif = toSarif(report);
  assert.equal(sarif.version, "2.1.0");
  const run = sarif.runs[0];
  const ids = run.results.map((item) => item.ruleId);
  assert.ok(ids.includes("policy/lifecycle-source-absent"));
  assert.ok(ids.some((id) => id.startsWith("cue/syntax-")));
  assert.deepEqual(
    run.tool.driver.rules.map((rule) => rule.id),
    [...new Set(ids)].sort(),
  );
  for (const result of run.results) {
    assert.equal(run.tool.driver.rules[result.ruleIndex].id, result.ruleId);
    assert.match(
      result.partialFingerprints["unmaskFinding/v1"],
      /^[a-f0-9]{64}$/,
    );
    for (const location of result.locations ?? []) {
      const region = location.physicalLocation.region;
      assert.deepEqual(Object.keys(region).sort(), [
        "byteLength",
        "byteOffset",
      ]);
      assert.ok(!JSON.stringify(location).includes("startLine"));
    }
  }
  const lifecycle = run.results.find(
    (item) => item.ruleId === "policy/lifecycle-source-absent",
  );
  assert.equal(lifecycle.level, "error");
  assert.equal(
    lifecycle.locations[0].physicalLocation.artifactLocation.uri,
    "package.json",
  );
  const notifications = run.invocations[0].toolExecutionNotifications.map(
    (item) => item.descriptor.id,
  );
  assert.ok(notifications.includes("advisory/not-supplied"));
  assert.ok(notifications.includes("limitation/absence-not-safety"));
  assert.deepEqual(toSarif(report), sarif);
});

test("SARIF reports OSV malware advisories bound to the exact report identity and incomplete checks as limitations", async (t) => {
  const { report } = await reportFixture(t, { mutation: false });
  const found = toSarif(report, {
    vulnerabilityCheck: osv("found", [
      {
        id: "MAL-2026-1",
        summary: "Malicious code in fixture",
        aliases: ["GHSA-xxxx-yyyy-zzzz"],
      },
      { id: "GHSA-aaaa-bbbb-cccc", summary: "Prototype pollution" },
    ]),
  }).runs[0];
  const malware = found.results.find(
    (item) => item.ruleId === "advisory/known-malware",
  );
  assert.equal(malware.level, "error");
  assert.equal(malware.properties.advisoryId, "MAL-2026-1");
  assert.equal(
    malware.locations[0].logicalLocations[0].fullyQualifiedName,
    "npm:fixture@1.0.0",
  );
  assert.equal(malware.locations[0].physicalLocation, undefined);
  assert.ok(
    found.results.some(
      (item) => item.ruleId === "advisory/known-vulnerability",
    ),
  );
  const partial = toSarif(report, osv("unavailable", [])).runs[0];
  const limitation = partial.invocations[0].toolExecutionNotifications.find(
    (item) => item.descriptor.id === "advisory/incomplete",
  );
  assert.match(
    limitation.message.text,
    /unavailable \(timeout\).*do not mean none exist/,
  );
  assert.equal(partial.properties.unmask.advisories.complete, false);
  assert.throws(
    () =>
      toSarif(report, {
        vulnerabilityCheck: osv("found", [{ id: "MAL-1" }], {
          package: { ecosystem: "npm", name: "other", version: "1.0.0" },
        }),
      }),
    { code: "details-identity-mismatch" },
  );
  assert.throws(() => toSarif(report, osv("found", [])), {
    code: "details-invalid",
  });
});

test("SARIF keeps coverage limitations and sanitizes untrusted cue identifiers", async (t) => {
  const { report } = await reportFixture(t, { source: false });
  report.cues.push({
    ruleId: "evil\n::error::x",
    summary: "x".repeat(5000),
    evidenceIds: [],
  });
  const run = toSarif(report).runs[0];
  const ids = run.invocations[0].toolExecutionNotifications.map(
    (item) => item.descriptor.id,
  );
  assert.ok(ids.includes("coverage/source-unavailable"));
  const cue = run.results.find((item) => item.ruleId === "cue/unrecognized");
  assert.ok(cue.message.text.length < 1100);
  assert.throws(() => toSarif({ ...report, extra: true }), {
    code: "report-invalid",
  });
});

test("unmask sarif CLI writes SARIF to stdout or an exclusive file and rejects bad input with exit 2", async (t) => {
  const { root, reportPath } = await reportFixture(t);
  const printed = cli(["sarif", "--report", reportPath]);
  assert.equal(printed.status, 0, printed.stderr);
  assert.equal(JSON.parse(printed.stdout).runs[0].tool.driver.name, "unmask");
  const out = path.join(root, "out.sarif");
  const written = cli(["sarif", "--report", reportPath, "--out", out]);
  assert.equal(written.status, 0, written.stderr);
  assert.equal((await stat(out)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(out, "utf8")).version, "2.1.0");
  assert.equal(cli(["sarif", "--report", reportPath, "--out", out]).status, 2);
  const missing = cli(["sarif"]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /^usage:/);
  const broken = path.join(root, "broken.json");
  await writeFile(broken, "{");
  assert.match(
    cli(["sarif", "--report", broken]).stderr,
    /^input-read-failed:/,
  );
  const details = path.join(root, "details.json");
  await writeFile(
    details,
    JSON.stringify({ vulnerabilityCheck: osv("none-reported", []) }),
  );
  const withDetails = cli([
    "sarif",
    "--report",
    reportPath,
    "--details",
    details,
  ]);
  assert.equal(withDetails.status, 0, withDetails.stderr);
  assert.equal(
    JSON.parse(withDetails.stdout).runs[0].properties.unmask.advisories.status,
    "none-reported",
  );
});

test("SARIF keeps advisories from incomplete OSV checks, detects MAL aliases and records severity or its absence", async (t) => {
  const { report } = await reportFixture(t, { mutation: false });
  const run = toSarif(report, {
    ...osv("incomplete", [
      { id: "MAL-2026-0001" },
      {
        id: "GHSA-gggg-hhhh-iiii",
        aliases: ["MAL-2026-0002"],
        severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N" }],
        databaseSeverity: "CRITICAL",
      },
    ]),
    reasons: ["page-cap"],
  }).runs[0];
  const malware = run.results.filter(
    (item) => item.ruleId === "advisory/known-malware",
  );
  assert.deepEqual(
    malware.map((item) => item.properties.malwareIdentifier),
    ["MAL-2026-0001", "MAL-2026-0002"],
  );
  assert.ok(malware.every((item) => item.level === "error"));
  assert.match(
    malware[1].message.text,
    /^GHSA-gggg-hhhh-iiii \(alias MAL-2026-0002\): /,
  );
  assert.deepEqual(malware[0].properties.severity, {
    status: "not-recorded",
    levelBasis: "fixed-rule-mapping",
  });
  assert.equal(malware[1].properties.severity.status, "recorded");
  assert.deepEqual(malware[1].properties.severity.labels, ["CRITICAL"]);
  const limitation = run.invocations[0].toolExecutionNotifications.find(
    (item) => item.descriptor.id === "advisory/incomplete",
  );
  assert.match(limitation.message.text, /incomplete \(page-cap\)/);
  assert.throws(
    () =>
      toSarif(report, {
        ...osv("incomplete", [{ id: "MAL-1" }]),
        package: null,
      }),
    { code: "details-identity-mismatch" },
  );
  assert.throws(
    () =>
      toSarif(report, { ...osv("found", [{ id: "MAL-1" }]), complete: false }),
    { code: "details-invalid" },
  );
});

test("unmask sarif refuses a FIFO report without blocking", async (t) => {
  const { root } = await reportFixture(t, { mutation: false });
  const fifo = path.join(root, "report.fifo");
  assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
  const result = cli(["sarif", "--report", fifo]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /^input-read-failed:/);
});

test("SARIF exposes requested and declared identities and caveats advisories bound to a conflicting claim without altering completeness", async (t) => {
  const { report } = await reportFixture(t, {
    mutation: false,
    claim: { name: "lodash", version: "4.17.21" },
  });
  const clean = {
    ...osv("none-reported", []),
    package: { ecosystem: "npm", name: "lodash", version: "4.17.21" },
  };
  const run = toSarif(report, clean).runs[0];
  assert.ok(
    run.results.some(
      (item) => item.ruleId === "policy/identity-claim-conflict",
    ),
  );
  assert.deepEqual(run.properties.unmask.package, {
    name: "lodash",
    version: "4.17.21",
    source: "claim",
    identityStatus: "claim-conflicts-with-manifest",
    requested: { name: "lodash", version: "4.17.21" },
    declared: { name: "fixture", version: "1.0.0" },
  });
  assert.equal(run.properties.unmask.advisories.complete, true);
  assert.equal(run.properties.unmask.advisories.boundTo, "claim");
  const caveat = run.invocations[0].toolExecutionNotifications.find(
    (item) => item.descriptor.id === "advisory/identity-conflict",
  );
  assert.equal(caveat.level, "warning");
  assert.match(
    caveat.message.text,
    /lodash@4\.17\.21.*fixture@1\.0\.0; the declared identity was not screened/,
  );
  assert.throws(() => toSarif(report, osv("found", [{ id: "MAL-1" }])), {
    code: "details-identity-mismatch",
  });
  const matching = toSarif(
    (await reportFixture(t, { mutation: false })).report,
    osv("none-reported", []),
  ).runs[0];
  assert.equal(
    matching.properties.unmask.package.identityStatus,
    "claim-matches-manifest",
  );
  assert.ok(
    !matching.invocations[0].toolExecutionNotifications.some((item) =>
      item.descriptor.id.startsWith("advisory/identity"),
    ),
  );
});
