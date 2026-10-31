import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { createApp } from "../../src/server/app.mjs";
import { buildPackageDetails } from "../../src/core/package-details.mjs";
import * as hosted from "../../src/cli/hosted.mjs";
import { explorerReport, runExplorer } from "../fixtures/package-explorer.mjs";

async function listen(t, server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return `http://127.0.0.1:${server.address().port}`;
}

test("info reaches real hosted details and escapes publisher text without executing scripts", async (t) => {
  let analyses = 0;
  const origin = await listen(
    t,
    createApp({
      versionInfo: {
        version: "0.0.0",
        commit: "b".repeat(40),
        tarballSha256: "c".repeat(64),
      },
      runAnalysis: async () => {
        analyses++;
        return explorerReport();
      },
    }),
  );
  const result = await runExplorer(["info", "example@1.2.3"], origin);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(analyses, 1);
  assert.match(result.stdout, /example@1\.2\.3/);
  assert.match(result.stdout, /Publisher declarations/);
  assert.match(result.stdout, /alpha.*\^1/);
  assert.match(result.stdout, /install.*echo inert/);
  assert.match(result.stdout, /unresolved/);
  assert.match(result.stdout, /OSV.*not-assessed/);
  assert.match(result.stdout, /\\u001b/);
  assert.doesNotMatch(result.stdout, /[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
  assert.match(result.stdout, /not.*safety verdict/i);
});

test("details helper rejects mismatched identities and unsupported projections", async (t) => {
  for (const mutate of [
    (d) => (d.identity.items[0].requested.version = "9.9.9"),
    (d) => (d.detailsVersion = "99"),
  ]) {
    const details = buildPackageDetails(explorerReport());
    mutate(details);
    const origin = await listen(
      t,
      createServer((req, res) => {
        if (req.url === "/check") {
          res.writeHead(303, { location: `/r/${"a".repeat(32)}` });
          res.end();
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify(
              req.url.endsWith(".details.json") ? details : explorerReport(),
            ),
          );
        }
      }),
    );
    assert.equal(typeof hosted.getHostedDetails, "function");
    await assert.rejects(
      hosted.getHostedDetails("example@1.2.3", { serverUrl: origin }),
      { code: "hosted-details-invalid" },
    );
  }
});

test("info rejects ambiguous specs and unsupported options before transport", async () => {
  for (const args of [
    ["info", "example@latest"],
    ["info", "example@1.2.3", "--offline"],
    ["info"],
  ]) {
    const result = await runExplorer(args, "http://127.0.0.1:1");
    assert.equal(result.code, 2);
    assert.doesNotMatch(result.stderr, /hosted-unavailable/);
  }
});

test("info renders recorded OSV facts without treating absence as safe", async (t) => {
  const origin = await listen(
    t,
    createApp({
      versionInfo: {
        version: "0.0.0",
        commit: "b".repeat(40),
        tarballSha256: "c".repeat(64),
      },
      runAnalysis: async () => explorerReport(),
      enrichJob: async () => ({
        schemaVersion: "1",
        source: "OSV",
        package: { ecosystem: "npm", name: "example", version: "1.2.3" },
        status: "found",
        complete: true,
        queriedAt: "2026-11-01T00:00:00Z",
        reasons: [],
        advisories: [
          { id: "OSV-SYNTHETIC", summary: "inert\u001b[0m advisory" },
        ],
        pagesFetched: 1,
        limits: {},
      }),
    }),
  );
  const result = await runExplorer(["info", "example@1.2.3"], origin);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /OSV exact-package query: found; complete=true/);
  assert.match(result.stdout, /OSV-SYNTHETIC: inert\\u001b\[0m advisory/);
  assert.match(result.stdout, /2026-11-01T00:00:00Z/);
  assert.doesNotMatch(result.stdout, /\x1b/);
});

test("details transport rejects redirect, invalid content and oversized responses", async (t) => {
  for (const variant of [
    "redirect",
    "invalid-json",
    "oversize",
    "identity",
    "osv-status",
  ]) {
    const origin = await listen(
      t,
      createServer((req, res) => {
        if (req.url === "/check") {
          res.writeHead(303, { location: `/r/${"a".repeat(32)}` });
          res.end();
          return;
        }
        if (!req.url.endsWith(".details.json")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(explorerReport()));
          return;
        }
        if (variant === "redirect") {
          res.writeHead(302, { location: "https://example.invalid" });
          res.end();
          return;
        }
        if (variant === "oversize") {
          res.writeHead(200, {
            "content-type": "application/json",
            "content-length": "4194305",
          });
          res.end();
          return;
        }
        const details = buildPackageDetails(explorerReport());
        if (variant === "identity")
          details.identity.items[0].artifactDigests.sha256 = "0".repeat(64);
        if (variant === "osv-status")
          details.vulnerabilityCheck = {
            source: "OSV",
            status: "none-reported",
            complete: false,
            advisories: [],
          };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(variant === "invalid-json" ? "{" : JSON.stringify(details));
      }),
    );
    await assert.rejects(
      hosted.getHostedDetails("example@1.2.3", { serverUrl: origin }),
      (error) => /^hosted-(details|response)/.test(error.code),
    );
  }
});
