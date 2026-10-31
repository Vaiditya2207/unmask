import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  mkdir,
  symlink,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import tar from "tar-stream";
import { analyzeLocal } from "../../src/core/pipeline.mjs";
import {
  escapeData,
  escapeProperty,
  escapeMarkdown,
} from "../../src/cli/annotations.mjs";

const entrypoint = fileURLToPath(
  new URL("../../src/cli/main.mjs", import.meta.url),
);
const hostile = "evil\r\n::error::pwned\n::stop-commands::tok%0A\u001b[31m";
async function archive(files, prefix) {
  const pack = tar.pack(),
    chunks = [];
  const drain = (async () => {
    for await (const chunk of pack) chunks.push(chunk);
  })();
  for (const [name, body] of Object.entries(files))
    pack.entry({ name: `${prefix}/${name}`, mtime: new Date(0) }, body);
  pack.finalize();
  await drain;
  return gzipSync(Buffer.concat(chunks));
}
async function fixture(t, { mutation = false, claim = undefined } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "unmask-annotations-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = { name: "fixture", version: "1.0.0" };
  const artifact = path.join(root, "artifact.tgz"),
    source = path.join(root, "source.tgz");
  const code = 'require("child_process").exec("id");\n';
  await writeFile(
    artifact,
    await archive(
      {
        "package.json": JSON.stringify({
          ...manifest,
          ...(mutation ? { scripts: { postinstall: "node run.js" } } : {}),
        }),
        "run.js": code,
        "x\n::warning::injected%,:.js": code,
      },
      "package",
    ),
  );
  await writeFile(
    source,
    await archive({ "package.json": JSON.stringify(manifest) }, "root"),
  );
  const report = await analyzeLocal({
    tarballPath: artifact,
    sourceArchivePath: source,
    commit: "a".repeat(40),
    sourceRoot: "root",
    cacheDir: path.join(root, "cache"),
    claim: claim ?? manifest,
  });
  report.cues.push({ ruleId: hostile, summary: hostile, evidenceIds: [] });
  const reportPath = path.join(root, "report.json");
  await writeFile(reportPath, JSON.stringify(report));
  return { root, reportPath };
}
const cli = (args) =>
  spawnSync(process.execPath, [entrypoint, ...args], {
    encoding: "utf8",
    timeout: 10000,
    env: { PATH: process.env.PATH },
  });
const osv = (status, advisories) => ({
  schemaVersion: "1",
  source: "OSV",
  package: { ecosystem: "npm", name: "fixture", version: "1.0.0" },
  queriedAt: "2026-11-01T00:00:00.000Z",
  status,
  complete: ["found", "none-reported"].includes(status),
  reasons: ["found", "none-reported"].includes(status) ? [] : ["timeout"],
  advisories,
  pagesFetched: 1,
  limits: {},
});

test("workflow command escaping neutralizes newlines, percent, delimiters and terminal controls", () => {
  assert.equal(escapeData("a%b\r\nc\u001b[0m"), "a%25b%0D%0Ac\\u001b[0m");
  assert.equal(escapeProperty("t:1,2"), "t%3A1%2C2");
  assert.equal(
    escapeMarkdown("<img src=x>|`[a](b)`\n#"),
    "\\<img src\\=x\\>\\|\\`\\[a\\]\\(b\\)\\` \\#",
  );
});

test("unmask annotations emits one escaped workflow command per line from a real report and keeps policy exit", async (t) => {
  const { reportPath } = await fixture(t, { mutation: true });
  const result = cli(["annotations", "--report", reportPath]);
  assert.equal(result.status, 3, result.stderr);
  const lines = result.stdout.trimEnd().split("\n");
  for (const line of lines)
    assert.match(line, /^::(error|warning|notice) title=[^\r\n:,]*::[^\r\n]*$/);
  assert.ok(
    lines.some((line) =>
      line.startsWith("::error title=unmask policy/lifecycle-source-absent::"),
    ),
  );
  assert.ok(lines.some((line) => line.includes("cue/unrecognized")));
  assert.ok(
    !lines.some((line) => /^::(stop-commands|error::pwned)/.test(line)),
  );
  assert.ok(!result.stdout.includes("\u001b") && !result.stdout.includes("\r"));
  assert.ok(
    lines.some((line) =>
      line.includes("[artifact x%0A::warning::injected%25,:.js bytes"),
    ),
  );
  assert.ok(!/startLine|line=|file=/.test(result.stdout));
});

test("advisories and incomplete checks raise CI exit codes and the summary file is appended with escaped markdown", async (t) => {
  const { root, reportPath } = await fixture(t);
  const details = path.join(root, "details.json");
  await writeFile(
    details,
    JSON.stringify({
      vulnerabilityCheck: osv("found", [
        { id: "MAL-2026-9", summary: "<script>alert(1)</script>\n::error::x" },
      ]),
    }),
  );
  const summary = path.join(root, "summary.md");
  await writeFile(summary, "previous\n");
  const found = cli([
    "annotations",
    "--report",
    reportPath,
    "--details",
    details,
    "--summary",
    summary,
  ]);
  assert.equal(found.status, 3, found.stderr);
  assert.match(
    found.stdout,
    /^::error title=unmask advisory\/known-malware::MAL-2026-9: <script>alert\(1\)<\/script>%0A::error::x/m,
  );
  const markdown = await readFile(summary, "utf8");
  assert.ok(markdown.startsWith("previous\n## UNMASK check: fixture@1.0.0\n"));
  assert.doesNotMatch(markdown, /(^|[^\\])</m);
  assert.match(markdown, /\| Advisory check \| found \|/);
  assert.match(markdown, /Absence of results does not establish/);
  await writeFile(details, JSON.stringify(osv("unavailable", [])));
  const partial = cli([
    "annotations",
    "--report",
    reportPath,
    "--details",
    details,
  ]);
  assert.equal(partial.status, 2, partial.stderr);
  assert.match(
    partial.stdout,
    /^::warning title=unmask advisory\/incomplete::/m,
  );
  const clean = cli(["annotations", "--report", reportPath]);
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(
    clean.stdout,
    /^::notice title=unmask advisory\/not-supplied::/m,
  );
  const dir = path.join(root, "dir");
  await mkdir(dir);
  const refused = cli([
    "annotations",
    "--report",
    reportPath,
    "--summary",
    dir,
  ]);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /^output-write-failed:/);
  const target = path.join(root, "target.md");
  await writeFile(target, "keep\n");
  const link = path.join(root, "link.md");
  await symlink(target, link);
  const followed = cli([
    "annotations",
    "--report",
    reportPath,
    "--summary",
    link,
  ]);
  assert.equal(followed.status, 2);
  assert.equal(await readFile(target, "utf8"), "keep\n");
  const fifo = path.join(root, "summary.fifo");
  assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
  const blocked = cli([
    "annotations",
    "--report",
    reportPath,
    "--summary",
    fifo,
  ]);
  assert.equal(blocked.status, 2, blocked.stderr);
});

test("an incomplete advisory check carrying an aliased malware advisory still annotates an error and exits 3", async (t) => {
  const { root, reportPath } = await fixture(t);
  const details = path.join(root, "details.json");
  await writeFile(
    details,
    JSON.stringify(
      osv("incomplete", [
        { id: "GHSA-gggg-hhhh-iiii", aliases: ["MAL-2026-0002"] },
      ]),
    ),
  );
  const result = cli([
    "annotations",
    "--report",
    reportPath,
    "--details",
    details,
  ]);
  assert.equal(result.status, 3, result.stderr);
  assert.match(
    result.stdout,
    /^::error title=unmask advisory\/known-malware::GHSA-gggg-hhhh-iiii/m,
  );
  assert.match(
    result.stdout,
    /^::warning title=unmask advisory\/incomplete::/m,
  );
});

test("summary heading and table flag a claim that conflicts with the artifact manifest", async (t) => {
  const { root, reportPath } = await fixture(t, {
    claim: { name: "lodash", version: "4.17.21" },
  });
  const details = path.join(root, "lodash.json");
  await writeFile(
    details,
    JSON.stringify({
      ...osv("none-reported", []),
      package: { ecosystem: "npm", name: "lodash", version: "4.17.21" },
    }),
  );
  const summary = path.join(root, "conflict.md");
  const result = cli([
    "annotations",
    "--report",
    reportPath,
    "--details",
    details,
    "--summary",
    summary,
  ]);
  assert.equal(result.status, 3, result.stderr);
  assert.match(
    result.stdout,
    /^::warning title=unmask advisory\/identity-conflict::Advisories were queried for the requested identity lodash@4\.17\.21/m,
  );
  const markdown = await readFile(summary, "utf8");
  const heading = markdown.split("\n")[0];
  assert.ok(heading.startsWith("## UNMASK check: lodash@4.17.21 "), heading);
  assert.ok(
    heading.includes("claimed; artifact declares fixture@1.0.0"),
    heading,
  );
  assert.ok(
    markdown.includes("| Identity | claim\\-conflicts\\-with\\-manifest |"),
  );
  assert.ok(
    markdown.includes(
      "| Advisory check | none\\-reported \\(for requested identity\\) |",
    ),
  );
});
