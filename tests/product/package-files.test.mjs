import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { createApp } from "../../src/server/app.mjs";
import { buildPackageDetails } from "../../src/core/package-details.mjs";
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
async function app(t) {
  return listen(
    t,
    createApp({
      versionInfo: {
        version: "0.0.0",
        commit: "b".repeat(40),
        tarballSha256: "c".repeat(64),
      },
      runAnalysis: async () => explorerReport(),
    }),
  );
}

test("files displays a stable bounded page with recorded hashes and states", async (t) => {
  const result = await runExplorer(
    ["files", "example@1.2.3", "--limit", "2", "--offset", "1"],
    await app(t),
  );
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Rows 2-3 of 4/);
  assert.match(result.stdout, /index\.js/);
  assert.match(result.stdout, /package\.json/);
  assert.doesNotMatch(result.stdout, /README\.md/);
  assert.match(result.stdout, /not-compared/);
  assert.match(result.stdout, /artifact-sha256=[a-f0-9]{64}/);
  assert.match(result.stdout, /source-sha256=unavailable/);
  assert.match(result.stdout, /Next offset: 3/);
});

test("files combines literal path and state filters without interpreting regex", async (t) => {
  const origin = await app(t);
  const result = await runExplorer(
    ["files", "example@1.2.3", "--path", ".js", "--state", "not-compared"],
    origin,
  );
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Rows 1-3 of 3/);
  assert.match(result.stdout, /evil\\u001b\[31m\.js/);
  assert.doesNotMatch(result.stdout, /[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
  const literal = await runExplorer(
    ["files", "example@1.2.3", "--path", ".*"],
    origin,
  );
  assert.equal(literal.code, 0, literal.stderr);
  assert.match(literal.stdout, /Rows 0-0 of 0/);
});

test("files distinguishes an empty filter or page from a complete package inventory", async (t) => {
  const result = await runExplorer(
    ["files", "example@1.2.3", "--state", "changed", "--offset", "50"],
    await app(t),
  );
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Rows 0-0 of 0/);
  assert.match(result.stdout, /not a safety verdict/i);
  assert.match(result.stdout, /accepted artifact regular files/i);
});

test("files rejects invalid pagination, duplicate flags and unsupported states before transport", async () => {
  for (const options of [
    ["--limit", "0"],
    ["--limit", "201"],
    ["--limit", "1e2"],
    ["--offset", "-1"],
    ["--offset", "9007199254740992"],
    ["--state", "safe"],
    ["--state"],
    ["--path", "a", "--path", "b"],
    ["--json"],
  ]) {
    const result = await runExplorer(
      ["files", "example@1.2.3", ...options],
      "http://127.0.0.1:1",
    );
    assert.equal(result.code, 2);
    assert.doesNotMatch(result.stderr, /hosted-unavailable/);
  }
});

test("files exposes upstream projection omissions and rejects invalid file records", async (t) => {
  for (const invalid of [false, true]) {
    const details = buildPackageDetails(explorerReport(), { maxItems: 1 });
    if (invalid)
      details.inventory.files.items[0].artifactSha256 = "not-a-digest";
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
    const result = await runExplorer(["files", "example@1.2.3"], origin);
    assert.equal(result.code, invalid ? 2 : 0, result.stderr);
    if (invalid) assert.match(result.stderr, /hosted-details-invalid/);
    else {
      assert.match(result.stdout, /3.*omitted.*hosted/i);
      assert.match(result.stdout, /Rows 1-1 of 1/);
    }
  }
});

test("files preserves mixed correspondence states and source digests from the report", async (t) => {
  const report = explorerReport(true);
  const origin = await listen(
    t,
    createApp({
      versionInfo: {
        version: "0.0.0",
        commit: "b".repeat(40),
        tarballSha256: "c".repeat(64),
      },
      runAnalysis: async () => report,
    }),
  );
  for (const [state, path] of [
    ["changed", "index.js"],
    ["byte-identical", "README.md"],
    ["artifact-only", "src/evil"],
  ]) {
    const result = await runExplorer(
      ["files", "example@1.2.3", "--state", state],
      origin,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, new RegExp(path.replace(".", "\\.")));
    if (state !== "artifact-only")
      assert.match(result.stdout, /source-sha256=[a-f0-9]{64}/);
    else assert.match(result.stdout, /source-sha256=unavailable/);
    assert.match(result.stdout, /AI: disabled/);
  }
});

test("files report-bound paging reads one existing report without submitting or rerunning providers", async (t) => {
  let submissions = 0,
    providers = 0;
  const report = explorerReport();
  report.model = { status: "unavailable", reason: "quota-exceeded" };
  const server = createApp({
    versionInfo: {
      version: "0.0.0",
      commit: "b".repeat(40),
      tarballSha256: "c".repeat(64),
    },
    runAnalysis: async () => {
      providers++;
      return report;
    },
  });
  server.on("request", (req) => {
    if (req.method === "POST") submissions++;
  });
  const origin = await listen(t, server);
  const first = await runExplorer(
    ["files", "example@1.2.3", "--limit", "2"],
    origin,
  );
  assert.equal(first.code, 0, first.stderr);
  const id = /Report ID: ([a-f0-9]{32})/.exec(first.stdout)?.[1];
  assert.ok(id, "first page exposes reusable report identity");
  const second = await runExplorer(
    ["files", "example@1.2.3", "--report", id, "--offset", "2", "--limit", "2"],
    origin,
  );
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /Rows 3-4 of 4/);
  assert.ok(second.stdout.includes(`Report ID: ${id}`));
  assert.ok(first.stdout.includes(`--report ${id}`));
  assert.equal(submissions, 1, "paging did not submit a new check");
  assert.equal(providers, 1, "paging did not rerun the analysis/model path");
});

test("files report IDs fail closed and report-bound identities still match the requested spec", async (t) => {
  for (const id of [
    "../check",
    "https://example.invalid/r/" + "a".repeat(32),
    "a".repeat(31),
  ]) {
    const result = await runExplorer(
      ["files", "example@1.2.3", "--report", id],
      "http://127.0.0.1:1",
    );
    assert.equal(result.code, 2);
    assert.doesNotMatch(result.stderr, /hosted-unavailable/);
  }
  let posts = 0;
  const origin = await listen(
    t,
    createServer((req, res) => {
      if (req.method === "POST") posts++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(explorerReport()));
    }),
  );
  const result = await runExplorer(
    ["files", "other@1.2.3", "--report", "a".repeat(32)],
    origin,
  );
  assert.equal(result.code, 2);
  assert.match(result.stderr, /hosted-report-invalid/);
  assert.equal(posts, 0);
});
