import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import { compareInventories } from "../../src/core/compare.mjs";
import { createReport } from "../../src/core/report.mjs";
import {
  buildCycloneDxSbom,
  npmPurl,
} from "../../src/core/evidence-exports.mjs";
import { createApp } from "../../src/server/app.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const versionInfo = {
  version: "9.9.9",
  commit: "d".repeat(40),
  tarballSha256: "e".repeat(64),
};
function fixture({
  manifest: overrides = {},
  claim,
  manifestStatus,
  expectedIntegrity = { status: "unavailable" },
  files: extraFiles = {},
} = {}) {
  const manifest = {
    name: "@acme/widget",
    version: "1.2.3+build.1",
    dependencies: { zeta: "^2", "@scope/alpha": "1.0.0", bad: 7 },
    optionalDependencies: { opt: "3" },
    peerDependencies: { peer: "*" },
    devDependencies: { dev: "4" },
    bundledDependencies: ["inner"],
    ...overrides,
  };
  const entries = Object.entries({
    "package.json": JSON.stringify(manifest),
    "index.js": "module.exports = 1;",
    "node_modules/inner/package.json": '{"name":"inner","version":"0.0.1"}',
    "node_modules/inner/index.js": "x",
    "node_modules/@ns/undeclared/index.js": "y",
    ...extraFiles,
  }).map(([path, text]) => ({
    path,
    originalPath: `package/${path}`,
    type: "file",
    content: Buffer.from(text),
    size: Buffer.byteLength(text),
    sha256: sha(text),
    inspection: "retained",
  }));
  const comparison = compareInventories(
    {
      digest: { sha256: "a".repeat(64) },
      complete: true,
      entries,
      failures: [],
    },
    null,
  );
  return createReport({
    inputs: {
      artifact: {
        sha256: "a".repeat(64),
        sha512: "b".repeat(128),
        expectedIntegrity,
      },
      ...(claim === null
        ? {}
        : {
            claim: claim ?? { name: "@acme/widget", version: "1.2.3+build.1" },
          }),
      limits: { maxEntries: 20000 },
    },
    source: { status: "unresolved", method: "unresolved", alternatives: [] },
    comparison,
    manifests: {
      artifact:
        manifestStatus === "invalid"
          ? { status: "invalid" }
          : {
              status: "usable",
              value: manifest,
              evidenceIds: comparison.files.find(
                (f) => f.path === "package.json",
              ).evidenceIds,
            },
      source: { status: "unavailable" },
      registry: { status: "unavailable" },
    },
  });
}
const prop = (item, name) =>
  item.properties.find((entry) => entry.name === `unmask:${name}`)?.value;

test("CycloneDX SBOM lists observed artifact and unresolved declared dependencies", () => {
  const report = fixture();
  const before = JSON.stringify(report);
  const sbom = buildCycloneDxSbom(report, { toolVersion: "9.9.9" });
  assert.equal(JSON.stringify(report), before);
  assert.equal(sbom.bomFormat, "CycloneDX");
  assert.equal(sbom.specVersion, "1.6");
  assert.equal(sbom.serialNumber, undefined);
  assert.equal(sbom.vulnerabilities, undefined);
  assert.deepEqual(sbom.metadata.tools.components, [
    { type: "application", name: "unmask", version: "9.9.9" },
  ]);
  const root = sbom.metadata.component;
  assert.equal(root.group, "@acme");
  assert.equal(root.name, "widget");
  assert.equal(root.purl, "pkg:npm/%40acme/widget@1.2.3%2Bbuild.1");
  assert.deepEqual(root.hashes, [
    { alg: "SHA-256", content: "a".repeat(64) },
    { alg: "SHA-512", content: "b".repeat(128) },
  ]);
  assert.equal(prop(root, "identity-status"), "claim-matches-manifest");
  assert.equal(prop(root, "source-commit-recorded"), undefined);
  const refs = sbom.components.map((item) => item["bom-ref"]);
  assert.deepEqual(refs, [
    "unmask:declared:dependencies:@scope/alpha",
    "unmask:declared:dependencies:zeta",
    "unmask:declared:optionalDependencies:opt",
    "unmask:declared:peerDependencies:peer",
    "unmask:declared:devDependencies:dev",
    "unmask:bundled:node_modules/@ns/undeclared",
    "unmask:bundled:node_modules/inner",
  ]);
  for (const item of sbom.components) {
    assert.equal(prop(item, "resolution"), "unresolved");
    assert.equal(item.version, undefined);
    assert.equal(item.purl, undefined);
    assert.equal(item.hashes, undefined);
  }
  const alpha = sbom.components[0];
  assert.equal(alpha.group, "@scope");
  assert.equal(alpha.name, "alpha");
  assert.equal(alpha.scope, "required");
  assert.equal(prop(alpha, "declared-range"), "1.0.0");
  assert.equal(sbom.components[4].scope, "excluded");
  const inner = sbom.components[6];
  assert.equal(prop(inner, "evidence"), "observed-bundled-path-in-artifact");
  assert.equal(prop(inner, "bundled-files"), "2");
  assert.equal(prop(inner, "bundled-declared"), "true");
  assert.equal(prop(sbom.components[5], "bundled-declared"), "false");
  assert.deepEqual(sbom.dependencies, [
    {
      ref: "unmask:artifact",
      dependsOn: refs.filter((ref) => !ref.includes("devDependencies")),
    },
  ]);
  assert.deepEqual(sbom.compositions, [
    { aggregate: "incomplete", dependencies: ["unmask:artifact"] },
    { aggregate: "unknown", dependencies: refs },
  ]);
  const meta = sbom.metadata;
  assert.equal(prop(meta, "unresolved-dependencies"), "7");
  assert.equal(prop(meta, "invalid-entries-omitted"), "1");
  assert.equal(prop(meta, "transitive-dependencies"), "not-assessed");
  assert.equal(prop(meta, "vulnerabilities"), "not-included");
  assert.equal(prop(meta, "signature"), "unsigned");
  assert.deepEqual(buildCycloneDxSbom(report, { toolVersion: "9.9.9" }), sbom);
});

test("CycloneDX SBOM reports identity conflicts and unusable manifests without inventing entries", () => {
  const conflict = buildCycloneDxSbom(
    fixture({ claim: { name: "other", version: "2.0.0" } }),
  );
  const root = conflict.metadata.component;
  assert.equal(root.group, "@acme");
  assert.equal(root.name, "widget");
  assert.equal(root.version, "1.2.3+build.1");
  assert.equal(root.purl, undefined);
  assert.equal(prop(root, "identity-status"), "claim-conflicts-with-manifest");
  assert.equal(prop(root, "requested-identity"), "other@2.0.0");
  assert.equal(prop(root, "declared-identity"), "@acme/widget@1.2.3+build.1");
  assert.doesNotMatch(JSON.stringify(conflict), /pkg:npm\/other/u);
  const claimOnly = buildCycloneDxSbom(
    fixture({
      claim: { name: "@acme/widget", version: "1.2.3+build.1" },
      manifestStatus: "invalid",
    }),
  );
  assert.equal(claimOnly.metadata.component.name, "unidentified-npm-artifact");
  assert.equal(claimOnly.metadata.component.purl, undefined);
  assert.equal(
    prop(claimOnly.metadata.component, "requested-identity"),
    "@acme/widget@1.2.3+build.1",
  );
  const unusable = buildCycloneDxSbom(
    fixture({ claim: null, manifestStatus: "invalid" }),
  );
  assert.equal(unusable.metadata.component.name, "unidentified-npm-artifact");
  assert.equal(unusable.metadata.component.purl, undefined);
  assert.equal(prop(unusable.metadata.component, "identity-status"), "unknown");
  assert.deepEqual(
    unusable.components.map((item) => prop(item, "evidence")),
    ["observed-bundled-path-in-artifact", "observed-bundled-path-in-artifact"],
  );
  assert.equal(unusable.compositions[0].aggregate, "unknown");
  assert.equal(
    prop(unusable.metadata, "declared:dependencies"),
    "manifest-unavailable",
  );
  assert.equal(npmPurl("../x", "1.0.0"), null);
  assert.throws(() => buildCycloneDxSbom({}), TypeError);
});

async function start(t, runAnalysis) {
  const app = createApp({ versionInfo, runAnalysis });
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        app.closeAllConnections();
        app.close(resolve);
      }),
  );
  const origin = `http://127.0.0.1:${app.address().port}`;
  const get = (path) => fetch(origin + path, { redirect: "manual" });
  async function submit() {
    const response = await fetch(origin + "/check", {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ package: "@acme/widget@1.2.3" }),
    });
    const location = response.headers.get("location");
    for (let i = 0; i < 50; i++) {
      if ((await get(location + ".json")).status !== 202) return location;
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error("job did not finish");
  }
  return { get, submit };
}

test("SBOM route serves completed reports over HTTP with download headers", async (t) => {
  const s = await start(t, async () => fixture());
  assert.equal((await s.get(`/r/${"f".repeat(32)}.cdx.json`)).status, 404);
  assert.equal((await s.get(`/r/${"f".repeat(32)}.xyz.json`)).status, 404);
  const location = await s.submit();
  const response = await s.get(location + ".cdx.json");
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type"),
    /^application\/vnd\.cyclonedx\+json/u,
  );
  assert.equal(
    response.headers.get("content-disposition"),
    'attachment; filename="unmask-sbom.cdx.json"',
  );
  assert.equal(response.headers.get("cache-control"), "no-store");
  const sbom = await response.json();
  assert.deepEqual(
    sbom,
    buildCycloneDxSbom(fixture(), { toolVersion: "9.9.9" }),
  );
  const page = await (await s.get(location)).text();
  assert.match(page, /\.cdx\.json" download="unmask-sbom\.cdx\.json"/u);
});

test("SBOM route refuses failed and malformed reports instead of exporting guesses", async (t) => {
  const failed = await start(t, async () => {
    throw new Error("synthetic analysis failure");
  });
  const failedResponse = await failed.get(
    (await failed.submit()) + ".cdx.json",
  );
  assert.equal(failedResponse.status, 409);
  assert.equal((await failedResponse.json()).error, "report-not-produced");
  const malformed = await start(t, async () => ({
    inputs: { artifact: { sha256: "c".repeat(64) } },
    coverage: { inventory: { files: 0, bytes: 0, complete: true } },
    files: [],
    evidence: [],
    failures: [],
    policy: { exitCode: 0, findings: [] },
    model: { status: "disabled" },
  }));
  const response = await malformed.get(
    (await malformed.submit()) + ".cdx.json",
  );
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { error: "report-not-exportable" });
});

test("CycloneDX SBOM keeps nested bundled packages off the root edge list and reports integrity outcome", () => {
  const sbom = buildCycloneDxSbom(
    fixture({
      files: {
        "node_modules/inner/node_modules/deep/index.js": "z",
        "lib/node_modules/vendored/index.js": "w",
      },
      expectedIntegrity: { algorithm: "sha256", digest: "0".repeat(64) },
    }),
  );
  const byRef = new Map(sbom.components.map((item) => [item["bom-ref"], item]));
  const deep = byRef.get("unmask:bundled:node_modules/inner/node_modules/deep");
  const vendored = byRef.get("unmask:bundled:lib/node_modules/vendored");
  assert.equal(prop(deep, "bundled-location"), "nested");
  assert.equal(prop(deep, "bundled-within"), "node_modules/inner");
  assert.equal(prop(vendored, "bundled-within"), "lib");
  assert.equal(
    prop(byRef.get("unmask:bundled:node_modules/inner"), "bundled-location"),
    "artifact-root-node-modules",
  );
  const edges = sbom.dependencies[0].dependsOn;
  assert.ok(edges.includes("unmask:bundled:node_modules/inner"));
  assert.ok(!edges.includes(deep["bom-ref"]));
  assert.ok(!edges.includes(vendored["bom-ref"]));
  assert.equal(sbom.dependencies.length, 1);
  assert.ok(sbom.compositions[1].dependencies.includes(deep["bom-ref"]));
  assert.equal(prop(sbom.metadata.component, "expected-integrity"), "mismatch");
  const matching = buildCycloneDxSbom(
    fixture({
      expectedIntegrity: { algorithm: "sha512", digest: "b".repeat(128) },
    }),
  );
  assert.equal(
    prop(matching.metadata.component, "expected-integrity"),
    "matches",
  );
  assert.equal(
    prop(
      buildCycloneDxSbom(fixture()).metadata.component,
      "expected-integrity",
    ),
    "unavailable",
  );
});
