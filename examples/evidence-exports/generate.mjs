// Regenerates the inert inputs and actual outputs for this example; nothing in the generated packages is executed.
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import tar from "tar-stream";
import { createApp } from "../../src/server/app.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const input = path.join(here, "input");
const output = path.join(here, "output");
const p08 = process.argv[2] === "--p08" ? path.resolve(process.argv[3]) : null;
const commit = "0123456789abcdef0123456789abcdef01234567";

async function archive(files, prefix) {
  const pack = tar.pack();
  const chunks = [];
  const drain = (async () => {
    for await (const chunk of pack) chunks.push(chunk);
  })();
  for (const [name, body] of Object.entries(files))
    pack.entry({ name: `${prefix}/${name}`, mtime: new Date(0) }, body);
  pack.finalize();
  await drain;
  return gzipSync(Buffer.concat(chunks), { level: 9 });
}

const manifest = (name, version) =>
  JSON.stringify({
    name,
    version,
    dependencies: { "@unmask-example/helper": "^1.0.0" },
    bundledDependencies: ["inner"],
  });
const files = (name, version) => ({
  "package.json": manifest(name, version),
  "index.js": "module.exports = 1;\n",
  "node_modules/inner/index.js": "module.exports = 2;\n",
  "node_modules/inner/node_modules/deep/index.js": "module.exports = 3;\n",
});

mkdirSync(input, { recursive: true });
mkdirSync(output, { recursive: true });
const write = (name, bytes) => writeFileSync(path.join(input, name), bytes);
write(
  "matching.tgz",
  await archive(files("@unmask-example/widget", "1.0.0"), "package"),
);
write(
  "matching-source.tgz",
  await archive(files("@unmask-example/widget", "1.0.0"), "source"),
);
write(
  "conflict.tgz",
  await archive(files("@unmask-example/declared", "2.0.0"), "package"),
);
const advisory = (status, advisories, reasons = []) => ({
  schemaVersion: "1",
  source: "OSV",
  package: {
    name: "@unmask-example/requested",
    version: "1.0.0",
    ecosystem: "npm",
  },
  queriedAt: "2026-11-01T00:00:00.000Z",
  status,
  complete: ["found", "none-reported"].includes(status),
  reasons,
  advisories,
  pagesFetched: 1,
  limits: {},
});
write(
  "osv-partial.json",
  JSON.stringify(
    advisory(
      "incomplete",
      [
        {
          id: "GHSA-0000-0000-0001",
          summary: "Synthetic advisory whose only MAL id is an alias",
          aliases: ["MAL-0000-0001"],
        },
        {
          id: "MAL-0000-0002",
          summary: "Synthetic withdrawn malicious-package advisory",
          aliases: [],
          withdrawn: "2026-10-01T00:00:00Z",
        },
      ],
      ["page-limit"],
    ),
    null,
    2,
  ) + "\n",
);
write(
  "osv-none.json",
  JSON.stringify(advisory("none-reported", []), null, 2) + "\n",
);

const cache = mkdtempSync(path.join(tmpdir(), "unmask-example-"));
function check(name, args) {
  const out = path.join(cache, name);
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "src/cli/main.mjs"),
      "check",
      "--offline",
      "--cache-dir",
      path.join(cache, "blobs"),
      "--out",
      out,
      ...args,
    ],
    { encoding: "utf8" },
  );
  if (![0, 2, 3].includes(result.status)) throw new Error(result.stderr);
  const report = readFileSync(path.join(out, "report.json"), "utf8");
  writeFileSync(path.join(output, `${name}.report.json`), report);
  return { exit: result.status, report: JSON.parse(report) };
}
const runs = {
  matching: check("matching", [
    "--tarball",
    path.join(input, "matching.tgz"),
    "--source-archive",
    path.join(input, "matching-source.tgz"),
    "--commit",
    commit,
    "--source-root",
    "source",
    "--claim",
    "@unmask-example/widget@1.0.0",
  ]),
  conflict: check("conflict", [
    "--tarball",
    path.join(input, "conflict.tgz"),
    "--claim",
    "@unmask-example/requested@1.0.0",
  ]),
};

const log = [];
for (const [name, run] of Object.entries(runs)) {
  const app = createApp({
    versionInfo: { version: "example", commit, tarballSha256: "0".repeat(64) },
    runAnalysis: async () => run.report,
    clock: { now: () => Date.UTC(2026, 10, 1), setTimeout, clearTimeout },
  });
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  const origin = `http://127.0.0.1:${app.address().port}`;
  const posted = await fetch(`${origin}/check`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      package:
        run.report.inputs.claim.name + "@" + run.report.inputs.claim.version,
    }),
  });
  const location = posted.headers.get("location");
  while ((await fetch(origin + location + ".json")).status === 202)
    await new Promise((resolve) => setTimeout(resolve, 20));
  log.push(`${name}: unmask check exit ${run.exit}`);
  for (const suffix of ["cdx.json", "evidence.json"]) {
    const response = await fetch(`${origin}${location}.${suffix}`);
    const body = JSON.stringify(await response.json(), null, 2) + "\n";
    writeFileSync(
      path.join(output, `${name}.${suffix}`),
      body.replaceAll(location.slice(3), "<report-id>"),
    );
    log.push(
      `${name}: GET /r/<report-id>.${suffix} -> ${response.status} ${response.headers.get("content-type")}`,
    );
  }
  app.closeAllConnections();
  app.close();
}

if (p08) {
  const sarifDir = path.join(output, "sarif");
  mkdirSync(sarifDir, { recursive: true });
  for (const [label, details] of [
    ["conflict-partial", "osv-partial.json"],
    ["conflict-none", "osv-none.json"],
  ]) {
    const report = path.join(output, "conflict.report.json");
    const args = ["--report", report, "--details", path.join(input, details)];
    const sarif = spawnSync(
      process.execPath,
      [path.join(p08, "src/cli/main.mjs"), "sarif", ...args],
      { encoding: "utf8" },
    );
    writeFileSync(path.join(sarifDir, `${label}.sarif`), sarif.stdout);
    const summary = path.join(sarifDir, `${label}.summary.md`);
    rmSync(summary, { force: true });
    const annotations = spawnSync(
      process.execPath,
      [
        path.join(p08, "src/cli/main.mjs"),
        "annotations",
        ...args,
        "--summary",
        summary,
      ],
      { encoding: "utf8" },
    );
    writeFileSync(
      path.join(sarifDir, `${label}.annotations.txt`),
      annotations.stdout,
    );
    log.push(
      `${label}: unmask sarif exit ${sarif.status}; unmask annotations exit ${annotations.status}`,
    );
  }
}
writeFileSync(path.join(output, "commands.log"), log.join("\n") + "\n");
rmSync(cache, { recursive: true, force: true });
console.log(log.join("\n"));
