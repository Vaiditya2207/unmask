import { proxyPackageDetails } from "./package-details-proxy.ts";

export type DetailRecord = Record<string, unknown>;
export interface DetailList {
  items: unknown[];
  total: number;
  returned: number;
  omitted: number;
  omissionReasons: Record<string, number>;
}
export interface PackageDetails {
  detailsVersion: "1";
  vulnerabilityCheck?: unknown;
  reportSchemaVersion: "1";
  scope: DetailRecord;
  identity: DetailList;
  declarations: DetailRecord & { fields: DetailList };
  entrypoints: DetailRecord & { targets: DetailList };
  dependencies: DetailRecord & {
    categories: (DetailRecord & { entries: DetailList })[];
    comparisons: (DetailRecord & {
      differences: DetailList;
      unassessedFields: DetailList;
    })[];
  };
  scripts: DetailRecord & {
    entries: DetailList;
    bindingGyp: DetailRecord & { files: DetailList };
  };
  inventory: DetailRecord & {
    counts: DetailRecord;
    typeGroups: DetailList;
    topDirectories: DetailList;
    largestFiles: DetailList;
    files: DetailList;
    sourceOnlyPaths: DetailList;
  };
  capabilities: DetailRecord & { observations: DetailList; groups: DetailList };
  provenance: DetailRecord & { facts: DetailList };
  ai: DetailRecord & {
    metadata: DetailList;
    hypotheses: DetailList;
    selection: DetailRecord;
  };
  coverage: DetailRecord & {
    counters: DetailRecord & { states: DetailRecord };
    observations: DetailList;
    failures: DetailList;
    policyFindings: DetailList;
  };
}

function isRecord(value: unknown): value is DetailRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function record(value: unknown): DetailRecord {
  return isRecord(value) ? value : {};
}
export const text = (value: unknown, limit = 600): string =>
  typeof value === "string"
    ? value.slice(0, limit) + (value.length > limit ? "…" : "")
    : "Not recorded";
export const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
export const status = (value: unknown): string =>
  text(value, 120).replaceAll("-", " ");

export function preview(value: unknown, depth = 0): string {
  if (typeof value === "string") return text(value, 600);
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (value === undefined) return "Not recorded";
  if (depth >= 3) return "[…nested declaration]";
  const entries = Array.isArray(value)
    ? value.slice(0, 8).map((item, i) => [String(i), item] as const)
    : Object.entries(record(value)).slice(0, 8);
  const body = entries
    .map(([key, item]) => `${text(key, 80)}: ${preview(item, depth + 1)}`)
    .join(", ");
  return text(body, 600);
}

function isList(value: unknown): value is DetailList {
  const list = record(value);
  return (
    Array.isArray(list.items) &&
    list.items.length <= 20000 &&
    count(list.total) !== null &&
    count(list.returned) === list.items.length &&
    count(list.omitted) !== null &&
    list.total === (list.returned as number) + (list.omitted as number) &&
    isRecord(list.omissionReasons) &&
    Object.values(list.omissionReasons).reduce<number>(
      (sum, value) => sum + (count(value) ?? Number.NaN),
      0,
    ) === list.omitted &&
    Object.values(record(list.omissionReasons)).every(
      (value) => count(value) !== null,
    )
  );
}

export function parsePackageDetails(value: unknown): PackageDetails | null {
  const d = record(value);
  if (
    d.detailsVersion !== "1" ||
    d.reportSchemaVersion !== "1" ||
    record(d.scope).allCodeRead !== false ||
    record(d.scope).safetyVerdict !== "not-provided"
  )
    return null;
  const lists = [
    d.identity,
    record(d.declarations).fields,
    record(d.entrypoints).targets,
    record(d.scripts).entries,
    record(record(d.scripts).bindingGyp).files,
    ...[
      "files",
      "typeGroups",
      "topDirectories",
      "largestFiles",
      "sourceOnlyPaths",
    ].map((key) => record(d.inventory)[key]),
    record(d.capabilities).observations,
    record(d.capabilities).groups,
    record(d.provenance).facts,
    record(d.ai).metadata,
    record(d.ai).hypotheses,
    record(d.coverage).observations,
    record(d.coverage).failures,
    record(d.coverage).policyFindings,
  ];
  if (!lists.every(isList)) return null;
  const deps = record(d.dependencies);
  if (
    !Array.isArray(deps.categories) ||
    deps.categories.length > 6 ||
    !deps.categories.every((item) => isList(record(item).entries)) ||
    !Array.isArray(deps.comparisons) ||
    deps.comparisons.length > 2 ||
    !deps.comparisons.every(
      (item) =>
        isList(record(item).differences) &&
        isList(record(item).unassessedFields),
    )
  )
    return null;
  if (
    Object.keys(record(record(d.coverage).counters)).length === 0 ||
    !isRecord(record(record(d.coverage).counters).states) ||
    !isRecord(record(d.inventory).counts) ||
    !isRecord(record(d.ai).selection)
  )
    return null;
  return d as unknown as PackageDetails;
}

export async function fetchPackageDetails(
  id: string,
): Promise<PackageDetails | null> {
  try {
    const response = await proxyPackageDetails(id);
    return response.status === 200
      ? parsePackageDetails(await response.json())
      : null;
  } catch {
    return null;
  }
}

export function evidenceAnchors(value: unknown): Map<string, string> {
  const evidence = record(value).evidence;
  if (!Array.isArray(evidence)) return new Map();
  const result = new Map<string, string>();
  evidence.slice(0, 40000).forEach((item, index) => {
    const id = record(item).id;
    if (typeof id === "string" && id.length <= 512 && !result.has(id))
      result.set(id, `evidence-${index}`);
  });
  return result;
}
