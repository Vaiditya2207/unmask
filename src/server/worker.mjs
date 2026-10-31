import { lstat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parsePackageSpec } from "../core/acquire.mjs";
import { validateReport } from "../core/report.mjs";

export async function workerMain() {
  let input = "";
  for await (const chunk of process.stdin) {
    if (Buffer.byteLength(input) + chunk.length > 8192)
      throw new Error("invalid-worker-request");
    input += chunk.toString("utf8");
  }
  const request = JSON.parse(input);
  if (
    !request ||
    typeof request !== "object" ||
    Array.isArray(request) ||
    Object.keys(request).some(
      (key) => !["spec", "workDir", "maxResultBytes"].includes(key),
    ) ||
    typeof request.workDir !== "string" ||
    request.workDir !== process.cwd() ||
    !/^job-[a-f0-9]{32}$/.test(path.basename(request.workDir)) ||
    !Number.isSafeInteger(request.maxResultBytes) ||
    request.maxResultBytes < 1 ||
    request.maxResultBytes > 67108864
  )
    throw new Error("invalid-worker-request");
  parsePackageSpec(request.spec);
  const stat = await lstat(request.workDir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077)
    throw new Error("invalid-worker-directory");
  const { analyzeRegistry } = await import("../core/online.mjs");
  const report = validateReport(
    await analyzeRegistry(request.spec, {
      workDir: request.workDir,
      persistCache: false,
    }),
  );
  report.run.surface = "web";
  const result = JSON.stringify(report);
  if (Buffer.byteLength(result) > request.maxResultBytes)
    throw new Error("analysis-result-cap");
  await writeFile(path.join(request.workDir, "report.json"), result, {
    flag: "wx",
    mode: 0o600,
  });
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
)
  workerMain().catch(() => {
    process.exitCode = 1;
  });
