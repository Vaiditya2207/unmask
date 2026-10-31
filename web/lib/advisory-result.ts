import { record } from "./package-details.ts";
import {
  parseVulnerabilityCheck,
  type VulnerabilityCheck,
} from "./vulnerabilities.ts";

export interface AdvisoryOnly {
  headline: string;
  detail: string;
  reported: boolean;
  artifactReason: string;
  vulnerability: VulnerabilityCheck;
}

// The analyzer attaches this to failed or timed-out jobs; the display is derived from the revalidated lookup, not its labels.
export function parseAdvisoryResult(
  value: unknown,
  nameAtExactVersion: string,
): AdvisoryOnly | null {
  const result = record(value);
  if (result.schemaVersion !== "1" || result.kind !== "advisory-only")
    return null;
  const at = nameAtExactVersion.lastIndexOf("@");
  const vulnerability = parseVulnerabilityCheck(result.vulnerabilityCheck, {
    name: nameAtExactVersion.slice(0, at),
    version: nameAtExactVersion.slice(at + 1),
  });
  const reason = record(result.artifactVerification).reason;
  const reported = vulnerability.advisories.length > 0;
  return {
    reported,
    artifactReason:
      typeof reason === "string" && /^[a-z0-9-]{1,64}$/.test(reason)
        ? reason
        : "unknown",
    vulnerability,
    headline: reported
      ? vulnerability.status === "found"
        ? "Published advisories match this exact version"
        : "Published advisories match this exact version; the lookup was incomplete"
      : vulnerability.status === "none-reported"
        ? "No advisory reported for this exact version"
        : "Advisory lookup unavailable",
    detail: reported
      ? "The registry artifact was not inspected, so no tarball or source evidence is included."
      : "No artifact was inspected. Absence of a current advisory, or an unavailable lookup, is not evidence of safety, and an unacquirable artifact is not by itself evidence of malware.",
  };
}
