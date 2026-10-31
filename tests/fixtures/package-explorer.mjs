import { once } from "node:events";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { compareInventories } from "../../src/core/compare.mjs";
import { createReport } from "../../src/core/report.mjs";

export function explorerReport() {
  const manifest = {
    name: "example",
    version: "1.2.3",
    description: "text\u001b[31m\nspoof",
    license: "MIT",
    dependencies: { alpha: "^1" },
    scripts: { install: "echo inert\u001b]0;title\u0007" },
  };
  const entries = Object.entries({
    "package.json": JSON.stringify(manifest),
    "index.js": "inert text",
    "src/evil\u001b[31m.js": "more inert text",
    "README.md": "documentation",
  }).map(([path, text]) => ({
    path,
    originalPath: `package/${path}`,
    type: "file",
    content: Buffer.from(text),
    size: Buffer.byteLength(text),
    sha256: createHash("sha256").update(text).digest("hex"),
    inspection: "retained",
  }));
  const comparison = compareInventories(
    {
      digest: { sha256: "a".repeat(64) },
      complete: true,
      entries,
      failures: [],
    },
    null,
  );
  return createReport({
    inputs: {
      limits: { maxEntries: 20000 },
      artifact: { sha256: "a".repeat(64), sha512: "b".repeat(128) },
      claim: { name: "example", version: "1.2.3" },
    },
    source: { status: "unresolved", method: "unresolved", alternatives: [] },
    comparison,
    manifests: {
      artifact: {
        status: "usable",
        value: manifest,
        evidenceIds: comparison.files.find((f) => f.path === "package.json")
          .evidenceIds,
      },
      source: { status: "unavailable" },
      registry: { status: "unavailable" },
    },
  });
}

export async function runExplorer(args, origin, built = false) {
  const child = spawn(
    process.execPath,
    [
      new URL(`../../${built ? "dist" : "src"}/cli/main.mjs`, import.meta.url)
        .pathname,
      ...args,
    ],
    {
      env: { PATH: process.env.PATH, UNMASK_SERVER_URL: origin },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  try {
    const [code] = await once(child, "exit");
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}
