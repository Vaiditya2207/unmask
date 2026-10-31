// Shape of the report JSON the analyzer serves at /r/<id>.json. The viewer renders
// only what is listed here; fields the analyzer cannot establish stay null.

export type FileStatus =
  "identical" | "changed" | "artifact-only" | "not-compared";

export type Explanation =
  | { kind: "identical" }
  | { kind: "build"; from: string; step: string; detail: string }
  | { kind: "unexplained"; findingId: string };

export interface PackageFile {
  path: string;
  bytes: number;
  sha256: string;
  status: FileStatus;
  sourceBytes: number | null;
  explanation: Explanation;
}

export interface SourceOnlyFile {
  path: string;
  bytes: number;
  reason: string;
}

export interface Check {
  label: string;
  passed: boolean;
  detail: string;
}

export interface Hypothesis {
  model: string;
  text: string;
  citedBytes: [number, number];
  connected: boolean;
}

export interface Finding {
  id: string;
  path: string;
  title: string;
  summary: string;
  expected: { from: string; step: string; bytes: number; sha256: string };
  published: { bytes: number; sha256: string; content: string };
  extra: { start: number; end: number };
  checks: Check[];
  hypothesis: Hypothesis | null;
}

export interface Release {
  name: string;
  version: string;
  publishedAt: string;
  publisher: string;
  integrity: string;
  tarballUrl: string;
  registryFileCount: number;
  registryUnpackedSize: number;
  installScripts: Record<string, string>;
  provenance: boolean;
}

export interface SourceClaim {
  repository: string;
  commit: string;
  committedAt: string;
  tag: string | null;
  via: "gitHead" | "tag" | "none";
  fileCount: number;
}

export interface Report {
  id: string;
  sample: { note: string } | null;
  analyzedAt: string;
  release: Release;
  source: SourceClaim;
  files: PackageFile[];
  sourceOnly: SourceOnlyFile[];
  findings: Finding[];
}

export interface Tally {
  published: number;
  review: number;
  built: number;
  identical: number;
  sourceOnly: number;
  explained: number;
  publishedBytes: number;
}

export function tally(report: Report): Tally {
  const count = (kind: Explanation["kind"]) =>
    report.files.filter((file) => file.explanation.kind === kind).length;
  const built = count("build");
  const identical = count("identical");
  return {
    published: report.files.length,
    review: count("unexplained"),
    built,
    identical,
    sourceOnly: report.sourceOnly.length,
    explained: built + identical,
    publishedBytes: report.files.reduce((sum, file) => sum + file.bytes, 0),
  };
}

export const statusLabel: Record<Explanation["kind"], string> = {
  identical: "Byte-identical",
  build: "Built from source",
  unexplained: "Needs review",
};

export function shortSha(value: string, length = 7) {
  return value.slice(0, length);
}

export function repoLabel(url: string) {
  return url.replace(/^https?:\/\//, "").replace(/\.git$/, "");
}

const bytesFormat = new Intl.NumberFormat("en-GB");

export function formatBytes(value: number) {
  return `${bytesFormat.format(value)} B`;
}

export function formatCount(value: number) {
  return bytesFormat.format(value);
}

export function formatUtc(iso: string) {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}
