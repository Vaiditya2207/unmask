import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import { createApp } from "../../src/server/app.mjs";
import { createAdvisoryCache } from "../../src/core/advisory-cache.mjs";
import { compareInventories } from "../../src/core/compare.mjs";
import { createReport } from "../../src/core/report.mjs";
import { AcquisitionError } from "../../src/core/acquire.mjs";

const versionInfo = {
  version: "0.0.0",
  commit: "a".repeat(40),
  tarballSha256: "b".repeat(64),
};
function completedReport() {
  const value = { name: "example", version: "1.2.3" };
  const content = Buffer.from(JSON.stringify(value));
  const entry = {
    path: "package.json",
    originalPath: "package/package.json",
    type: "file",
    content,
    size: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
    inspection: "retained",
  };
  const inventory = {
    digest: { sha256: "a".repeat(64) },
    entries: [entry],
    complete: true,
    failures: [],
  };
  const comparison = compareInventories(inventory, inventory);
  const manifest = {
    status: "usable",
    value,
    evidenceIds: comparison.files[0].evidenceIds,
  };
  return createReport({
    inputs: {
      sourceArchive: { sha256: "a".repeat(64) },
      artifact: { sha256: "a".repeat(64), sha512: "b".repeat(128) },
      claim: value,
      limits: { maxEntries: 20000 },
    },
    source: {
      status: "selected",
      method: "publisher-gitHead",
      alternatives: [],
    },
    comparison,
    manifests: {
      artifact: manifest,
      source: manifest,
      registry: { status: "unavailable" },
    },
  });
}
// OSV-shaped fixture for a removed malicious release; every other package has no advisory.
function fixtureOsv(calls) {
  return async (_url, init) => {
    const { package: pkg, version } = JSON.parse(init.body);
    calls.push(`${pkg.name}@${version}`);
    const vulns =
      pkg.name === "ua-parser-js" && version === "0.7.29"
        ? [
            {
              id: "GHSA-pjwm-rvh2-c87w",
              summary: "Embedded malware in ua-parser-js",
              affected: [
                {
                  package: { ecosystem: "npm", name: "ua-parser-js" },
                  versions: ["0.7.29"],
                  ecosystem_specific: { severity: "CRITICAL" },
                },
              ],
            },
          ]
        : [];
    return new Response(JSON.stringify(vulns.length ? { vulns } : {}), {
      headers: { "content-type": "application/json" },
    });
  };
}
async function start(t) {
  const calls = [];
  const cache = createAdvisoryCache({
    lookupOptions: { fetchImpl: fixtureOsv(calls), retries: 0 },
  });
  const app = createApp({
    versionInfo,
    runAnalysis: async (spec) => {
      if (spec === "example@1.2.3") return completedReport();
      throw new AcquisitionError("registry-http-error", "404");
    },
    enrichJob: cache.lookup,
    advisoryLookup: cache.lookup,
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
  const origin = `http://127.0.0.1:${app.address().port}`;
  const get = (path) => fetch(origin + path, { redirect: "manual" });
  async function check(spec) {
    const response = await fetch(origin + "/check", {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ package: spec }),
    });
    const location = response.headers.get("location");
    for (let i = 0; i < 200; i++) {
      const job = await get(location + ".json");
      if (job.status !== 202) return { location, body: await job.json() };
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("job did not finish");
  }
  return { origin, get, check, calls };
}

test("removed-malware failed job carries its advisory into guard decisions", async (t) => {
  const s = await start(t);
  const failed = await s.check("ua-parser-js@0.7.29");
  assert.equal(failed.body.status, "failed");
  assert.equal(failed.body.advisoryResult.assessment, "advisories-reported");
  for (const profile of ["strict", "balanced", "audit"]) {
    const response = await s.get(
      `${failed.location}.decision.json?profile=${profile}`,
    );
    assert.equal(response.status, 200);
    const decision = await response.json();
    assert.equal(decision.decision, "block", profile);
    assert.deepEqual(
      decision.knownMalware.map((item) => item.id),
      ["GHSA-pjwm-rvh2-c87w"],
    );
    assert.equal(decision.artifact, null);
    assert.equal(decision.assessment.artifactComplete, false);
    assert.ok(decision.reasons.some((r) => r.code === "report-unavailable"));
    assert.equal(decision.permitted, profile === "audit");
  }
  assert.equal(
    (await s.get(failed.location + ".cdx.json")).status >= 400,
    true,
  );
});

test("combined server routes share one advisory cache and keep their contracts", async (t) => {
  const s = await start(t);
  const failed = await s.check("ua-parser-js@0.7.29");
  assert.equal(
    failed.body.advisoryResult.vulnerabilityCheck.cache.status,
    "miss",
  );
  const endpoint = await (
    await s.get("/api/advisory?package=ua-parser-js%400.7.29")
  ).json();
  assert.equal(endpoint.vulnerabilityCheck.cache.status, "hit");
  const screening = await fetch(s.origin + "/api/dependency-screening", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "app",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": {
          name: "app",
          version: "1.0.0",
          dependencies: { "ua-parser-js": "0.7.29" },
        },
        "node_modules/ua-parser-js": {
          version: "0.7.29",
          resolved:
            "https://registry.npmjs.org/ua-parser-js/-/ua-parser-js-0.7.29.tgz",
          integrity: "sha512-AAAA",
        },
      },
    }),
  });
  assert.equal(screening.status, 200);
  const screened = await screening.json();
  assert.equal(screened.status, "advisories-found");
  const flagged = screened.dependencies.find((d) => d.name === "ua-parser-js");
  assert.equal(flagged.advisories[0].id, "GHSA-pjwm-rvh2-c87w");
  assert.deepEqual(s.calls, ["ua-parser-js@0.7.29"]);

  const done = await s.check("example@1.2.3");
  assert.equal(done.body.policy.exitCode, 0);
  const decision = await (await s.get(done.location + ".decision.json")).json();
  assert.deepEqual(decision.package, {
    ecosystem: "npm",
    name: "example",
    version: "1.2.3",
  });
  assert.equal(decision.assessment.artifactComplete, true);
  const sbom = await s.get(done.location + ".cdx.json");
  assert.equal(sbom.status, 200);
  assert.equal((await sbom.json()).bomFormat, "CycloneDX");
  const manifest = await s.get(done.location + ".evidence.json");
  assert.equal(manifest.status, 200);
  assert.equal((await manifest.json()).manifestVersion, "1");
  const files = await s.get(done.location + "/files.json");
  assert.equal(files.status, 200);
  assert.ok(Array.isArray((await files.json()).files));
  const file = await s.get(done.location + "/file.json?path=package.json");
  assert.equal(file.status, 200);
  assert.equal(
    (await s.get(done.location + "/file.json?path=..%2Fetc%2Fpasswd")).status >=
      400,
    true,
  );
  assert.equal(
    (await s.get("/api/advisory?package=example%40latest")).status,
    400,
  );
  assert.deepEqual(s.calls, ["ua-parser-js@0.7.29", "example@1.2.3"]);
});
