import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { parseSpec, repositoryUrl, toRecord, manifestUrl } from "./registry.ts";
import { sampleReport } from "./sample-report.ts";
import { tally } from "./report.ts";

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

test("sample totals add up from its rows", () => {
  const t = tally(sampleReport);
  assert.equal(t.published, sampleReport.release.registryFileCount);
  assert.equal(t.review + t.built + t.identical, t.published);
  assert.equal(t.identical + t.sourceOnly, sampleReport.source.fileCount);
  assert.equal(
    t.publishedBytes - sampleReport.release.registryUnpackedSize,
    sampleReport.findings[0].extra.end - sampleReport.findings[0].extra.start,
  );
});

test("sample finding bytes match their recorded hashes", () => {
  const [finding] = sampleReport.findings;
  const file = sampleReport.files.find((f) => f.path === finding.path);
  assert.ok(file);
  assert.equal(finding.published.content.length, finding.published.bytes);
  assert.equal(file.bytes, finding.published.bytes);
  assert.equal(sha256(finding.published.content), finding.published.sha256);
  assert.equal(
    sha256(finding.published.content.slice(0, finding.extra.start)),
    finding.expected.sha256,
  );
  for (const { explanation } of sampleReport.files) {
    if (explanation.kind === "unexplained")
      assert.ok(
        sampleReport.findings.some((x) => x.id === explanation.findingId),
      );
  }
});

test("release specs accept exact versions and refuse ranges, tags and URLs", () => {
  assert.deepEqual(parseSpec("clsx@2.1.1"), {
    ok: true,
    name: "clsx",
    version: "2.1.1",
  });
  assert.deepEqual(parseSpec(" @sigstore/core@4.0.1 "), {
    ok: true,
    name: "@sigstore/core",
    version: "4.0.1",
  });
  assert.deepEqual(parseSpec("react"), {
    ok: true,
    name: "react",
    version: null,
  });
  for (const bad of [
    "clsx@^2.1.1",
    "clsx@latest",
    "https://x.test/a.tgz",
    "",
    "a b@1.0.0",
  ])
    assert.equal(parseSpec(bad).ok, false, bad);
  assert.equal(parseSpec("react", { exact: true }).ok, false);
});

test("registry manifests become records without trusting their shape", () => {
  assert.equal(
    manifestUrl("@sigstore/core", "4.0.1"),
    "https://registry.npmjs.org/@sigstore%2Fcore/4.0.1",
  );
  assert.equal(
    repositoryUrl("git+https://github.com/lukeed/clsx.git"),
    "https://github.com/lukeed/clsx",
  );
  assert.equal(repositoryUrl("lukeed/clsx"), "https://github.com/lukeed/clsx");
  assert.equal(
    repositoryUrl({ url: "git@github.com:evanw/esbuild.git" }),
    "https://github.com/evanw/esbuild",
  );
  assert.equal(repositoryUrl("file:../x"), null);
  const record = toRecord({
    name: "esbuild",
    version: "0.28.2",
    scripts: { postinstall: "node install.js", test: "x" },
    dist: { fileCount: 3, attestations: { provenance: {} } },
  });
  assert.deepEqual(record.installScripts, [
    { hook: "postinstall", command: "node install.js" },
  ]);
  assert.equal(record.provenance, true);
  assert.equal(record.gitHead, null);
  assert.equal(record.repository, null);
});
