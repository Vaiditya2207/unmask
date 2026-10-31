import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
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
