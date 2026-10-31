import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import tar from "tar-stream";
import { createApp } from "../../src/server/app.mjs";
import { analyzeLocal } from "../../src/core/pipeline.mjs";
import {
  createProgress,
  renderCheckSummary,
  safeText,
} from "../../src/cli/terminal.mjs";
import { main } from "../../src/cli/main.mjs";

const entrypoint = fileURLToPath(
  new URL("../../src/cli/main.mjs", import.meta.url),
);
const versionInfo = {
  version: "0.0.0",
  commit: "b".repeat(40),
  tarballSha256: "c".repeat(64),
};
async function temp(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "unmask-terminal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function archive(manifest, prefix) {
  const pack = tar.pack(),
    chunks = [];
  const drain = (async () => {
    for await (const chunk of pack) chunks.push(chunk);
  })();
  pack.entry(
    { name: `${prefix}/package.json`, mtime: new Date(0) },
    JSON.stringify(manifest),
  );
  pack.finalize();
  await drain;
  return gzipSync(Buffer.concat(chunks));
}
async function fixture(t, lifecycle = false) {
  const root = await temp(t);
  const manifest = { name: "fixture", version: "1.0.0" };
  const paths = {
    tarballPath: path.join(root, "artifact.tgz"),
    sourceArchivePath: path.join(root, "source.tgz"),
  };
  await writeFile(
    paths.tarballPath,
    await archive(
      lifecycle
        ? { ...manifest, scripts: { install: "inert synthetic text" } }
        : manifest,
      "package",
    ),
  );
  await writeFile(paths.sourceArchivePath, await archive(manifest, "root"));
  return { root, manifest, ...paths };
}
async function run(args, { cwd, env = {} }) {
  const child = spawn(process.execPath, [entrypoint, ...args], {
    cwd,
    env: { PATH: process.env.PATH, UNMASK_MODEL: "off", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  try {
    const [code] = await once(child, "exit");
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

test("hosted check without --out prints AI, advisories, coverage and next actions and writes no files", async (t) => {
  const f = await fixture(t, true);
  const report = await analyzeLocal({
    tarballPath: f.tarballPath,
    sourceArchivePath: f.sourceArchivePath,
    sourceRoot: "root",
    commit: "d".repeat(40),
    claim: f.manifest,
  });
  report.model = {
    status: "complete",
    summary: "The artifact adds an install script absent from source.",
    assessment: {
      source: "model",
      summary: "The artifact adds an install script absent from source.",
      checkedScope: "package.json lifecycle scripts",
      uncertainty: "Script intent is not executed or verified.",
      nextAction: "Compare the install script with the upstream repository.",
    },
    hypotheses: [
      {
        explanation: "Install script added only in the artifact.",
        evidenceIds: [],
      },
    ],
  };
  const server = createApp({
    versionInfo,
    runAnalysis: async () => report,
    enrichJob: async () => ({
      schemaVersion: "1",
      source: "OSV",
      package: { ecosystem: "npm", name: "fixture", version: "1.0.0" },
      queriedAt: new Date(0).toISOString(),
      status: "found",
      complete: true,
      reasons: [],
      advisories: [
        {
          id: "GHSA-test-0001",
          summary: "Embedded malicious code",
          databaseSeverity: "CRITICAL",
        },
      ],
      pagesFetched: 1,
      limits: {},
    }),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const cwd = await temp(t);
  const result = await run(["check", "fixture@1.0.0"], {
    cwd,
    env: { UNMASK_SERVER_URL: `http://127.0.0.1:${server.address().port}` },
  });
  assert.equal(result.code, 3, result.stderr);
  assert.deepEqual(await readdir(cwd), []);
  for (const pattern of [
    /^UNMASK fixture@1\.0\.0$/m,
    /Deterministic findings need review \(exit 3\)/,
    /Coverage  complete: 1 file, /,
    /lifecycle-source-absent \(script install\)/,
    /Advisory  1 known for this exact version \(OSV\)/,
    /GHSA-test-0001 \[CRITICAL\] Embedded malicious code/,
    /AI        complete, 1 hypothesis/,
    /Summary: The artifact adds an install script absent from source\./,
    /Scope: package\.json lifecycle scripts/,
    /Uncertainty: Script intent is not executed or verified\./,
    /AI suggests: Compare the install script with the upstream repository\./,
    /Install script added only in the artifact\./,
    /do not install this version/,
    /Add --out DIR/,
  ])
    assert.match(result.stdout, pattern);
});

test("offline check without --out keeps exit semantics, reports AI consent and creates no report files", async (t) => {
  const f = await fixture(t);
  const result = await run(
    [
      "check",
      "--offline",
      "--tarball",
      f.tarballPath,
      "--source-archive",
      f.sourceArchivePath,
      "--commit",
      "a".repeat(40),
      "--source-root",
      "root",
      "--cache-dir",
      path.join(f.root, "cache"),
    ],
    { cwd: f.root },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual((await readdir(f.root)).sort(), [
    "artifact.tgz",
    "cache",
    "source.tgz",
  ]);
  assert.match(result.stdout, /No deterministic findings/);
  assert.match(
    result.stdout,
    /AI        not-sent \(consent-required\); no AI summary/,
  );
  assert.match(result.stdout, /Advisory  not assessed in this check/);
  assert.match(result.stdout, /not proof of safety/);
});

test("structured AI checked scope renders bounded counts and unchecked areas", () => {
  const summary = renderCheckSummary(
    {
      inputs: { claim: { name: "fixture", version: "1.0.0" } },
      coverage: {
        complete: true,
        inventory: { files: 1, bytes: 1 },
        states: {},
      },
      policy: { exitCode: 0, findings: [] },
      model: {
        status: "complete",
        summary: "One file compared.",
        hypotheses: [],
        assessment: {
          source: "model",
          uncertainty: "Runtime behavior was not observed.",
          nextAction: "Review the install script.",
          checkedScope: {
            basis: "deterministic-prompt-selection",
            evidenceSupplied: 3,
            evidenceOmitted: 1,
            notChecked: ["runtime-behavior", "omitted-evidence\u001b[2J"],
          },
        },
      },
    },
    { style: { paint: (_name, text) => text } },
  );
  assert.match(
    summary,
    /Scope: 3 evidence items supplied, 1 omitted; not checked: runtime-behavior, omitted-evidence\\u001b\[2J/,
  );
  assert.match(summary, /Uncertainty: Runtime behavior was not observed\./);
  assert.match(summary, /AI suggests: Review the install script\./);
});

test("summary escapes terminal control characters and never claims safety for unavailable AI or advisories", () => {
  assert.equal(safeText("a\u001b[31mb\u202e"), "a\\u001b[31mb\\u202e");
  assert.equal(
    safeText("a\u2060b\u061cc\u180ed\u2064"),
    "a\\u2060b\\u061cc\\u180ed\\u2064",
  );
  const summary = renderCheckSummary(
    {
      inputs: { claim: { name: "evil\u001b]0;x\u0007", version: "1.0.0" } },
      source: { status: "unresolved", method: "unresolved" },
      coverage: {
        complete: false,
        sourceAvailable: false,
        inventory: { files: 2, bytes: 2048, lowerBound: true },
        states: {},
      },
      failures: [{ code: "archive-read-failed" }],
      policy: { exitCode: 2, findings: [] },
      model: { status: "unavailable", reason: "quota\u001b[2J" },
    },
    {
      details: {
        vulnerabilityCheck: {
          status: "unavailable",
          reasons: ["lookup-failed"],
        },
      },
      outDir: "/tmp/out",
    },
  );
  assert.doesNotMatch(summary, /\u001b|\u0007/);
  assert.match(summary, /Incomplete analysis; no verdict is claimed/);
  assert.match(summary, /at least 2 files, 2\.0 KB/);
  assert.match(summary, /Advisory  unavailable \(lookup-failed\)/);
  assert.match(summary, /AI        unavailable \(quota\\u001b\[2J\)/);
  assert.match(summary, /Open \/tmp\/out\/report\.html/);
  assert.doesNotMatch(summary, /No deterministic findings/);
});

const ESC = "\u001b";
function stream(isTTY) {
  return {
    isTTY,
    text: "",
    write(chunk) {
      this.text += chunk;
      return true;
    },
  };
}
async function lifecycleReport(t) {
  const f = await fixture(t, true);
  const report = await analyzeLocal({
    tarballPath: f.tarballPath,
    sourceArchivePath: f.sourceArchivePath,
    sourceRoot: "root",
    commit: "d".repeat(40),
    claim: f.manifest,
  });
  report.model = { status: "unavailable", reason: "quota" };
  return report;
}
function hostedRuntime(report, env, { submitStatus = 303 } = {}) {
  const id = "a".repeat(32);
  let polls = 0;
  return {
    env: { UNMASK_SERVER_URL: "https://synthetic.invalid", ...env },
    stdout: stream(env.TTY === "1"),
    stderr: stream(env.TTY === "1"),
    hostedLimits: { pollMs: 1, totalTimeoutMs: 2000, requestTimeoutMs: 1000 },
    async fetchImpl(url) {
      if (url.endsWith("/check"))
        return new Response(null, {
          status: submitStatus,
          headers: { location: `/r/${id}` },
        });
      if (url.endsWith(".details.json"))
        return new Response(null, { status: 404 });
      polls++;
      if (polls < 3)
        return Response.json(
          { id, status: polls === 1 ? "queued" : "running" },
          { status: 202 },
        );
      return Response.json(report);
    },
  };
}

test("non-TTY check prints plain progress phases to stderr and keeps stdout free of escapes", async (t) => {
  const runtime = hostedRuntime(await lifecycleReport(t), {});
  assert.equal(await main(["check", "fixture@1.0.0"], runtime), 3);
  assert.deepEqual(runtime.stderr.text.trimEnd().split("\n"), [
    "unmask: Submitting exact package to the hosted service fixture@1.0.0",
    "unmask: Queued on the hosted service fixture@1.0.0",
    "unmask: Hosted analysis running fixture@1.0.0",
    "unmask: Fetching package details and advisories fixture@1.0.0",
  ]);
  assert.doesNotMatch(runtime.stderr.text + runtime.stdout.text, /\u001b|\r/);
  assert.match(runtime.stdout.text, /^Result    Deterministic findings/m);
});

test("TTY check animates and clears progress and colors the result unless NO_COLOR or TERM=dumb", async (t) => {
  const report = await lifecycleReport(t);
  const colored = hostedRuntime(report, { TTY: "1", TERM: "xterm" });
  assert.equal(await main(["check", "fixture@1.0.0"], colored), 3);
  assert.match(
    colored.stderr.text,
    /\r\u001b\[2K\u001b\[36m\|\u001b\[0m Submitting/,
  );
  assert.ok(colored.stderr.text.endsWith(`\r${ESC}[2K`));
  assert.match(
    colored.stdout.text,
    /\u001b\[33mResult    Deterministic findings/,
  );
  assert.match(colored.stdout.text, /\u001b\[1mCoverage\u001b\[0m  complete/);

  const plain = hostedRuntime(report, {
    TTY: "1",
    TERM: "xterm",
    NO_COLOR: "1",
  });
  assert.equal(await main(["check", "fixture@1.0.0"], plain), 3);
  assert.match(plain.stderr.text, /\r\u001b\[2K\| Submitting/);
  assert.doesNotMatch(plain.stderr.text, /\u001b\[\d+m/);
  assert.doesNotMatch(plain.stdout.text, /\u001b/);

  const dumb = hostedRuntime(report, { TTY: "1", TERM: "dumb" });
  assert.equal(await main(["check", "fixture@1.0.0"], dumb), 3);
  assert.doesNotMatch(dumb.stderr.text + dumb.stdout.text, /\u001b|\r/);
  assert.match(dumb.stderr.text, /^unmask: Submitting/);
});

test("errors clear progress, keep exit codes, color only on terminals and include a hint", async (t) => {
  const report = await lifecycleReport(t);
  const failed = hostedRuntime(
    report,
    { TTY: "1", TERM: "xterm" },
    { submitStatus: 500 },
  );
  assert.equal(await main(["check", "fixture@1.0.0"], failed), 2);
  assert.match(
    failed.stderr.text,
    /\r\u001b\[2K\u001b\[31munmask error hosted-submit-failed\u001b\[0m: The hosted service did not accept the check \(HTTP 500\)/,
  );
  assert.equal(failed.stdout.text, "");

  const usage = { env: {}, stdout: stream(false), stderr: stream(false) };
  assert.equal(await main(["check"], usage), 2);
  assert.equal(
    usage.stderr.text,
    "unmask error usage: Local tarball check requires --offline\nHint: Run unmask --help for commands and usage.\n",
  );
});

test("progress timer redraws elapsed time, ignores repeated phases and stop clears the line", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let clock = 0;
  const out = stream(true);
  const progress = createProgress(out, {
    env: { TERM: "xterm", NO_COLOR: "1" },
    now: () => clock,
    intervalMs: 100,
  });
  progress.update("local");
  progress.update("local");
  clock = 2500;
  t.mock.timers.tick(100);
  progress.stop();
  assert.equal(
    out.text,
    "\r\u001b[2K| Analyzing local artifact 0s\r\u001b[2K/ Analyzing local artifact 2s\r\u001b[2K",
  );
});

function advisoryOnlyRuntime(advisoryResult, env = {}, jobStatus = "failed") {
  const id = "b".repeat(32);
  return {
    env: { UNMASK_SERVER_URL: "https://synthetic.invalid", ...env },
    stdout: stream(false),
    stderr: stream(false),
    hostedLimits: { pollMs: 1, totalTimeoutMs: 2000, requestTimeoutMs: 1000 },
    async fetchImpl(url) {
      if (url.endsWith("/check"))
        return new Response(null, {
          status: 303,
          headers: { location: `/r/${id}` },
        });
      return Response.json({ id, status: jobStatus, advisoryResult });
    },
  };
}
function advisoryResult(status, advisories, name = "ua-parser-js") {
  const pkg = { ecosystem: "npm", name, version: "0.7.29" };
  return {
    schemaVersion: "1",
    kind: "advisory-only",
    package: pkg,
    assessment:
      status === "found" ? "advisories-reported" : "no-advisory-reported",
    advisoryCount: advisories.length,
    artifactVerification: {
      status: "not-performed",
      reason: "registry-http-error",
    },
    sourceComparison: {
      status: "not-performed",
      reason: "registry-http-error",
    },
    safetyVerdict: "not-provided",
    notice: "The registry artifact was not inspected.",
    vulnerabilityCheck: {
      schemaVersion: "1",
      source: "OSV",
      package: pkg,
      status,
      complete: true,
      queriedAt: new Date(0).toISOString(),
      reasons: [],
      advisories,
      pagesFetched: 1,
    },
  };
}

test("advisory-only hosted failure shows exact-version advisories with no verdict and exit 2", async () => {
  const runtime = advisoryOnlyRuntime(
    advisoryResult("found", [
      {
        id: "GHSA-pjwm-rvh2-c87w",
        summary: "Embedded malware in ua-parser-js\u001b[2J",
        databaseSeverity: "CRITICAL",
      },
    ]),
  );
  assert.equal(await main(["check", "ua-parser-js@0.7.29"], runtime), 2);
  for (const pattern of [
    /^UNMASK ua-parser-js@0\.7\.29$/m,
    /Advisory-only: artifact not inspected; no verdict is claimed \(exit 2\)/,
    /Artifact  not inspected \(registry-http-error\); source comparison not performed/,
    /GHSA-pjwm-rvh2-c87w \[CRITICAL\] Embedded malware in ua-parser-js\\u001b\[2J/,
    /AI        not run; no artifact evidence to explain/,
    /do not install this version/,
  ])
    assert.match(runtime.stdout.text, pattern);
  assert.doesNotMatch(runtime.stdout.text, /\u001b/);
  assert.match(runtime.stderr.text, /^unmask error hosted-advisory-only: /m);
});

test("advisory-only without advisories is never presented as safe, and mismatched identity is rejected", async () => {
  const quiet = advisoryOnlyRuntime(advisoryResult("none-reported", []));
  assert.equal(await main(["check", "ua-parser-js@0.7.29"], quiet), 2);
  assert.match(quiet.stdout.text, /Advisory  none reported by OSV/);
  assert.match(
    quiet.stdout.text,
    /not evidence of safety; the artifact itself was not checked/,
  );

  const other = advisoryOnlyRuntime(
    advisoryResult("found", [{ id: "GHSA-x" }], "other-package"),
  );
  assert.equal(await main(["check", "ua-parser-js@0.7.29"], other), 2);
  assert.equal(other.stdout.text, "");
  assert.match(other.stderr.text, /^unmask error hosted-report-failed: /m);
});

test("incomplete hosted job keeps partial advisories visible without claiming the lookup finished", async () => {
  const result = advisoryResult("incomplete", [
    { id: "GHSA-partial-0001", summary: "Partial page advisory" },
  ]);
  result.assessment = "advisory-lookup-incomplete";
  result.vulnerabilityCheck.complete = false;
  result.vulnerabilityCheck.reasons = ["page-limit"];
  const runtime = advisoryOnlyRuntime(result, {}, "incomplete");
  assert.equal(await main(["check", "ua-parser-js@0.7.29"], runtime), 2);
  assert.match(
    runtime.stdout.text,
    /Advisory  1 known for this exact version so far; lookup incomplete \(page-limit\), more may exist \(OSV\)/,
  );
  assert.match(runtime.stdout.text, /GHSA-partial-0001 Partial page advisory/);
  assert.match(runtime.stdout.text, /do not install this version/);
});

test("advisory-only results with contradictory, mismatched or unbounded fields are rejected", async () => {
  const cases = {
    "complete flag contradicts status": (r) => {
      r.vulnerabilityCheck.complete = false;
    },
    "none-reported with advisories": (r) => {
      r.vulnerabilityCheck.status = "none-reported";
      r.assessment = "no-advisory-reported";
    },
    "OSV package identity differs": (r) => {
      r.vulnerabilityCheck.package = { ...r.package, version: "0.7.30" };
    },
    "missing OSV package identity": (r) => {
      r.vulnerabilityCheck.package = null;
    },
    "assessment contradicts status": (r) => {
      r.assessment = "no-advisory-reported";
    },
    "advisory count mismatch": (r) => {
      r.advisoryCount = 2;
    },
    "oversized summary": (r) => {
      r.vulnerabilityCheck.advisories[0].summary = "x".repeat(2049);
    },
    "control characters in id": (r) => {
      r.vulnerabilityCheck.advisories[0].id = "GHSA\u001b[2J";
    },
    "too many advisories": (r) => {
      r.vulnerabilityCheck.advisories = Array.from({ length: 101 }, (_, i) => ({
        id: `GHSA-${i}`,
      }));
      r.advisoryCount = 101;
    },
    "safety verdict provided": (r) => {
      r.safetyVerdict = "safe";
    },
    "complete lookup with failure reasons": (r) => {
      r.vulnerabilityCheck.reasons = ["lookup-failed"];
    },
    "complete lookup without fetched pages": (r) => {
      r.vulnerabilityCheck.pagesFetched = 0;
    },
    "incomplete lookup without reasons": (r) => {
      r.vulnerabilityCheck.status = "incomplete";
      r.vulnerabilityCheck.complete = false;
      r.assessment = "advisory-lookup-incomplete";
    },
    "unknown result schema": (r) => {
      r.schemaVersion = "99";
    },
    "unknown lookup schema": (r) => {
      r.vulnerabilityCheck.schemaVersion = "99";
    },
    "invalid query time": (r) => {
      r.vulnerabilityCheck.queriedAt = "not-a-time";
    },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const result = advisoryResult("found", [{ id: "GHSA-pjwm-rvh2-c87w" }]);
    mutate(result);
    const runtime = advisoryOnlyRuntime(result);
    assert.equal(
      await main(["check", "ua-parser-js@0.7.29"], runtime),
      2,
      name,
    );
    assert.equal(runtime.stdout.text, "", name);
    assert.match(
      runtime.stderr.text,
      /^unmask error hosted-report-failed: /m,
      name,
    );
  }
});
