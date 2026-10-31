export const DETAILS_RESPONSE_LIMITS = Object.freeze({
  packageDetailsBytes: 2097152,
  vulnerabilityCheckBytes: 2096128,
  combinedBytes: 4194304,
});

export function unavailableVulnerabilityCheck(spec, clock, reason) {
  const separator = typeof spec === "string" ? spec.lastIndexOf("@") : -1;
  return {
    schemaVersion: "1",
    source: "OSV",
    package:
      separator > 0
        ? {
            ecosystem: "npm",
            name: spec.slice(0, separator),
            version: spec.slice(separator + 1),
          }
        : null,
    queriedAt: new Date(clock.now()).toISOString(),
    status: "unavailable",
    complete: false,
    reasons: [reason],
    advisories: [],
    pagesFetched: 0,
    limits: { resultBytes: DETAILS_RESPONSE_LIMITS.vulnerabilityCheckBytes },
  };
}

export function boundedVulnerabilityCheck(value, spec, clock) {
  try {
    const json = JSON.stringify(value);
    if (
      Buffer.byteLength(json) > DETAILS_RESPONSE_LIMITS.vulnerabilityCheckBytes
    )
      return unavailableVulnerabilityCheck(spec, clock, "result-byte-cap");
    const snapshot = JSON.parse(json);
    if (
      snapshot.schemaVersion !== "1" ||
      snapshot.source !== "OSV" ||
      !["found", "none-reported", "incomplete", "unavailable"].includes(
        snapshot.status,
      ) ||
      snapshot.complete !==
        ["found", "none-reported"].includes(snapshot.status) ||
      !Array.isArray(snapshot.reasons) ||
      !snapshot.reasons.every((reason) => typeof reason === "string") ||
      !Array.isArray(snapshot.advisories) ||
      snapshot.advisories.some(
        (item) => !item || typeof item !== "object" || Array.isArray(item),
      ) ||
      (snapshot.status === "found" && snapshot.advisories.length === 0) ||
      (snapshot.status === "none-reported" &&
        snapshot.advisories.length !== 0) ||
      !Number.isSafeInteger(snapshot.pagesFetched) ||
      snapshot.pagesFetched < 0 ||
      (snapshot.complete &&
        (snapshot.pagesFetched === 0 || snapshot.reasons.length !== 0)) ||
      typeof snapshot.queriedAt !== "string" ||
      !Number.isFinite(Date.parse(snapshot.queriedAt)) ||
      !snapshot.limits ||
      typeof snapshot.limits !== "object"
    )
      throw new TypeError("Invalid vulnerability enrichment");
    const expected = unavailableVulnerabilityCheck(
      spec,
      clock,
      "unused",
    ).package;
    if (
      snapshot.package !== null &&
      (snapshot.package.ecosystem !== "npm" ||
        snapshot.package.name !== expected?.name ||
        snapshot.package.version !== expected?.version)
    )
      throw new TypeError("Vulnerability enrichment identity mismatch");
    if (snapshot.complete && snapshot.package === null)
      throw new TypeError("Vulnerability enrichment identity missing");
    return snapshot;
  } catch {
    return unavailableVulnerabilityCheck(spec, clock, "invalid-result");
  }
}

export function attachVulnerabilityCheck(details, value) {
  const vulnerabilityCheck = value ?? {
    source: "OSV",
    status: "not-assessed",
    complete: false,
    reasons: ["hosted-enrichment-disabled"],
    advisories: [],
  };
  const complete =
    vulnerabilityCheck.complete === true &&
    ["found", "none-reported"].includes(vulnerabilityCheck.status);
  const result = {
    ...details,
    scope: {
      ...details.scope,
      vulnerabilityScan: complete
        ? "OSV-exact-package-query-complete"
        : "not-assessed",
      knownVulnerabilities: complete
        ? "queried-exact-package-only"
        : "not-assessed",
    },
    vulnerabilityCheck,
    responseLimits: DETAILS_RESPONSE_LIMITS,
  };
  if (
    Buffer.byteLength(JSON.stringify(result)) >
    DETAILS_RESPONSE_LIMITS.combinedBytes
  )
    throw new TypeError("Combined details response exceeds cap");
  return result;
}
