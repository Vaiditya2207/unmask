import { count, record, text, type DetailRecord } from "./package-details.ts";

type Status =
  "not-assessed" | "found" | "none-reported" | "incomplete" | "unavailable";
export interface VulnerabilityCheck {
  status: Status;
  package: { name: string; version: string } | null;
  queriedAt: string | null;
  reasons: string[];
  advisories: DetailRecord[];
  pagesFetched: number | null;
}
export function safeHttps(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    /[\s\x00-\x1f\x7f]/.test(value)
  )
    return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export function parseVulnerabilityCheck(
  value: unknown,
  requested: DetailRecord,
): VulnerabilityCheck {
  const check = record(value);
  const base: VulnerabilityCheck = {
    status: "not-assessed",
    package: null,
    queriedAt: null,
    reasons: [],
    advisories: [],
    pagesFetched: null,
  };
  if (value === undefined || check.status === "not-assessed") return base;
  const invalid = (reason: string): VulnerabilityCheck => ({
    ...base,
    status: "unavailable",
    reasons: [reason],
  });
  if (
    check.schemaVersion !== "1" ||
    check.source !== "OSV" ||
    typeof check.status !== "string" ||
    !["found", "none-reported", "incomplete", "unavailable"].includes(
      String(check.status),
    ) ||
    !Array.isArray(check.advisories) ||
    !Array.isArray(check.reasons) ||
    !check.reasons.every((item) => typeof item === "string") ||
    typeof check.complete !== "boolean"
  )
    return invalid("invalid-lookup-contract");
  const pkg = record(check.package);
  if (
    check.package !== null &&
    (pkg.ecosystem !== "npm" ||
      typeof pkg.name !== "string" ||
      typeof pkg.version !== "string" ||
      pkg.name !== requested.name ||
      pkg.version !== requested.version)
  )
    return invalid("lookup-identity-mismatch");
  const queriedAt =
    typeof check.queriedAt === "string" &&
    check.queriedAt.length <= 64 &&
    /^\d{4}-\d{2}-\d{2}T.+Z$/.test(check.queriedAt) &&
    Number.isFinite(Date.parse(check.queriedAt))
      ? check.queriedAt
      : null;
  if (!queriedAt || count(check.pagesFetched) === null)
    return invalid("lookup-metadata-unavailable");
  const reasons = check.reasons.slice(0, 20).map((item) => text(item, 120));
  const advisories: DetailRecord[] = [];
  for (const item of check.advisories.slice(0, 100)) {
    const advisory = record(item);
    if (
      typeof advisory.id === "string" &&
      /^[a-zA-Z0-9:_.-]{1,256}$/.test(advisory.id)
    )
      advisories.push(advisory);
    else if (!reasons.includes("invalid-advisory-record"))
      reasons.push("invalid-advisory-record");
  }
  if (check.advisories.length > 100) reasons.push("advisory-list-cap");
  if (
    check.pagesFetched === 0 &&
    ["found", "none-reported"].includes(String(check.status))
  )
    reasons.push("no-completed-lookup-page");
  if (check.package === null && advisories.length > 0)
    return invalid("lookup-identity-missing");
  let status = check.status as Status;
  if (
    status !== "unavailable" &&
    (check.complete !== true ||
      reasons.length > 0 ||
      (status === "found" && advisories.length === 0) ||
      (status === "none-reported" && advisories.length !== 0))
  )
    status = "incomplete";
  if (
    (status === "found" || status === "none-reported") &&
    check.package === null
  )
    return invalid("lookup-identity-missing");
  return {
    status,
    package:
      check.package === null
        ? null
        : { name: text(pkg.name, 214), version: text(pkg.version, 100) },
    queriedAt,
    reasons,
    advisories,
    pagesFetched: count(check.pagesFetched),
  };
}
