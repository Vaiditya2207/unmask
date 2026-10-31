import assert from "node:assert/strict";
import { once } from "node:events";
import { createApp } from "../../src/server/app.mjs";
import {
  explorerReport,
  runExplorer,
} from "../../tests/fixtures/package-explorer.mjs";

let submissions = 0,
  analyses = 0;
const server = createApp({
  versionInfo: {
    version: "0.0.0",
    commit: "b".repeat(40),
    tarballSha256: "c".repeat(64),
  },
  runAnalysis: async () => {
    analyses++;
    return explorerReport(true);
  },
});
server.on("request", (req) => {
  if (req.method === "POST") submissions++;
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
try {
  const origin = `http://127.0.0.1:${server.address().port}`;
  const show = async (args) => {
    const result = await runExplorer(args, origin);
    if (result.code !== 0) throw new Error(result.stderr);
    process.stdout.write(`$ unmask ${args.join(" ")}\n${result.stdout}\n`);
    return result;
  };
  const info = await show(["info", "example@1.2.3"]);
  const reportId = /Report: .*\/r\/([a-f0-9]{32})\.json/.exec(info.stdout)?.[1];
  assert.ok(reportId);
  for (const offset of ["0", "2"]) {
    const result = await show([
      "files",
      "example@1.2.3",
      "--report",
      reportId,
      "--limit",
      "2",
      "--offset",
      offset,
    ]);
    assert.ok(result.stdout.includes(`Report ID: ${reportId}`));
  }
  assert.equal(submissions, 1);
  assert.equal(analyses, 1);
  process.stdout.write(
    "Verified: one submission and one analysis; subsequent pages reused the stored report.\n",
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
