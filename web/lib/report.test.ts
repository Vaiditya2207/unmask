import assert from "node:assert/strict";
import { test } from "node:test";
import { exampleReport, exampleReports } from "./sample-report.ts";
import {
  buildView,
  FILE_STATES,
  isReport,
  oneLine,
  type Report,
  type ReportView,
} from "./report.ts";

const esbuild = exampleReport("sample") as Report;
const leftPad = exampleReport("sample-no-source") as Report;
const text = (view: ReportView) =>
  view.finding.map((segment) => segment.text).join("");

test("the examples are the real esbuild and left-pad reports", () => {
  assert.deepEqual(esbuild.inputs.claim, {
    name: "esbuild",
    version: "0.28.2",
  });
  assert.deepEqual(leftPad.inputs.claim, {
    name: "left-pad",
    version: "1.0.0",
  });
  assert.equal(exampleReport("constructor"), null);
});

test("state counts add up to the inventory and match the report's own totals", () => {
  for (const [id, report] of Object.entries(exampleReports)) {
    const view = buildView(report);
    const files = FILE_STATES.reduce((n, s) => n + view.counts[s].files, 0);
    const bytes = FILE_STATES.reduce((n, s) => n + view.counts[s].bytes, 0);
    assert.equal(files, report.coverage.inventory.files, id);
    assert.equal(bytes, report.coverage.inventory.bytes, id);
    assert.equal(view.rows.length, report.coverage.inventory.files, id);
    assert.deepEqual(view.counts, report.coverage.states, id);
    assert.deepEqual(view.unresolved, report.coverage.unresolved, id);
    assert.equal(
      view.tabs.find((tab) => tab.id === "all")?.count,
      report.coverage.inventory.files,
    );
  }
});

test("esbuild: four files are not in the source and three are byte-identical", () => {
  const view = buildView(esbuild);
  assert.equal(view.mode, "compared");
  assert.deepEqual(view.counts["artifact-only"], { files: 4, bytes: 142137 });
  assert.deepEqual(view.counts["byte-identical"], { files: 3, bytes: 5224 });
  assert.deepEqual(view.unresolved, { files: 4, bytes: 142137 });
  assert.deepEqual(
    view.rows.map((row) => [row.path, row.state, row.size, row.cueCount]),
    [
      ["install.js", "artifact-only", 11773, 7],
      ["lib/main.js", "artifact-only", 97463, 5],
      ["lib/main.d.ts", "artifact-only", 23551, 0],
      ["bin/esbuild", "artifact-only", 9350, 0],
      ["package.json", "byte-identical", 3980, 2],
      ["LICENSE.md", "byte-identical", 1069, 0],
      ["README.md", "byte-identical", 175, 0],
    ],
  );
  assert.deepEqual(
    view.tabs.map((tab) => [tab.label, tab.count]),
    [
      ["All", 7],
      ["Not in source", 4],
      ["Byte-identical", 3],
    ],
  );
});

test("esbuild: 14 cues reach 3 files through their evidence paths", () => {
  const view = buildView(esbuild);
  assert.equal(view.cueCount, 14);
  assert.equal(view.syntaxCueCount, 12);
  assert.equal(view.cueFiles, 3);
  const byPath = Object.fromEntries(
    view.rows.map((row) => [row.path, row.kindCounts]),
  );
  assert.deepEqual(byPath["lib/main.js"], {
    environment: 3,
    process: 2,
    network: 0,
    other: 0,
  });
  // Both manifest cues bind to package.json: one on the artifact side, one on the source side.
  assert.deepEqual(byPath["package.json"], {
    environment: 0,
    process: 0,
    network: 0,
    other: 2,
  });
  assert.equal(view.rows.find((r) => r.path === "package.json")?.signal, false);
});

test("esbuild: the postinstall script runs install.js, which carries 7 cues", () => {
  const view = buildView(esbuild);
  assert.equal(view.installPaths.length, 1);
  const [install] = view.installPaths;
  assert.equal(install.hook, "postinstall");
  assert.equal(install.command, "node install.js");
  assert.equal(install.file.path, "install.js");
  assert.equal(install.file.state, "artifact-only");
  assert.equal(install.file.cueCount, 7);
  assert.deepEqual(install.file.kindCounts, {
    environment: 1,
    process: 3,
    network: 3,
    other: 0,
  });
  assert.equal(
    install.note,
    "The postinstall command matches the source; the file it runs does not exist there.",
  );
  assert.equal(install.file.runsOnInstall, "postinstall");
  assert.equal(install.file.signal, true);
});

test("esbuild: install.js is selected first and its cues read in byte order", () => {
  const view = buildView(esbuild);
  assert.equal(view.defaultKey, "install.js");
  const file = view.rows[0];
  assert.deepEqual(
    file.groups.map((group) => [
      group.label,
      group.ruleId,
      group.cues.map((cue) => cue.range?.join("–")),
    ]),
    [
      ["Environment", "syntax-environment-access", ["1307–1338"]],
      [
        "Process",
        "syntax-process-execution",
        ["4094–4792", "4994–5052", "7499–7687"],
      ],
      [
        "Network",
        "syntax-network-call",
        ["5969–6399", "6096–6123", "9833–9843"],
      ],
    ],
  );
  const excerpts = file.groups.flatMap((g) => g.cues.map((c) => c.excerpt));
  assert.equal(excerpts[0], "process.env.ESBUILD_BINARY_PATH");
  assert.ok(excerpts[3]?.startsWith("child_process.execSync(`npm install"));
  assert.ok(excerpts.every((e) => e && !e.includes("\n")));
});

test("esbuild: status strip, notes, scope and finding line", () => {
  const view = buildView(esbuild);
  assert.deepEqual(
    view.status.map((cell) => [cell.label, cell.value, cell.aside]),
    [
      ["Integrity", "Matches npm", "(sha512)"],
      ["Source", "Found, complete", null],
      ["Provenance", "Not assessed", null],
      ["Model", "Off", null],
    ],
  );
  const notes = Object.fromEntries(view.rows.map((r) => [r.path, r.note]));
  assert.equal(notes["lib/main.js"], "declared main, content unverified");
  assert.equal(notes["bin/esbuild"], "syntax not inspected");
  assert.equal(notes["install.js"], null);
  assert.equal(notes["README.md"], null);
  assert.deepEqual(view.notInspected, {
    artifact: [
      "lib/main.d.ts",
      "bin/esbuild",
      "package.json",
      "LICENSE.md",
      "README.md",
    ],
    sourceCount: 3,
    reasons: ["unsupported syntax"],
  });
  assert.deepEqual(view.sourceOnly, { paths: [], scope: "npm/esbuild" });
  assert.equal(view.source.repositoryLabel, "github.com/evanw/esbuild");
  assert.equal(
    view.source.href,
    "https://github.com/evanw/esbuild/tree/609683d892977362a0f99026cb74b96263d728a9/npm/esbuild",
  );
  assert.equal(view.source.method, "publisher gitHead");
  assert.equal(view.checkedAt, "2026-10-31T20:35:16.204Z");
  assert.equal(
    text(view),
    "4 of 7 published files are not in the source. install.js runs on install and contains code that reads the environment, starts processes and makes network calls.",
  );
  assert.deepEqual(
    view.finding.filter((s) => s.code).map((s) => s.text),
    ["install.js"],
  );
});

test("exit code 0 is reported as exit 0, never as a verdict of safe", () => {
  for (const report of Object.values(exampleReports)) {
    const view = buildView(report);
    assert.equal(view.policy.exitCode, 0);
    assert.deepEqual(view.policy.findings, []);
    assert.doesNotMatch(JSON.stringify(view), /\bsafe\b/i);
  }
});

test("left-pad@1.0.0: no source, so all 4 files were not compared", () => {
  const view = buildView(leftPad);
  assert.equal(view.mode, "no-source");
  assert.equal(view.source.available, false);
  assert.deepEqual(view.counts["not-compared"], { files: 4, bytes: 889 });
  assert.equal(view.counts["artifact-only"].files, 0);
  assert.deepEqual(
    view.notCompared.map((row) => [row.path, row.size, row.reason]),
    [
      [".npmignore", 30, "source unavailable"],
      ["README.md", 227, "source unavailable"],
      ["index.js", 222, "source unavailable"],
      ["package.json", 410, "source unavailable"],
    ],
  );
  assert.equal(view.status[1].value, "Not found");
  assert.equal(view.installPaths.length, 0);
  assert.equal(view.syntaxCueCount, 0);
  assert.equal(view.cueCount, 3);
  assert.deepEqual(
    view.tabs.map((tab) => [tab.label, tab.count]),
    [
      ["All", 4],
      ["Not in source", 0],
      ["Not compared", 4],
      ["Byte-identical", 0],
    ],
  );
  assert.equal(
    text(view),
    "No source to compare. The registry records no commit for this release; 4 files were not compared.",
  );
});

test("the examples keep no maintainer or publisher address", () => {
  for (const report of Object.values(exampleReports)) {
    const registry = report.manifests.registry.value as {
      _npmUser?: { email?: string };
      maintainers?: { email?: string }[];
    };
    const people = [registry._npmUser, ...(registry.maintainers ?? [])];
    assert.ok(people.length > 1);
    for (const person of people)
      assert.equal(person?.email, "redacted@example.invalid");
  }
});

test("a job body is not a report; a report is", () => {
  assert.equal(isReport(esbuild), true);
  assert.equal(
    isReport({
      id: "a".repeat(32),
      nameAtExactVersion: "ms@2.1.3",
      status: "running",
      createdAt: 1,
    }),
    false,
  );
  assert.equal(isReport({ ...esbuild, schemaVersion: "2" }), false);
});

test("a lifecycle script that is not in the source manifest says so", () => {
  const report = structuredClone(esbuild);
  (report.manifests.source.value as { scripts: object }).scripts = {};
  const [install] = buildView(report).installPaths;
  assert.equal(
    install.note,
    "The postinstall command is not in the source manifest; the file it runs is not in the source.",
  );
});

test("oneLine folds whitespace and keeps code on one line", () => {
  assert.equal(
    oneLine('execSync(\n      `npm i`,\n      { cwd: "x" }\n)'),
    'execSync(`npm i`, { cwd: "x" })',
  );
  assert.equal(oneLine("a".repeat(300), 10), "aaaaaaaaa…");
});
