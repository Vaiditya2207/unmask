import assert from "node:assert/strict";
import { test } from "node:test";
import { main } from "../../src/cli/main.mjs";
import { createReport } from "../../src/core/report.mjs";
import { compareInventories } from "../../src/core/compare.mjs";
import { resolveScanSpec } from "../../src/cli/scan.mjs";

function report(name = "fixture", version = "1.2.3") {
  return createReport({
    inputs: {
      claim: { name, version },
      artifact: { sha256: "a".repeat(64), sha512: "b".repeat(128) },
      limits: { maxEntries: 20000 },
    },
    source: { status: "unresolved", method: "unresolved", alternatives: [] },
    comparison: compareInventories(
      {
        digest: { sha256: "a".repeat(64) },
        entries: [],
        complete: true,
        failures: [],
      },
      null,
    ),
    manifests: {
      artifact: { status: "unavailable" },
      source: { status: "unavailable" },
      registry: { status: "unavailable" },
    },
  });
}

test("scan resolves latest then submits only the exact pinned identity", async () => {
  const urls = [];
  let output = "";
  const code = await main(["scan", "fixture", "--json"], {
    env: { UNMASK_SERVER_URL: "https://synthetic.invalid" },
    stdout: { write: (text) => (output += text) },
    fetchImpl: async (url, options) => {
      urls.push(url);
      if (url === "https://registry.npmjs.org/fixture/latest")
        return Response.json({ name: "fixture", version: "1.2.3" });
      if (url === "https://synthetic.invalid/check") {
        assert.equal(options.body.get("package"), "fixture@1.2.3");
        return new Response(null, {
          status: 303,
          headers: { location: "/r/" + "a".repeat(32) },
        });
      }
      return Response.json(report());
    },
  });
  assert.equal(code, 0);
  assert.equal(urls.length, 3);
  const result = JSON.parse(output);
  assert.equal(result.resolution.spec, "fixture@1.2.3");
  assert.equal(result.resolution.selector, "latest");
  assert.equal(result.report.inputs.claim.version, "1.2.3");
});

test("scoped tags stay on the fixed npm origin and exact specs skip resolution", async () => {
  const resolved = await resolveScanSpec("@scope/fixture@next", {
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://registry.npmjs.org/%40scope%2Ffixture/next");
      assert.equal(options.redirect, "error");
      assert.equal(options.credentials, "omit");
      return Response.json({ name: "@scope/fixture", version: "2.0.0-rc.1" });
    },
  });
  assert.equal(resolved.spec, "@scope/fixture@2.0.0-rc.1");
  assert.ok(Number.isFinite(Date.parse(resolved.observedAt)));
  const exact = await resolveScanSpec("@scope/fixture@1.0.0+build.1", {
    fetchImpl: () => assert.fail("exact specs must not resolve a mutable tag"),
  });
  assert.equal(exact.spec, "@scope/fixture@1.0.0+build.1");
  assert.equal(exact.registryUrl, null);
});

for (const spec of [
  "fixture@^1.0.0",
  "fixture@1.x",
  "fixture@*",
  "fixture@",
  "fixture@>=1",
  "fixture;echo",
  "https://example.invalid/a",
  "../fixture",
  "fixture\u001b[31m",
]) {
  test(
    "scan rejects unsupported or unsafe input without network: " +
      JSON.stringify(spec),
    async () => {
      await assert.rejects(
        resolveScanSpec(spec, {
          fetchImpl: () =>
            assert.fail("invalid input must not access the network"),
        }),
        (error) =>
          ["invalid-package-spec", "unsupported-selector"].includes(error.code),
      );
    },
  );
}

for (const [label, response, code] of [
  [
    "name mismatch",
    () => Response.json({ name: "other", version: "1.2.3" }),
    "registry-identity-mismatch",
  ],
  [
    "range response",
    () => Response.json({ name: "fixture", version: "^1.2.3" }),
    "invalid-registry-document",
  ],
  [
    "missing version",
    () => Response.json({ name: "fixture" }),
    "registry-identity-mismatch",
  ],
  ["malformed JSON", () => new Response("{"), "invalid-registry-document"],
  [
    "invalid UTF-8",
    () => new Response(new Uint8Array([0xff])),
    "invalid-registry-document",
  ],
  [
    "redirect",
    () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://example.invalid" },
      }),
    "redirect-refused",
  ],
  ["not found", () => new Response(null, { status: 404 }), "http-status"],
  [
    "declared body cap",
    () => new Response("{}", { headers: { "content-length": "1048577" } }),
    "response-cap",
  ],
  ["stream body cap", () => new Response("x".repeat(1048577)), "response-cap"],
]) {
  test("scan rejects registry " + label, async () => {
    await assert.rejects(
      resolveScanSpec("fixture", { fetchImpl: async () => response() }),
      { code },
    );
  });
}

test("scan cancellation aborts before fetching and does not attempt a hosted check", async () => {
  await assert.rejects(
    resolveScanSpec("fixture", {
      signal: AbortSignal.abort(),
      fetchImpl: () => assert.fail("already cancelled"),
    }),
    { code: "acquisition-aborted" },
  );
});

test("scan resolution has a deadline even when fetch never settles", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = resolveScanSpec("fixture", {
    fetchImpl: () => new Promise(() => {}),
  });
  t.mock.timers.tick(15000);
  await assert.rejects(pending, { code: "acquisition-timeout" });
});

test("terminal output names the pin before a failed hosted request and escapes model controls", async () => {
  let output = "";
  const runtime = {
    env: { UNMASK_SERVER_URL: "https://synthetic.invalid" },
    stdout: { write: (text) => (output += text) },
    fetchImpl: async () => new Response(null, { status: 503 }),
  };
  assert.equal(await main(["scan", "fixture@1.2.3"], runtime), 2);
  assert.match(output, /Pinned fixture@1.2.3 -> fixture@1.2.3/);
  assert.doesNotMatch(output, /Completed/);
  const value = report();
  value.model = { status: "unavailable\u001b[2J\nforged\u009b2J" };
  runtime.fetchImpl = async (_url, options) =>
    options.method === "POST"
      ? new Response(null, {
          status: 303,
          headers: { location: "/r/" + "a".repeat(32) },
        })
      : Response.json(value);
  output = "";
  assert.equal(await main(["scan", "fixture@1.2.3"], runtime), 0);
  assert.doesNotMatch(output, /\u001b/);
  assert.doesNotMatch(output, /\u009b/);
  assert.match(output, /No findings do not establish safety/);
});

test("scan refuses a hosted report for a different version", async () => {
  let output = "";
  assert.equal(
    await main(["scan", "fixture@1.2.3", "--json"], {
      env: { UNMASK_SERVER_URL: "https://synthetic.invalid" },
      stdout: { write: (text) => (output += text) },
      fetchImpl: async (_url, options) =>
        options.method === "POST"
          ? new Response(null, {
              status: 303,
              headers: { location: "/r/" + "a".repeat(32) },
            })
          : Response.json(report("fixture", "9.9.9")),
    }),
    2,
  );
  assert.equal(output, "");
});
