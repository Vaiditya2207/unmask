import { once } from "node:events";
import { createApp } from "../../src/server/app.mjs";
import {
  explorerReport,
  runExplorer,
} from "../../tests/fixtures/package-explorer.mjs";

const server = createApp({
  versionInfo: {
    version: "0.0.0",
    commit: "b".repeat(40),
    tarballSha256: "c".repeat(64),
  },
  runAnalysis: async () => explorerReport(true),
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
try {
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const args of [
    ["info", "example@1.2.3"],
    ["files", "example@1.2.3", "--state", "changed", "--limit", "2"],
  ]) {
    const result = await runExplorer(args, origin);
    if (result.code !== 0) throw new Error(result.stderr);
    process.stdout.write(`$ unmask ${args.join(" ")}\n${result.stdout}\n`);
  }
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
