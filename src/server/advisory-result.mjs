import {
  boundedVulnerabilityCheck,
  unavailableVulnerabilityCheck,
} from "./enrichment.mjs";

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

export const ADVISORY_ENDPOINT_LIMITS = Object.freeze({
  maxLookups: 30,
  windowMs: 600000,
  maxActive: 2,
  timeoutMs: 15000,
});

export function createAdvisoryService({
  lookup,
  clock,
  limits = ADVISORY_ENDPOINT_LIMITS,
}) {
  const inflight = new Map();
  const shutdown = new AbortController();
  let admissions = [];
  function run(spec) {
    const controller = new AbortController();
    const signal = AbortSignal.any([shutdown.signal, controller.signal]);
    let timer;
    const timeout = new Promise((resolve) => {
      timer = clock.setTimeout(() => {
        controller.abort();
        resolve(unavailableVulnerabilityCheck(spec, clock, "timeout"));
      }, limits.timeoutMs);
      timer?.unref?.();
    });
    return Promise.race([
      Promise.resolve()
        .then(() => lookup(spec, { signal }))
        .then((value) => boundedVulnerabilityCheck(value, spec, clock))
        .catch(() =>
          unavailableVulnerabilityCheck(spec, clock, "lookup-failed"),
        ),
      timeout,
    ])
      .then((check) =>
        advisoryOnlyResult(check, { artifactReason: "not-requested" }),
      )
      .finally(() => {
        clock.clearTimeout(timer);
        inflight.delete(spec);
      });
  }
  return {
    request(spec) {
      const existing = inflight.get(spec);
      if (existing) return { promise: existing, reused: true };
      const now = clock.now();
      admissions = admissions.filter((time) => now - time < limits.windowMs);
      if (
        shutdown.signal.aborted ||
        inflight.size >= limits.maxActive ||
        admissions.length >= limits.maxLookups
      )
        return {
          retryAfter: Math.max(
            1,
            Math.ceil(
              (admissions.length >= limits.maxLookups
                ? admissions[0] + limits.windowMs - now
                : limits.timeoutMs) / 1000,
            ),
          ),
        };
      admissions.push(now);
      const promise = run(spec);
      inflight.set(spec, promise);
      return { promise, reused: false };
    },
    close() {
      shutdown.abort();
    },
  };
}
