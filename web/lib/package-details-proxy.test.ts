import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { proxyPackageDetails } from "./package-details-proxy.ts";

test("details proxy preserves terminal, pending and expired responses without starting work", async (t) => {
  const seen: string[] = [];
  const server = createServer((request, response) => {
    seen.push(`${request.method} ${request.url}`);
    const status = request.url?.includes("pending")
      ? 202
      : request.url?.includes("expired")
        ? 404
        : 200;
    response.writeHead(status, {
      "content-type": "application/json",
      "retry-after": "2",
      "cache-control": "no-store",
    });
    response.end(
      JSON.stringify(
        status === 200 ? { opaque: "<script>not markup</script>" } : { status },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  for (const [id, status] of [
    ["complete", 200],
    ["pending", 202],
    ["expired", 404],
  ] as const) {
    const response = await proxyPackageDetails(id, origin);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("retry-after"), "2");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(
      await response.json(),
      status === 200 ? { opaque: "<script>not markup</script>" } : { status },
    );
  }
  assert.deepEqual(seen, [
    "GET /r/complete.details.json",
    "GET /r/pending.details.json",
    "GET /r/expired.details.json",
  ]);
  const count = seen.length;
  assert.equal((await proxyPackageDetails("../check", origin)).status, 404);
  assert.equal((await proxyPackageDetails("ok", null)).status, 404);
  assert.equal(seen.length, count);
});

test("details proxy reports unreachable and oversized upstreams without leaking response text", async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("x".repeat(4 * 1024 * 1024 + 1));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const response = await proxyPackageDetails("large", origin);
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    error: "Package details unavailable",
  });
  assert.equal(
    (await proxyPackageDetails("unreachable", "http://127.0.0.1:1")).status,
    502,
  );
});
