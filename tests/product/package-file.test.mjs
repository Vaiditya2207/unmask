import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { buildPackageDetails } from "../../src/core/package-details.mjs";
import { explorerReport, runExplorer } from "../fixtures/package-explorer.mjs";
const fixture = JSON.parse(
  await readFile(
    new URL(
      "../../examples/package-explorer/file-api-sample.json",
      import.meta.url,
    ),
  ),
);
const id = "a".repeat(32),
  fileId = fixture.detail.file.fileId;
async function serve(t, { mutate, variant, hostile = false } = {}) {
  const report = explorerReport(true),
    detail = structuredClone(fixture.detail),
    requests = [];
  if (hostile) {
    const excerpt = "\u001b[31mA\u200b\n";
    const raw = report.evidence.find(
      (item) => item.id === detail.evidence[1].id,
    );
    raw.excerpt = excerpt;
    raw.excerptRange = [0, 10];
    detail.evidence[1].excerpt = excerpt;
  }
  mutate?.(detail);
  const server = createServer((req, res) => {
    requests.push({ method: req.method, path: req.url });
    if (req.url.endsWith(".details.json")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(buildPackageDetails(report)));
      return;
    }
    if (req.url === `/r/${id}.json`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(report));
      return;
    }
    if (req.url === `/r/${id}/file.json?fileId=${fileId}`) {
      if (variant === "hang") return;
      if (variant === "redirect") {
        res.writeHead(302, { location: "https://example.invalid" });
        res.end();
        return;
      }
      if (variant === "oversize") {
        res.writeHead(200, {
          "content-type": "application/json",
          "content-length": "131073",
        });
        res.end();
        return;
      }
      if (variant === "chunked") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(" ".repeat(131073));
        return;
      }
      if (variant === "missing") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end('{"error":"file-unavailable"}');
        return;
      }
      res.writeHead(200, {
        "content-type": variant === "html" ? "text/html" : "application/json",
      });
      res.end(variant === "invalid-json" ? "{" : JSON.stringify(detail));
      return;
    }
    res.writeHead(400);
    res.end();
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
  return { origin: `http://127.0.0.1:${server.address().port}`, requests };
}
const args = ["file", "example@1.2.3", "--report", id, "--file-id", fileId];
test("file consumes recorded S10 opaque-ID evidence through GET-only CLI flow", async (t) => {
  const { origin, requests } = await serve(t);
  const result = await runExplorer(args, origin);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /index\.js \[changed\]/);
  assert.match(result.stdout, /artifact-sha256=[a-f0-9]{64}/);
  assert.match(result.stdout, /Excerpt \[0, 10\]: different/);
  assert.match(result.stdout, /recorded.*only/i);
  assert.match(result.stdout, /not a safety verdict/i);
  assert.ok(result.stdout.includes(fileId));
  assert.equal(requests.length, 3);
  assert.ok(requests.every((request) => request.method === "GET"));
  assert.equal(requests[2].path, `/r/${id}/file.json?fileId=${fileId}`);
});
test("file requires exact package and both opaque identifiers before transport", async () => {
  for (const invalid of [
    ["file", "example@latest", "--report", id, "--file-id", fileId],
    ["file", "example@1.2.3"],
    ["file", "example@1.2.3", "--report", "../check", "--file-id", fileId],
    ["file", "example@1.2.3", "--report", id, "--file-id", "../../secret"],
    [...args, "--path", "index.js"],
    [...args, "--file-id", fileId],
  ]) {
    const result = await runExplorer(invalid, "http://127.0.0.1:1");
    assert.equal(result.code, 2);
    assert.doesNotMatch(result.stderr, /hosted-unavailable/);
  }
});
test("file rejects mismatched report, file, hash and evidence before displaying data", async (t) => {
  for (const mutate of [
    (d) => (d.reportId = "b".repeat(32)),
    (d) => (d.file.fileId = "f-" + "b".repeat(43)),
    (d) => (d.file.artifactSha256 = "b".repeat(64)),
    (d) => (d.evidence[0].blobDigest = "b".repeat(64)),
    (d) => (d.evidence[0].excerpt = "forged text"),
    (d) => (d.recordedOnly = false),
    (d) => (d.schemaVersion = "99"),
    (d) => (d.evidenceStatus = "unavailable"),
  ]) {
    const { origin, requests } = await serve(t, { mutate });
    const result = await runExplorer(args, origin);
    assert.equal(result.code, 2, result.stdout);
    assert.match(result.stderr, /file-evidence-invalid/);
    assert.equal(result.stdout, "");
    assert.ok(requests.every((request) => request.method === "GET"));
  }
});
test("file fails explicitly on bounded transport errors without resubmission", async (t) => {
  for (const variant of [
    "redirect",
    "oversize",
    "chunked",
    "missing",
    "html",
    "invalid-json",
  ]) {
    const { origin, requests } = await serve(t, { variant });
    const result = await runExplorer(args, origin);
    assert.equal(result.code, 2, result.stdout);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /file-evidence-/);
    assert.ok(requests.every((request) => request.method === "GET"));
  }
});

test("file escapes hostile recorded terminal text without executing or reconstructing it", async (t) => {
  const { origin } = await serve(t, { hostile: true });
  const result = await runExplorer(args, origin);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /\\u001b\[31mA\\u200b\\u000a/);
  assert.doesNotMatch(
    result.stdout,
    /[\x00-\x08\x0b-\x1f\x7f-\x9f\u200b-\u200d\u2060\ufeff]/,
  );
});

test("file bounds a hanging drilldown read and never falls back to submission", async (t) => {
  const { fileCommand } = await import("../../src/cli/file.mjs");
  const { origin, requests } = await serve(t, { variant: "hang" });
  let stdout = "";
  await assert.rejects(
    fileCommand(args.slice(1), {
      env: { UNMASK_SERVER_URL: origin },
      hostedLimits: { requestTimeoutMs: 50, totalTimeoutMs: 500 },
      stdout: { write: (value) => (stdout += value) },
    }),
    { code: "file-evidence-unavailable" },
  );
  assert.equal(stdout, "");
  assert.equal(requests.length, 3);
  assert.ok(requests.every((request) => request.method === "GET"));
});
