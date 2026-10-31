import assert from "node:assert/strict";
import { test } from "node:test";
import { main } from "../../src/cli/main.mjs";

const now = Date.parse("2026-11-01T00:00:00Z");
const packument = {
  name: "@scope/fixture",
  "dist-tags": { latest: "2.0.0", next: "3.0.0-beta.1" },
  time: {
    created: "2025-01-01T00:00:00Z",
    modified: "2026-10-30T00:00:00Z",
    "1.0.0": "2025-01-01T00:00:00Z",
    "1.0.1": "2025-06-01T00:00:00Z",
    "1.0.2": "2025-07-01T00:00:00Z",
    "2.0.0": "2026-01-01T00:00:00Z",
    "3.0.0-beta.1": "2026-10-30T00:00:00Z",
  },
  versions: {
    "1.0.0": { version: "1.0.0" },
    "1.0.1": {
      version: "1.0.1",
      deprecated: "use 2.x \u001b[31minstead",
      scripts: { postinstall: "inert synthetic text" },
    },
    "2.0.0": { version: "2.0.0", scripts: { test: "inert" } },
    "3.0.0-beta.1": { version: "3.0.0-beta.1" },
  },
};
function registry(body, status = 200) {
  const urls = [];
  const fetchImpl = async (url, init) => {
    urls.push(url);
    assert.equal(init.redirect, "error");
    return new Response(
      typeof body === "string" ? body : JSON.stringify(body),
      { status },
    );
  };
  return { urls, fetchImpl };
}
function capture() {
  let text = "";
  return { write: (chunk) => (text += chunk), text: () => text };
}
async function quiet(run) {
  const original = process.stderr.write;
  const errors = [];
  process.stderr.write = (chunk) => errors.push(String(chunk));
  try {
    return { code: await run(), errors };
  } finally {
    process.stderr.write = original;
  }
}

test("history shows a bounded timeline with deprecations, removals and guidance", async () => {
  const { urls, fetchImpl } = registry(packument);
  const stdout = capture();
  const code = await main(["history", "@scope/fixture", "--limit", "4"], {
    fetchImpl,
    stdout,
    now,
  });
  assert.equal(code, 0);
  assert.deepEqual(urls, ["https://registry.npmjs.org/%40scope%2Ffixture"]);
  const lines = stdout.text().split("\n");
  assert.match(lines[0], /5 versions, 1 deprecated, 1 removed from registry/);
  assert.match(lines[1], /latest=2\.0\.0, next=3\.0\.0-beta\.1/);
  const timeline = lines.filter((line) => /^ {2}\d{4}-/.test(line));
  assert.deepEqual(
    timeline.map((line) => line.trim().split(/\s+/)[1]),
    ["3.0.0-beta.1", "2.0.0", "1.0.2", "1.0.1"],
  );
  assert.match(timeline[0], /\[next\] \[recent\]/);
  assert.match(timeline[2], /1\.0\.2 \[removed\]/);
  assert.match(timeline[3], /\[install scripts: postinstall\]/);
  assert.ok(lines.includes("      deprecated: use 2.x \\u001b[31minstead"));
  assert.match(stdout.text(), /unmask check @scope\/fixture@2\.0\.0 --out DIR/);
  assert.match(stdout.text(), /not proof of safety/);
});

test("history guidance skips a deprecated latest and JSON stays structured", async () => {
  const deprecatedLatest = structuredClone(packument);
  deprecatedLatest.versions["2.0.0"].deprecated = "compromised";
  const stdout = capture();
  const { fetchImpl } = registry(deprecatedLatest);
  assert.equal(
    await main(["history", "@scope/fixture", "--json"], {
      fetchImpl,
      stdout,
      now,
    }),
    0,
  );
  const summary = JSON.parse(stdout.text());
  assert.equal(summary.candidate, "1.0.0");
  assert.equal(summary.shown.length, 5);
});

test("history rejects bad input and reports registry failures without guessing", async () => {
  const never = async () => assert.fail("no request expected");
  for (const args of [
    ["fixture@1.0.0"],
    ["fixture", "--limit", "101"],
    ["fixture", "--limit", "0"],
    [],
  ]) {
    const { code } = await quiet(() =>
      main(["history", ...args], { fetchImpl: never }),
    );
    assert.equal(code, 2);
  }
  const missing = await quiet(() =>
    main(["history", "absent"], {
      fetchImpl: registry({ error: "Not found" }, 404).fetchImpl,
    }),
  );
  assert.equal(missing.code, 2);
  assert.match(missing.errors[0], /^registry-not-found: /);
  const other = await quiet(() =>
    main(["history", "fixture"], { fetchImpl: registry(packument).fetchImpl }),
  );
  assert.match(other.errors[0], /^registry-identity-mismatch: /);
  const broken = await quiet(() =>
    main(["history", "fixture"], { fetchImpl: registry("{").fetchImpl }),
  );
  assert.match(broken.errors[0], /^registry-invalid: /);
});

test("history keeps full exact version identity for guidance and JSON", async () => {
  const long = "1.0.0+" + "a".repeat(80);
  const document = {
    name: "fixture",
    "dist-tags": { latest: long, odd: "constructor" },
    time: { [long]: "2026-01-01T00:00:00Z", "0.9.0": "2025-01-01T00:00:00Z" },
    versions: {
      [long]: { version: long },
      "0.9.0": { version: "0.9.0" },
    },
  };
  const text = capture();
  await main(["history", "fixture"], {
    fetchImpl: registry(document).fetchImpl,
    stdout: text,
    now,
  });
  assert.ok(text.text().includes(`unmask check fixture@${long} --out DIR`));
  assert.match(text.text(), /1\.0\.0\+a{58}\.\.\. \[latest\]/);
  const json = capture();
  await main(["history", "fixture", "--json"], {
    fetchImpl: registry(document).fetchImpl,
    stdout: json,
    now,
  });
  const summary = JSON.parse(json.text());
  assert.equal(summary.candidate, long);
  assert.equal(summary.distTags.latest, long);
  assert.equal(summary.shown[0].version, long);
  assert.equal(summary.totalVersions, 2);
  const invalidLatest = structuredClone(document);
  invalidLatest["dist-tags"].latest = "not-semver";
  invalidLatest.versions["not-semver"] = { version: "not-semver" };
  invalidLatest.time["not-semver"] = "2026-06-01T00:00:00Z";
  const fallback = capture();
  await main(["history", "fixture", "--json"], {
    fetchImpl: registry(invalidLatest).fetchImpl,
    stdout: fallback,
    now,
  });
  assert.equal(JSON.parse(fallback.text()).candidate, long);
});
