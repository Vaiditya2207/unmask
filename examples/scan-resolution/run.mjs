import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { main } from "../../dist/cli/main.mjs";
import { createReport } from "../../dist/core/report.mjs";
import { compareInventories } from "../../dist/core/compare.mjs";

const input = JSON.parse(
  await readFile(new URL("input/registry.json", import.meta.url), "utf8"),
);
const report = createReport({
  inputs: {
    claim: input.registry,
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
report.model = { status: "unavailable", reason: "synthetic-example-no-model" };
process.exitCode = await main(["scan", input.package], {
  env: { UNMASK_SERVER_URL: "https://synthetic.invalid" },
  fetchImpl: async (url, options) => {
    if (url === "https://registry.npmjs.org/fixture/latest")
      return Response.json(input.registry);
    if (url === "https://synthetic.invalid/check") {
      assert.equal(options.body.get("package"), "fixture@1.2.3");
      return new Response(null, {
        status: 303,
        headers: { location: "/r/" + "a".repeat(32) },
      });
    }
    assert.equal(
      url,
      "https://synthetic.invalid/r/" + "a".repeat(32) + ".json",
    );
    return Response.json(report);
  },
});
