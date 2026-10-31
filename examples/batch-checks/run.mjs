import { createReadStream } from "node:fs";
import assert from "node:assert/strict";
import { main } from "../../dist/cli/main.mjs";
import { createReport } from "../../dist/core/report.mjs";
import { compareInventories } from "../../dist/core/compare.mjs";

const report = createReport({
  inputs: {
    claim: { name: "fixture", version: "1.0.0" },
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
let current;
process.exitCode = await main(
  ["batch", "--stdin", ...(process.argv.includes("--json") ? ["--json"] : [])],
  {
    env: { UNMASK_SERVER_URL: "https://synthetic.invalid" },
    stdin: createReadStream(new URL("input/specs.txt", import.meta.url)),
    fetchImpl: async (url, options) => {
      if (url === "https://synthetic.invalid/check") {
        current = options.body.get("package");
        assert.ok(["fixture@1.0.0", "missing@1.0.0"].includes(current));
        return new Response(null, {
          status: 303,
          headers: { location: "/r/" + "a".repeat(32) },
        });
      }
      assert.equal(
        url,
        "https://synthetic.invalid/r/" + "a".repeat(32) + ".json",
      );
      return current === "missing@1.0.0"
        ? new Response(null, { status: 404 })
        : Response.json(report);
    },
  },
);
