import { readFileSync } from "node:fs";
import { once } from "node:events";
import { createApp } from "../../src/server/app.mjs";

const bytes = readFileSync(new URL("./input/history.json", import.meta.url));
const app = createApp({
  versionInfo: {
    version: "fixture",
    commit: "fixture",
    tarballSha256: "fixture",
  },
  runAnalysis: async () => {
    throw new Error("No artifact analysis in metadata demo");
  },
  registryFacts: { fetchImpl: async () => new Response(bytes) },
});
app.listen(0, "127.0.0.1");
await once(app, "listening");
try {
  const response = await fetch(
    `http://127.0.0.1:${app.address().port}/api/registry/history?package=example&limit=4`,
  );
  if (!response.ok)
    throw new Error(`Fixture request failed: ${response.status}`);
  process.stdout.write(JSON.stringify(await response.json(), null, 2) + "\n");
} finally {
  app.closeAllConnections();
  await new Promise((resolve) => app.close(resolve));
}
