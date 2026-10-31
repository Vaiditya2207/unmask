import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  planFromLockfile,
  runInstallGuard,
} from "../../src/cli/install-guard.mjs";
import { main } from "../../src/cli/main.mjs";
import { createApp } from "../../src/server/app.mjs";

const INTEGRITY = "sha512-" + "A".repeat(86) + "==";
const OTHER_INTEGRITY = "sha512-" + "B".repeat(86) + "==";
const entry = (name, version, extra = {}) => ({
  version,
  resolved: `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${version}.tgz`,
  integrity: INTEGRITY,
  ...extra,
});
function lockfile(packages, dependencies = { "left-pad": "^1.3.0" }) {
  return {
    name: "demo",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "demo", version: "1.0.0", dependencies },
      ...packages,
    },
  };
}
const cleanPackages = {
  "node_modules/left-pad": entry("left-pad", "1.3.0", {
    dependencies: { "@scope/util": "^2.0.0" },
  }),
  "node_modules/@scope/util": entry("@scope/util", "2.0.0"),
};
const SPECS = ["@scope/util@2.0.0", "left-pad@1.3.0"];

async function project(t, lock = lockfile(cleanPackages), manifest) {
  const root = await mkdtemp(path.join(os.tmpdir(), "unmask-guard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify(
      manifest ?? {
        name: "demo",
        version: "1.0.0",
        dependencies: lock.packages[""].dependencies,
      },
    ),
  );
  await writeFile(path.join(root, "package-lock.json"), JSON.stringify(lock));
  const npm = path.join(root, "fake-npm");
  const record = path.join(root, "npm-ci-called.json");
  await writeFile(
    npm,
    `#!${process.execPath}
const a = process.argv.slice(2);
if (a[0] === "prefix") { console.log(process.env.FAKE_NPM_PREFIX || process.cwd()); process.exit(0); }
if (a[0] === "config" && a[1] === "get") { console.log({ global: process.env.FAKE_NPM_GLOBAL || "false", "package-lock": "true" }[a[2]]); process.exit(0); }
require("fs").writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: a, active: process.env.UNMASK_GUARD_ACTIVE }));
process.exit(Number(process.env.FAKE_NPM_EXIT || 0));
`,
  );
  await chmod(npm, 0o755);
  return {
    root,
    npm,
    record,
    called: () => readFile(record, "utf8").then(JSON.parse, () => null),
  };
}
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
const row = (spec, advisories = [], extra = {}) => ({
  spec,
  name: spec.slice(0, spec.lastIndexOf("@")),
  version: spec.slice(spec.lastIndexOf("@") + 1),
  integrity: INTEGRITY,
  integrityStatus: "consistent",
  status: advisories.length ? "found" : "none-reported",
  complete: true,
  reasons: [],
  advisories,
  ...extra,
});
const screening = (rows) => ({
  schemaVersion: "1",
  source: "OSV",
  coverage: {
    scope: "exact-registry-identities",
    registryComplete: true,
    projectScreened: false,
  },
  dependencies: rows,
});
function hosted(rows = SPECS.map((spec) => row(spec)), status = 200) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: options.body });
    return json(typeof rows === "function" ? rows() : screening(rows), status);
  };
  return { fetchImpl, calls };
}
function osv(vulnsByPackage = {}, details = {}) {
  const fetchImpl = async (url, options) => {
    if (url === "https://api.osv.dev/v1/querybatch") {
      const { queries } = JSON.parse(options.body);
      return json({
        results: queries.map((query) => {
          const ids = vulnsByPackage[`${query.package.name}@${query.version}`];
          return ids ? { vulns: ids.map((id) => ({ id })) } : {};
        }),
      });
    }
    const id = decodeURIComponent(
      url.slice("https://api.osv.dev/v1/vulns/".length),
    );
    return details[id] ? json(details[id]) : json({}, 404);
  };
  return fetchImpl;
}
const refuse = async () => {
  throw new Error("network must not be used");
};
async function guard(fixture, command, args, options = {}) {
  await rm(fixture.record, { force: true });
  let stderr = "";
  const code = await runInstallGuard(command, args, {
    cwd: fixture.root,
    npmCommand: fixture.npm,
    env: { PATH: process.env.PATH, ...options.env },
    fetchImpl: options.fetchImpl ?? hosted().fetchImpl,
    stderr: { write: (chunk) => void (stderr += chunk) },
  });
  return { code, stderr, called: await fixture.called() };
}

test("clean hosted screening runs npm ci with exact arguments and preserves its exit code", async (t) => {
  const fixture = await project(t);
  const { fetchImpl, calls } = hosted();
  const result = await guard(
    fixture,
    "ci",
    ["--omit=dev", "--loglevel", "warn"],
    {
      fetchImpl,
      env: { FAKE_NPM_EXIT: "7", UNMASK_SERVER_URL: "http://127.0.0.1:9" },
    },
  );
  assert.equal(result.code, 7, result.stderr);
  assert.deepEqual(result.called, {
    argv: ["ci", "--omit=dev", "--loglevel", "warn"],
    active: "1",
  });
  assert.equal(calls[0].url, "http://127.0.0.1:9/api/dependency-screening");
  assert.equal(
    calls[0].body.toString(),
    await readFile(path.join(fixture.root, "package-lock.json"), "utf8"),
  );
  assert.match(
    result.stderr,
    /2 exact registry identities in advisory screening via hosted/,
  );
  assert.match(result.stderr, /not a safety verdict/);
});

test("real loopback hosted screening with a malicious-package advisory blocks before npm", async (t) => {
  const fixture = await project(t);
  let received = "";
  const server = createServer((req, res) => {
    req.on("data", (chunk) => (received += chunk));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          screening([
            row("@scope/util@2.0.0"),
            row("left-pad@1.3.0", [
              { id: "GHSA-xxxx-yyyy-zzzz", aliases: ["MAL-2025-1234"] },
            ]),
          ]),
        ),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const result = await guard(fixture, "ci", [], {
    fetchImpl: globalThis.fetch,
    env: { UNMASK_SERVER_URL: `http://127.0.0.1:${server.address().port}` },
  });
  assert.equal(result.code, 3);
  assert.equal(result.called, null);
  assert.equal(JSON.parse(received).lockfileVersion, 3);
  assert.match(
    result.stderr,
    /block\s+left-pad@1\.3\.0 known-malware \[GHSA-xxxx-yyyy-zzzz\]/,
  );
});

test("hosted rows must match every planned identity, integrity and status", async (t) => {
  const fixture = await project(t);
  const cases = [
    [[row("left-pad@1.3.0")], "hosted-missing-identity"],
    [
      [
        row("left-pad@1.3.0"),
        row("@scope/util@2.0.0", [], { integrity: OTHER_INTEGRITY }),
      ],
      "hosted-identity-mismatch",
    ],
    [
      [...SPECS.map((spec) => row(spec)), row("extra@1.0.0")],
      "hosted-plan-mismatch",
    ],
    [
      [
        row("left-pad@1.3.0"),
        row("@scope/util@2.0.0", [], {
          status: "not-screened",
          complete: false,
        }),
      ],
      "hosted-not-screened",
    ],
    [
      [
        row("left-pad@1.3.0"),
        row("@scope/util@2.0.0", [{ id: "BAD ID", aliases: [] }]),
      ],
      "hosted-invalid-advisory-record",
    ],
  ];
  for (const [rows, reason] of cases) {
    const result = await guard(fixture, "ci", [], {
      fetchImpl: hosted(rows).fetchImpl,
    });
    assert.equal(result.code, 3, reason);
    assert.equal(result.called, null);
    assert.match(result.stderr, new RegExp(reason));
  }
  const limited = await guard(fixture, "ci", [], {
    fetchImpl: hosted([], 429).fetchImpl,
  });
  assert.equal(limited.code, 3);
  assert.match(limited.stderr, /hosted-rate-limited/);
});

test("strict blocks medium advisories while balanced warns on medium and blocks high", async (t) => {
  const fixture = await project(t);
  const rows = (sev) => [
    row("@scope/util@2.0.0"),
    row("left-pad@1.3.0", [
      { id: "GHSA-1111-2222-3333", aliases: [], databaseSeverity: sev },
    ]),
  ];
  const strict = await guard(fixture, "ci", [], {
    fetchImpl: hosted(rows("MODERATE")).fetchImpl,
  });
  assert.equal(strict.code, 3);
  assert.match(strict.stderr, /advisory-severity:medium/);
  const balanced = await guard(fixture, "ci", [], {
    fetchImpl: hosted(rows("MODERATE")).fetchImpl,
    env: { UNMASK_GUARD_POLICY: "balanced" },
  });
  assert.equal(balanced.code, 0);
  assert.match(balanced.stderr, /warn\s+left-pad@1\.3\.0 advisory-reported/);
  const high = await guard(fixture, "ci", [], {
    fetchImpl: hosted(rows("HIGH")).fetchImpl,
    env: { UNMASK_GUARD_POLICY: "balanced" },
  });
  assert.equal(high.code, 3);
});

test("diagnostic OSV source uses the shared classifier for curated malware, withdrawn and malformed records", async (t) => {
  const env = { UNMASK_GUARD_SOURCE: "osv" };
  const incident = {
    id: "GHSA-pjwm-rvh2-c87w",
    aliases: ["CVE-2021-27292"],
    database_specific: { severity: "CRITICAL" },
  };
  const ua = await project(
    t,
    lockfile(
      { "node_modules/ua-parser-js": entry("ua-parser-js", "0.7.29") },
      { "ua-parser-js": "0.7.29" },
    ),
  );
  const curated = await guard(ua, "ci", [], {
    env,
    fetchImpl: osv(
      { "ua-parser-js@0.7.29": [incident.id] },
      { [incident.id]: incident },
    ),
  });
  assert.equal(curated.code, 3);
  assert.match(
    curated.stderr,
    /block\s+ua-parser-js@0\.7\.29 known-malware \[GHSA-pjwm-rvh2-c87w\]/,
  );
  const fixture = await project(t);
  const unrelated = await guard(fixture, "ci", [], {
    env,
    fetchImpl: osv(
      { "left-pad@1.3.0": [incident.id] },
      { [incident.id]: incident },
    ),
  });
  assert.equal(unrelated.code, 3);
  assert.match(
    unrelated.stderr,
    /block\s+left-pad@1\.3\.0 advisory-severity:critical/,
  );
  const badWithdrawal = await guard(fixture, "ci", [], {
    env,
    fetchImpl: osv(
      { "left-pad@1.3.0": [incident.id] },
      { [incident.id]: { ...incident, withdrawn: "not-a-timestamp" } },
    ),
  });
  assert.equal(badWithdrawal.code, 3);
  assert.equal(badWithdrawal.called, null);
  assert.match(
    badWithdrawal.stderr,
    /unknown\s+left-pad@1\.3\.0 advisory-detail-unavailable/,
  );
  const malformed = await guard(fixture, "ci", [], {
    env,
    fetchImpl: osv({ "left-pad@1.3.0": ["INVALID ID / ignored"] }),
  });
  assert.equal(malformed.code, 3);
  assert.match(
    malformed.stderr,
    /unknown\s+left-pad@1\.3\.0 invalid-advisory-record/,
  );
  const down = await guard(fixture, "ci", [], { env, fetchImpl: refuse });
  assert.equal(down.code, 3);
  assert.equal(down.called, null);
});

test("install, unsupported flags and retargeting npm environment are refused before network or npm", async (t) => {
  const fixture = await project(t);
  for (const [command, args, env, code] of [
    ["install", [], {}, /install-unbindable/],
    ["install", ["lodash@4"], {}, /--ignore-scripts lodash@4/],
    ["ci", ["--userconfig", "/tmp/npmrc"], {}, /unsupported-option/],
    ["ci", ["--registry=https://evil.example"], {}, /unsupported-option/],
    ["ci", ["-g"], {}, /unsupported-option/],
    ["ci", ["lodash"], {}, /unsupported-option/],
    ["ci", ["--omit", "everything"], {}, /unsupported-option/],
    [
      "ci",
      [],
      { npm_config_global: "true" },
      /unsupported-config: .*npm_config_global/,
    ],
    ["ci", [], { NPM_CONFIG_PREFIX: "/tmp/x" }, /unsupported-config/],
  ]) {
    const result = await guard(fixture, command, args, {
      env,
      fetchImpl: refuse,
    });
    assert.equal(result.code, 2, `${command} ${args.join(" ")}`);
    assert.equal(result.called, null);
    assert.match(result.stderr, code);
  }
});

test("effective npm configuration that retargets the install is refused before npm ci", async (t) => {
  const fixture = await project(t);
  for (const env of [
    { FAKE_NPM_GLOBAL: "true" },
    { FAKE_NPM_PREFIX: os.tmpdir() },
  ]) {
    const result = await guard(fixture, "ci", [], { env });
    assert.equal(result.code, 2);
    assert.equal(result.called, null);
    assert.match(result.stderr, /npm-config-retarget/);
  }
});

test("lockfile changed while screening is detected before npm starts", async (t) => {
  const fixture = await project(t);
  const swapped = lockfile({
    ...cleanPackages,
    "node_modules/left-pad": entry("left-pad", "1.9.9", {
      dependencies: { "@scope/util": "^2.0.0" },
    }),
  });
  const result = await guard(fixture, "ci", [], {
    fetchImpl: hosted(() => {
      return screening(SPECS.map((spec) => row(spec)));
    }).fetchImpl,
  });
  assert.equal(result.code, 0);
  const racing = await guard(fixture, "ci", [], {
    fetchImpl: async () => {
      await writeFile(
        path.join(fixture.root, "package-lock.json"),
        JSON.stringify(swapped),
      );
      return json(screening(SPECS.map((spec) => row(spec))));
    },
  });
  assert.equal(racing.code, 2);
  assert.match(racing.stderr, /plan-changed/);
});

test("missing graph entries, local links and bundled dependencies cannot pass strict", async (t) => {
  const partial = await project(
    t,
    lockfile({}, { "unfetched-package": "^1.0.0" }),
  );
  const missing = await guard(partial, "ci", [], { fetchImpl: refuse });
  assert.equal(missing.code, 2);
  assert.equal(missing.called, null);
  assert.match(missing.stderr, /lockfile-incomplete: .*unfetched-package/);
  const transitive = await project(
    t,
    lockfile({
      "node_modules/left-pad": entry("left-pad", "1.3.0", {
        dependencies: { gone: "1" },
      }),
    }),
  );
  assert.match(
    (await guard(transitive, "ci", [], { fetchImpl: refuse })).stderr,
    /lockfile-incomplete: .*node_modules\/left-pad -> gone/,
  );
  const linked = await project(
    t,
    lockfile(
      {
        "node_modules/local-pkg": {
          resolved: "packages/local-pkg",
          link: true,
        },
        "packages/local-pkg": { name: "local-pkg", version: "1.0.0" },
      },
      { "local-pkg": "file:packages/local-pkg" },
    ),
  );
  const link = await guard(linked, "ci", [], { fetchImpl: refuse });
  assert.equal(link.code, 3);
  assert.equal(link.called, null);
  assert.match(
    link.stderr,
    /unknown\s+local:node_modules\/local-pkg unbound-identity:local-link/,
  );
  const bundled = await project(
    t,
    lockfile({
      ...cleanPackages,
      "node_modules/left-pad/node_modules/inner": {
        version: "1.0.0",
        inBundle: true,
      },
    }),
  );
  const bundle = await guard(bundled, "ci", []);
  assert.equal(bundle.code, 3);
  assert.match(
    bundle.stderr,
    /inner@1\.0\.0 unbound-identity:bundled-unverified/,
  );
  const git = await project(
    t,
    lockfile({
      "node_modules/left-pad": {
        version: "1.3.0",
        resolved: "git+ssh://git@github.com/x/left-pad.git#abc",
      },
    }),
  );
  assert.match(
    (await guard(git, "ci", [])).stderr,
    /unbound-identity:non-registry-source/,
  );
});

test("nested guard, out-of-sync and legacy lockfiles are refused", async (t) => {
  const fixture = await project(t);
  const nested = await guard(fixture, "ci", [], {
    env: { UNMASK_GUARD_ACTIVE: "1" },
    fetchImpl: refuse,
  });
  assert.equal(nested.code, 2);
  assert.match(nested.stderr, /recursive-guard/);
  const stale = await project(t, lockfile(cleanPackages), {
    name: "demo",
    dependencies: { "left-pad": "^1.3.0", evil: "*" },
  });
  assert.match(
    (await guard(stale, "ci", [], { fetchImpl: refuse })).stderr,
    /lockfile-out-of-sync/,
  );
  const legacy = await project(t, {
    ...lockfile(cleanPackages),
    lockfileVersion: 1,
  });
  assert.match(
    (await guard(legacy, "ci", [], { fetchImpl: refuse })).stderr,
    /lockfile-unsupported/,
  );
});

test("plan dedupes exact identities, honors aliases and flags conflicting integrity", () => {
  const plan = planFromLockfile(
    JSON.stringify(
      lockfile({
        "node_modules/a": entry("left-pad", "1.3.0", { name: "left-pad" }),
        "node_modules/x/node_modules/left-pad": entry("left-pad", "1.3.0", {
          integrity: OTHER_INTEGRITY,
        }),
        "node_modules/x": entry("x", "1.0.0"),
        "node_modules/left-pad": entry("left-pad", "1.3.0"),
      }),
    ),
    JSON.stringify({ dependencies: { "left-pad": "^1.3.0" } }),
  );
  assert.deepEqual(
    plan.map((item) => [item.id, item.binding, item.paths.length]),
    [
      ["left-pad@1.3.0", "conflicting-integrity", 3],
      ["x@1.0.0", "registry-integrity", 1],
    ],
  );
});

test("main dispatches ci to the guard", async (t) => {
  const fixture = await project(t);
  const original = process.stderr.write;
  process.stderr.write = () => true;
  t.after(() => (process.stderr.write = original));
  const code = await main(["ci"], {
    cwd: fixture.root,
    npmCommand: fixture.npm,
    env: { PATH: process.env.PATH },
    fetchImpl: hosted().fetchImpl,
  });
  process.stderr.write = original;
  assert.equal(code, 0);
  assert.deepEqual((await fixture.called()).argv, ["ci"]);
});

const HIGH = (sev, extra = {}) => [
  row("@scope/util@2.0.0"),
  row("left-pad@1.3.0", [
    {
      id: "GHSA-1111-2222-3333",
      aliases: [],
      ...(sev ? { databaseSeverity: sev } : {}),
      ...extra,
    },
  ]),
];
async function config(fixture, value) {
  await writeFile(
    path.join(fixture.root, ".unmask.json"),
    JSON.stringify({ schemaVersion: 1, ...value }),
    { mode: 0o600 },
  );
}

test("hosted withdrawn markers must be valid timestamps and unrated advisories block only under strict", async (t) => {
  const fixture = await project(t);
  const numeric = await guard(fixture, "ci", [], {
    fetchImpl: hosted(HIGH("CRITICAL", { withdrawn: 0 })).fetchImpl,
  });
  assert.equal(numeric.code, 3);
  assert.equal(numeric.called, null);
  assert.match(
    numeric.stderr,
    /unknown\s+left-pad@1\.3\.0 hosted-invalid-advisory-record/,
  );
  const mixed = await guard(fixture, "ci", [], {
    fetchImpl: hosted([
      row("@scope/util@2.0.0"),
      row("left-pad@1.3.0", [
        { id: "MAL-2025-9", aliases: [] },
        { id: "BAD ID", aliases: [] },
      ]),
    ]).fetchImpl,
  });
  assert.match(mixed.stderr, /block\s+left-pad@1\.3\.0 known-malware/);
  const withdrawn = await guard(fixture, "ci", [], {
    fetchImpl: hosted(HIGH("CRITICAL", { withdrawn: "2025-01-01T00:00:00Z" }))
      .fetchImpl,
  });
  assert.equal(withdrawn.code, 0);
  const strict = await guard(fixture, "ci", [], {
    fetchImpl: hosted(HIGH()).fetchImpl,
  });
  assert.equal(strict.code, 3);
  assert.match(strict.stderr, /advisory-severity:unrated/);
  const balanced = await guard(fixture, "ci", [], {
    fetchImpl: hosted(HIGH()).fetchImpl,
    env: { UNMASK_GUARD_POLICY: "balanced" },
  });
  assert.equal(balanced.code, 0);
});

test("project config profile applies, but a file-supplied audit profile never weakens the guard", async (t) => {
  const fixture = await project(t);
  await config(fixture, { profile: "balanced" });
  const balanced = await guard(fixture, "ci", [], {
    fetchImpl: hosted(HIGH("MODERATE")).fetchImpl,
  });
  assert.equal(balanced.code, 0);
  assert.match(balanced.stderr, /profile balanced from .*\.unmask\.json/);
  await config(fixture, { profile: "audit" });
  const fileAudit = await guard(fixture, "ci", [], {
    fetchImpl: hosted(HIGH("MODERATE")).fetchImpl,
  });
  assert.equal(fileAudit.code, 3);
  assert.equal(fileAudit.called, null);
  assert.match(
    fileAudit.stderr,
    /requests the nonenforcing audit profile.*strict is used/,
  );
  const explicit = await guard(fixture, "ci", [], {
    fetchImpl: hosted(HIGH("CRITICAL")).fetchImpl,
    env: { UNMASK_GUARD_POLICY: "audit" },
  });
  assert.equal(explicit.code, 0);
  assert.match(
    explicit.stderr,
    /audit profile is nonenforcing; only known malware stops npm/,
  );
  const auditMalware = await guard(fixture, "ci", [], {
    fetchImpl: hosted([
      row("@scope/util@2.0.0"),
      row("left-pad@1.3.0", [{ id: "MAL-2025-1", aliases: [] }]),
    ]).fetchImpl,
    env: { UNMASK_GUARD_POLICY: "audit" },
  });
  assert.equal(auditMalware.code, 3);
  await writeFile(path.join(fixture.root, ".unmask.json"), "{}", {
    mode: 0o666,
  });
  await chmod(path.join(fixture.root, ".unmask.json"), 0o666);
  const unsafe = await guard(fixture, "ci", [], { fetchImpl: refuse });
  assert.equal(unsafe.code, 2);
  assert.match(unsafe.stderr, /guard-config-invalid/);
});

test("exact exceptions waive only a pure severity block, never malware or unknown evidence", async (t) => {
  const fixture = await project(t);
  const now = new Date();
  const exception = {
    name: "left-pad",
    version: "1.3.0",
    reason: "Reviewed vendor patch SEC-12",
    created: new Date(now.getTime() - 60000).toISOString(),
    expires: new Date(now.getTime() + 86400000).toISOString(),
  };
  await config(fixture, { profile: "strict", exceptions: [exception] });
  const severe = await guard(fixture, "ci", [], {
    fetchImpl: hosted(HIGH("HIGH")).fetchImpl,
  });
  assert.equal(severe.code, 0);
  assert.match(
    severe.stderr,
    /warn\s+left-pad@1\.3\.0 advisory-severity:high,exception-until:/,
  );
  const malware = await guard(fixture, "ci", [], {
    fetchImpl: hosted([
      row("@scope/util@2.0.0"),
      row("left-pad@1.3.0", [{ id: "MAL-2025-1", aliases: [] }]),
    ]).fetchImpl,
  });
  assert.equal(malware.code, 3);
  const unknown = await guard(fixture, "ci", [], {
    fetchImpl: hosted([
      row("@scope/util@2.0.0"),
      row("left-pad@1.3.0", [], { status: "unavailable", complete: false }),
    ]).fetchImpl,
  });
  assert.equal(unknown.code, 3);
  assert.equal(unknown.called, null);
});

test("lockfile keys with traversal segments are refused", async (t) => {
  const fixture = await project(
    t,
    lockfile({ ...cleanPackages, "../node_modules/x": entry("x", "1.0.0") }),
  );
  const result = await guard(fixture, "ci", [], { fetchImpl: refuse });
  assert.equal(result.code, 2);
  assert.match(
    result.stderr,
    /lockfile-invalid: Lockfile key \.\.\/node_modules\/x/,
  );
  const tilde = await project(
    t,
    lockfile({ ...cleanPackages, "node_modules/a~b": entry("a~b", "1.0.0") }),
  );
  assert.equal((await guard(tilde, "ci", [], { fetchImpl: refuse })).code, 2);
});

test("guard consumes the real S06 dependency-screening server over loopback HTTP", async (t) => {
  const fixture = await project(t);
  const malicious = new Set();
  const app = createApp({
    versionInfo: {
      version: "0.0.0",
      commit: "a".repeat(40),
      tarballSha256: "b".repeat(64),
    },
    runAnalysis: async () => {
      throw new Error("analysis must not run");
    },
    advisoryLookup: async (spec) => {
      const at = spec.lastIndexOf("@");
      const advisories = malicious.has(spec)
        ? [{ id: "MAL-2025-4242", aliases: [] }]
        : [];
      return {
        schemaVersion: "1",
        source: "OSV",
        package: {
          name: spec.slice(0, at),
          version: spec.slice(at + 1),
          ecosystem: "npm",
        },
        status: advisories.length ? "found" : "none-reported",
        complete: true,
        reasons: [],
        advisories,
        pagesFetched: 1,
      };
    },
  });
  app.listen(0, "127.0.0.1");
  await new Promise((resolve) => app.once("listening", resolve));
  t.after(
    () =>
      new Promise((resolve) => (app.closeAllConnections(), app.close(resolve))),
  );
  const env = {
    UNMASK_SERVER_URL: `http://127.0.0.1:${app.address().port}`,
    FAKE_NPM_EXIT: "7",
  };
  const clean = await guard(fixture, "ci", [], {
    fetchImpl: globalThis.fetch,
    env,
  });
  assert.equal(clean.code, 7, clean.stderr);
  assert.deepEqual(clean.called.argv, ["ci"]);
  malicious.add("left-pad@1.3.0");
  const blocked = await guard(fixture, "ci", [], {
    fetchImpl: globalThis.fetch,
    env,
  });
  assert.equal(blocked.code, 3);
  assert.equal(blocked.called, null);
  assert.match(
    blocked.stderr,
    /block\s+left-pad@1\.3\.0 known-malware \[MAL-2025-4242\]/,
  );
});

test("incomplete hosted rows keep valid advisory evidence and still block on remaining coverage", async (t) => {
  const fixture = await project(t);
  const incomplete = (advisories) => [
    row("@scope/util@2.0.0"),
    row("left-pad@1.3.0", advisories, {
      status: "incomplete",
      complete: false,
      reasons: ["advisory-output-limit"],
    }),
  ];
  const mal = await guard(fixture, "ci", [], {
    fetchImpl: hosted(incomplete([{ id: "MAL-2025-77", aliases: [] }]))
      .fetchImpl,
  });
  assert.equal(mal.code, 3);
  assert.equal(mal.called, null);
  assert.match(
    mal.stderr,
    /block\s+left-pad@1\.3\.0 known-malware,hosted-incomplete \[MAL-2025-77\]/,
  );
  const ua = await project(
    t,
    lockfile(
      { "node_modules/ua-parser-js": entry("ua-parser-js", "0.7.29") },
      { "ua-parser-js": "0.7.29" },
    ),
  );
  const curated = await guard(ua, "ci", [], {
    fetchImpl: hosted([
      row(
        "ua-parser-js@0.7.29",
        [
          {
            id: "GHSA-pjwm-rvh2-c87w",
            aliases: [],
            databaseSeverity: "CRITICAL",
          },
        ],
        {
          status: "incomplete",
          complete: false,
        },
      ),
    ]).fetchImpl,
  });
  assert.equal(curated.code, 3);
  assert.match(curated.stderr, /block\s+ua-parser-js@0\.7\.29 known-malware/);
  const extra = await guard(fixture, "ci", [], {
    fetchImpl: hosted([
      ...incomplete([{ id: "MAL-2025-78", aliases: [] }]),
      row("extra@1.0.0"),
    ]).fetchImpl,
  });
  assert.match(extra.stderr, /block\s+left-pad@1\.3\.0 known-malware/);
  assert.match(
    extra.stderr,
    /unknown\s+@scope\/util@2\.0\.0 hosted-plan-mismatch/,
  );
});

test("a file link outside the lockfile is an unknown local entry, not a missing one", async (t) => {
  const fixture = await project(
    t,
    lockfile(
      { "node_modules/local-pkg": { resolved: "../local-pkg", link: true } },
      { "local-pkg": "file:../local-pkg" },
    ),
  );
  const result = await guard(fixture, "ci", [], { fetchImpl: refuse });
  assert.equal(result.code, 3);
  assert.equal(result.called, null);
  assert.match(
    result.stderr,
    /unknown\s+local:node_modules\/local-pkg unbound-identity:local-link/,
  );
});

test("hosted rows for downgraded plan identities do not corrupt clean package reasons", async (t) => {
  const weak = {
    ...entry("weak-pkg", "1.0.0"),
    integrity: "sha1-" + "C".repeat(27) + "=",
  };
  const fixture = await project(
    t,
    lockfile(
      {
        ...cleanPackages,
        "node_modules/weak-pkg": weak,
        "node_modules/dup": entry("dup", "1.0.0"),
        "node_modules/left-pad/node_modules/dup": entry("dup", "1.0.0", {
          integrity: OTHER_INTEGRITY,
        }),
      },
      { "left-pad": "^1.3.0", "weak-pkg": "1.0.0", dup: "1.0.0" },
    ),
  );
  const rows = (weakAdvisories = []) => [
    ...SPECS.map((spec) => row(spec)),
    row("weak-pkg@1.0.0", weakAdvisories, {
      integrity: null,
      integrityStatus: "missing",
      status: weakAdvisories.length ? "found" : "none-reported",
    }),
    row("dup@1.0.0", [], {
      integrity: null,
      integrityStatus: "conflicting",
      status: "incomplete",
      complete: false,
    }),
  ];
  const result = await guard(fixture, "ci", [], {
    fetchImpl: hosted(rows()).fetchImpl,
  });
  assert.equal(result.code, 3);
  assert.equal(result.called, null);
  assert.doesNotMatch(result.stderr, /hosted-plan-mismatch/);
  assert.match(result.stderr, /allow 2, warn 0, unknown 2, block 0/);
  assert.match(
    result.stderr,
    /unknown\s+weak-pkg@1\.0\.0 unbound-identity:weak-integrity/,
  );
  assert.match(
    result.stderr,
    /unknown\s+dup@1\.0\.0 unbound-identity:conflicting-integrity/,
  );
  const mal = await guard(fixture, "ci", [], {
    fetchImpl: hosted(rows([{ id: "MAL-2026-9", aliases: [] }])).fetchImpl,
  });
  assert.equal(mal.code, 3);
  assert.match(
    mal.stderr,
    /block\s+weak-pkg@1\.0\.0 known-malware,unbound-identity:weak-integrity \[MAL-2026-9\]/,
  );
  const foreign = await guard(fixture, "ci", [], {
    fetchImpl: hosted([...rows(), row("not-in-plan@1.0.0")]).fetchImpl,
  });
  assert.match(
    foreign.stderr,
    /unknown\s+left-pad@1\.3\.0 hosted-plan-mismatch/,
  );
});
