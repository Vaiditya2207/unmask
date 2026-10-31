import { buildReportFileInventory } from "../src/core/report-exploration.mjs";

const report = {
  files: [
    {
      path: "index.js",
      originalPath: "package/index.js",
      size: 8,
      artifactSha256: "a".repeat(64),
      sourceSha256: "b".repeat(64),
      state: "changed",
    },
  ],
  coverage: {
    sourceOnly: ["legacy.js"],
    sourceComplete: true,
    inventory: { complete: true },
  },
};
console.log(JSON.stringify(buildReportFileInventory(report), null, 2));
