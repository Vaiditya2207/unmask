import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { createApp } from "../../src/server/app.mjs";
import { lookupNpmAdvisories } from "../../src/core/advisories.mjs";
import { AcquisitionError } from "../../src/core/acquire.mjs";

const versionInfo = {
  version: "0.0.0",
  commit: "a".repeat(40),
  tarballSha256: "b".repeat(64),
};
// OSV-shaped fixtures for removed malicious releases; no registry or target code is touched.
const OSV_FIXTURES = {
  "ua-parser-js@0.7.29": {
    id: "GHSA-pjwm-rvh2-c87w",
    summary: "Embedded malware in ua-parser-js",
    versions: ["0.7.29", "0.8.0", "1.0.0"],
  },
  "event-stream@3.3.6": {
    id: "GHSA-mh6f-8j2x-4483",
    summary:
      "Critical severity vulnerability that affects event-stream and flatmap-stream",
    versions: ["3.3.6"],
  },
  "node-ipc@10.1.1": {
    id: "GHSA-97m3-w2cp-4xx6",
    aliases: ["CVE-2022-23812"],
    summary: "Embedded Malicious Code in node-ipc",
    versions: ["10.1.1", "10.1.2"],
  },
};
function osvFixtureFetch(calls) {
  return async (_url, init) => {
    const query = JSON.parse(init.body);
    const spec = `${query.package.name}@${query.version}`;
    calls?.push(spec);
    const fixture = OSV_FIXTURES[spec];
    const vulns = fixture
      ? [
          {
            id: fixture.id,
            aliases: fixture.aliases ?? [],
            summary: fixture.summary,
            affected: [
              {
                package: { name: query.package.name, ecosystem: "npm" },
                versions: fixture.versions,
              },
            ],
          },
        ]
      : undefined;
    return new Response(JSON.stringify(vulns ? { vulns } : {}), {
      headers: { "content-type": "application/json" },
    });
  };
}
const registryRemoved = async (spec) => {
  throw new AcquisitionError("registry-http-error", `${spec} returned 404`);
};
async function start(t, options) {
  const app = createApp({
    versionInfo,
    runAnalysis: registryRemoved,
    ...options,
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
  return {
    origin,
    get: (path) => fetch(origin + path, { redirect: "manual" }),
    async check(spec) {
      const response = await fetch(origin + "/check", {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ package: spec }),
      });
      const location = response.headers.get("location");
      for (let i = 0; i < 50; i++) {
        const job = await fetch(origin + location + ".json");
        if (job.status !== 202) return { location, job: await job.json() };
        await new Promise((resolve) => setImmediate(resolve));
      }
      throw new Error("job did not finish");
    },
  };
}

test("removed malicious releases keep exact-version OSV findings without artifact claims", async (t) => {
  const calls = [];
  const s = await start(t, {
    enrichJob: (spec, { signal }) =>
      lookupNpmAdvisories(spec, { fetchImpl: osvFixtureFetch(calls), signal }),
  });
  for (const [spec, fixture] of Object.entries(OSV_FIXTURES)) {
    const { location, job } = await s.check(spec);
    assert.equal(job.status, "failed");
    assert.equal(job.reason, "analysis-failed");
    assert.equal(job.report, undefined);
    assert.equal(job.vulnerabilityCheck, undefined);
    const result = job.advisoryResult;
    assert.equal(result.kind, "advisory-only");
    assert.equal(result.assessment, "advisories-reported");
    assert.equal(result.advisoryCount, 1);
    assert.equal(result.safetyVerdict, "not-provided");
    assert.deepEqual(result.artifactVerification, {
      status: "not-performed",
      reason: "analysis-failed",
    });
    assert.equal(result.sourceComparison.status, "not-performed");
    assert.equal(result.vulnerabilityCheck.status, "found");
    assert.equal(result.vulnerabilityCheck.complete, true);
    assert.equal(`${result.package.name}@${result.package.version}`, spec);
    assert.equal(result.vulnerabilityCheck.advisories[0].id, fixture.id);
    assert.doesNotMatch(
      JSON.stringify(job),
      /sha256|integrity|"inputs"|"files"/i,
    );
    const html = await (await s.get(location)).text();
    assert.match(html, /Advisory-only result/);
    assert.match(html, new RegExp(fixture.id));
    assert.match(html, /registry artifact was not inspected/);
  }
  assert.deepEqual(calls, Object.keys(OSV_FIXTURES));
});

test("no advisory, failed lookup and disabled enrichment never read as safe", async (t) => {
  const s = await start(t, {
    enrichJob: async (spec, { signal }) => {
      if (spec.startsWith("broken@")) throw new Error("SECRET network detail");
      return lookupNpmAdvisories(spec, {
        fetchImpl: osvFixtureFetch(),
        signal,
      });
    },
  });
  const quiet = (await s.check("left-pad@9.9.9")).job.advisoryResult;
  assert.equal(quiet.assessment, "no-advisory-reported");
  assert.equal(quiet.vulnerabilityCheck.status, "none-reported");
  assert.match(quiet.notice, /not evidence of safety/);
  assert.doesNotMatch(JSON.stringify(quiet), /removed|malicious release/i);
  const broken = await s.check("broken@1.0.0");
  assert.equal(
    broken.job.advisoryResult.assessment,
    "advisory-lookup-unavailable",
  );
  assert.deepEqual(broken.job.advisoryResult.vulnerabilityCheck.reasons, [
    "lookup-failed",
  ]);
  assert.doesNotMatch(JSON.stringify(broken.job), /SECRET/);
  const html = await (await s.get(broken.location)).text();
  assert.match(html, /advisory-lookup-unavailable/);
  assert.doesNotMatch(html, /SECRET/);

  const disabled = await start(t, {});
  const plain = (await disabled.check("node-ipc@10.1.1")).job;
  assert.equal(plain.status, "failed");
  assert.equal(plain.advisoryResult, undefined);
});

test("hostile advisory text is escaped on the failed status page", async (t) => {
  const s = await start(t, {
    enrichJob: async (spec) => ({
      schemaVersion: "1",
      source: "OSV",
      package: { ecosystem: "npm", name: "evil", version: "1.0.0" },
      queriedAt: "2026-11-01T00:00:00.000Z",
      status: "found",
      complete: true,
      reasons: [],
      advisories: [{ id: "MAL-1", summary: "<script>alert(1)</script>" }],
      pagesFetched: 1,
      limits: {},
    }),
  });
  const { location } = await s.check("evil@1.0.0");
  const html = await (await s.get(location)).text();
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("execution timeout keeps a finished advisory lookup and marks a pending one aborted", async (t) => {
  let now = 0;
  const timers = new Map();
  const clock = {
    now: () => now,
    setTimeout(fn, ms) {
      const key = Symbol();
      timers.set(key, { at: now + ms, fn });
      return key;
    },
    clearTimeout: (key) => timers.delete(key),
  };
  const s = await start(t, {
    clock,
    limits: { executionMs: 1000 },
    runAnalysis: (_spec, { signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted"))),
      ),
    enrichJob: (spec, { signal }) =>
      spec.startsWith("node-ipc@")
        ? lookupNpmAdvisories(spec, { fetchImpl: osvFixtureFetch(), signal })
        : new Promise(() => {}),
  });
  const submit = async (spec) =>
    (
      await s.get("/").then(() =>
        fetch(new URL("/check", s.origin), {
          method: "POST",
          redirect: "manual",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ package: spec }),
        }),
      )
    ).headers.get("location");
  const fire = async () => {
    await new Promise((r) => setTimeout(r, 50));
    now += 1000;
    for (const [key, timer] of [...timers])
      if (timer.at <= now) {
        timers.delete(key);
        timer.fn();
      }
  };
  const malware = await submit("node-ipc@10.1.1");
  await fire();
  const kept = await (await s.get(malware + ".json")).json();
  assert.equal(kept.status, "incomplete");
  assert.equal(kept.reason, "execution-timeout");
  assert.equal(kept.advisoryResult.assessment, "advisories-reported");
  assert.equal(
    kept.advisoryResult.artifactVerification.reason,
    "execution-timeout",
  );
  assert.match(await (await s.get(malware)).text(), /GHSA-97m3-w2cp-4xx6/);
  const pending = await submit("slow@1.0.0");
  await fire();
  const aborted = (await (await s.get(pending + ".json")).json())
    .advisoryResult;
  assert.equal(aborted.assessment, "advisory-lookup-unavailable");
  assert.deepEqual(aborted.vulnerabilityCheck.reasons, ["aborted"]);
});
