import { parseAdvisoryResult } from "@/lib/advisory-result.ts";
import type { Job } from "@/lib/analyzer.ts";
import { formatUtc } from "@/lib/report.ts";
import { AutoRefresh } from "@/components/report/AutoRefresh";

const pending: Record<"queued" | "running", string> = {
  queued:
    "Waiting for the check ahead of it to finish. This page updates on its own.",
  running: "Reading the tarball and the source. This page updates on its own.",
};

// Reasons the server writes on a job that has no report (src/server/queue.mjs).
const stopped: Record<string, { title: string; text: string }> = {
  "execution-timeout": {
    title: "The check stopped at its limits",
    text: "The analysis ran past its time limit, so there is no evidence to show for this release.",
  },
  "queue-expired": {
    title: "The check stopped at its limits",
    text: "The check waited too long for its turn and was dropped before it started.",
  },
  "report-too-large": {
    title: "The check stopped at its limits",
    text: "The report was larger than the server keeps, so it was not stored.",
  },
  "analysis-failed": {
    title: "The check could not finish",
    text: "The analyzer could not produce a report for this release. The version may not exist on npm, or a download or the analysis failed.",
  },
};

const skeleton = [
  ["Integrity", 132],
  ["Source", 104],
  ["Provenance", 88],
  ["Model", 28],
] as const;

export function JobStatus({ job }: { job: Job }) {
  if (job.status === "queued" || job.status === "running") {
    const started = job.startedAt
      ? `Started ${formatUtc(job.startedAt, true)}`
      : `Queued ${formatUtc(job.createdAt, true)}`;
    return (
      <>
        <AutoRefresh />
        <header className="report-header">
          <div className="report-header__text">
            <h1 className="report-title">Checking {job.nameAtExactVersion}</h1>
            <p className="report-meta">
              <span className="report-meta__line">{started}</span>
            </p>
          </div>
        </header>
        <section
          className="report-card state-card"
          aria-label="Check in progress"
        >
          <div className="progress-panel">
            <div className="progress-panel__status" role="status">
              <span className="state-pill state-pill--neutral">
                {job.status === "queued" ? "Queued" : "Running"}
              </span>
              <p className="progress-panel__text">{pending[job.status]}</p>
            </div>
            <div
              className="progress-track"
              role="progressbar"
              aria-label="Checking"
            >
              <span className="progress-track__segment" />
            </div>
          </div>
          <dl className="status-grid skeleton-grid">
            {skeleton.map(([label, width]) => (
              <div key={label} className="status-cell">
                <dt className="status-cell__label">{label}</dt>
                <dd>
                  <span className="skeleton-bar" style={{ width }} />
                  <span className="visually-hidden">Pending</span>
                </dd>
              </div>
            ))}
          </dl>
        </section>
        <footer className="report-foot">
          <p className="report-foot__note">
            UNMASK shows evidence for review and never declares a package safe.
            Reloading this page does not start another check.
          </p>
        </footer>
      </>
    );
  }
  const advisory = parseAdvisoryResult(
    job.advisoryResult,
    job.nameAtExactVersion,
  );
  if (advisory)
    return (
      <section className="report-card state-card advisory-recovery">
        <header className="report-header">
          <div className="report-header__text">
            <h1 className="report-title">{job.nameAtExactVersion}</h1>
            <p className="report-meta">
              Advisory-only result · artifact not inspected
            </p>
          </div>
        </header>
        <h2 className="report-card__title">{advisory.headline}</h2>
        <p>{advisory.detail}</p>
        <ul>
          {advisory.vulnerability.advisories.map((item, index) => (
            <li key={index}>
              <strong>
                {typeof item.id === "string"
                  ? item.id.slice(0, 160)
                  : "Advisory"}
              </strong>
              {typeof item.summary === "string" ? (
                <p>{item.summary.slice(0, 1200)}</p>
              ) : null}
            </li>
          ))}
        </ul>
        <p className="report-foot__note">
          Lookup status: {advisory.vulnerability.status}. Artifact:{" "}
          {advisory.artifactReason}. Full retained data is available in{" "}
          <a href={`/api/reports/${job.id}`}>the JSON download</a>.
        </p>
      </section>
    );
  const copy = stopped[job.reason ?? ""] ?? stopped["analysis-failed"];
  const label = job.status === "incomplete" ? "Incomplete" : "Failed";
  return (
    <>
      <header className="report-header">
        <div className="report-header__text">
          <h1 className="report-title">{job.nameAtExactVersion}</h1>
          <p className="report-meta">
            <span className="report-meta__line">
              {job.finishedAt ? (
                <>
                  Stopped {formatUtc(job.finishedAt)}
                  <span className="meta-sep" aria-hidden="true">
                    ·
                  </span>
                </>
              ) : null}
              No report was written
            </span>
          </p>
        </div>
      </header>
      <section className="report-card state-card" aria-label="Check stopped">
        <div className="stopped-panel">
          <div className="stopped-panel__body">
            <div className="stopped-panel__head">
              <span className="state-pill state-pill--neutral">{label}</span>
              <h2 className="stopped-panel__title">{copy.title}</h2>
            </div>
            <p className="stopped-panel__text">{copy.text}</p>
            {job.reason ? (
              <p className="stopped-panel__reason">
                Reason <code className="reason-code">{job.reason}</code>
              </p>
            ) : null}
          </div>
          <form className="stopped-panel__action" method="post" action="/check">
            <input
              type="hidden"
              name="package"
              value={job.nameAtExactVersion}
            />
            <button className="button button--secondary" type="submit">
              Check again
            </button>
          </form>
        </div>
      </section>
      <footer className="report-foot">
        <p className="report-foot__note">
          UNMASK shows evidence for review and never declares a package safe.
          Checking again counts towards the limit of six new checks per ten
          minutes.
        </p>
      </footer>
    </>
  );
}
