const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        ch
      ],
  );

const ASSESSMENTS = {
  found: "advisories-reported",
  incomplete: "advisory-lookup-incomplete",
  "none-reported": "no-advisory-reported",
  unavailable: "advisory-lookup-unavailable",
};

export function advisoryOnlyResult(vulnerabilityCheck, { artifactReason }) {
  const status = vulnerabilityCheck?.status;
  const assessment = ASSESSMENTS[status] ?? "advisory-lookup-unavailable";
  return {
    schemaVersion: "1",
    kind: "advisory-only",
    package: vulnerabilityCheck?.package ?? null,
    assessment,
    advisoryCount: vulnerabilityCheck?.advisories?.length ?? 0,
    artifactVerification: { status: "not-performed", reason: artifactReason },
    sourceComparison: { status: "not-performed", reason: artifactReason },
    safetyVerdict: "not-provided",
    notice:
      assessment === "advisories-reported" ||
      (assessment === "advisory-lookup-incomplete" &&
        vulnerabilityCheck.advisories.length > 0)
        ? "Published advisories match this exact version. The registry artifact was not inspected, so no tarball or source evidence is included."
        : "No artifact was inspected. Absence of a current advisory, or an unavailable lookup, is not evidence of safety, and an unacquirable artifact is not by itself evidence of malware.",
    vulnerabilityCheck,
  };
}

export function renderAdvisoryResult(result) {
  const check = result.vulnerabilityCheck;
  const items = (check?.advisories ?? [])
    .slice(0, 50)
    .map(
      (item) =>
        `<li><code>${escape(item.id)}</code>${item.aliases?.length ? ` (${item.aliases.map(escape).join(", ")})` : ""}${item.summary ? `: ${escape(item.summary)}` : ""}</li>`,
    )
    .join("");
  return `<section aria-label="Advisory-only result"><h2>Advisory-only result</h2><p class="status failed">${escape(result.assessment)}</p><p>${escape(result.notice)}</p>${items ? `<ul>${items}</ul>` : ""}<p class="meta">OSV lookup status: <code>${escape(check?.status)}</code>${check?.reasons?.length ? `; reasons: <code>${check.reasons.map(escape).join(", ")}</code>` : ""}. Artifact verification: <code>${escape(result.artifactVerification.status)}</code>.</p></section>`;
}

export function withAdvisoryResult(statusHtml, job) {
  if (!job.advisoryResult) return statusHtml;
  return statusHtml.replace(
    "</div></main>",
    () => renderAdvisoryResult(job.advisoryResult) + "</div></main>",
  );
}
