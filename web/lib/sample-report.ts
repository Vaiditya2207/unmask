import esbuild from "./examples/esbuild-0.28.2.json" with { type: "json" };
import leftPad from "./examples/left-pad-1.0.0.json" with { type: "json" };
import { isReport, type Report } from "./report.ts";

// Real schema 1 reports from the analysis server (31 Oct 2026), unchanged except one redaction:
// maintainer and publisher email addresses in `manifests` read redacted@example.invalid.

function example(value: unknown, name: string): Report {
  if (!isReport(value))
    throw new Error(`The ${name} example is not a schema 1 report`);
  return value;
}

export const exampleReports: Record<string, Report> = {
  // /r/sample: four of seven files are not in the source, and the postinstall script runs one of them.
  sample: example(esbuild, "esbuild@0.28.2"),
  // /r/sample-no-source: the registry records no commit, so nothing could be compared.
  "sample-no-source": example(leftPad, "left-pad@1.0.0"),
};

export function exampleReport(id: string): Report | null {
  return Object.hasOwn(exampleReports, id) ? exampleReports[id] : null;
}
