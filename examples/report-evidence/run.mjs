import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { compareInventories } from "../../src/core/compare.mjs";
import { buildReportFileEvidence } from "../../src/core/report-exploration.mjs";

const input = JSON.parse(
  readFileSync(new URL("input/sample.json", import.meta.url)),
);
const sha = (value) => createHash("sha256").update(value).digest("hex");
function inventory(side) {
  const content = Buffer.from(input[side]);
  return {
    digest: { sha256: sha(`synthetic ${side} archive`) },
    complete: true,
    failures: [],
    entries: [
      {
        path: input.path,
        originalPath: `${side}/${input.path}`,
        type: "file",
        size: content.length,
        sha256: sha(content),
        content,
      },
    ],
  };
}
const artifact = inventory("artifact");
const source = inventory("source");
const report = {
  ...compareInventories(artifact, source),
  inputs: { artifact: artifact.digest, sourceArchive: source.digest },
};
console.log(
  JSON.stringify(
    buildReportFileEvidence(report, { path: input.path }),
    null,
    2,
  ),
);
