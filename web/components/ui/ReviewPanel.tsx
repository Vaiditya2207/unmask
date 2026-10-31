import type { Report } from "@/lib/report.ts";
import {
  formatBytes,
  formatCount,
  repoLabel,
  shortSha,
  statusLabel,
  tally,
} from "@/lib/report.ts";

export function ReviewPanel({
  report,
  compact = false,
}: {
  report: Report;
  compact?: boolean;
}) {
  const t = tally(report);
  const finding = report.findings[0];
  return (
    <div
      className="ui ui-review"
      data-ui
      role="group"
      aria-label="Review summary"
    >
      <div className="ui-head">
        <span className="ui-title">
          <code>
            {report.release.name}@{report.release.version}
          </code>
        </span>
        <span className="ui-meta">Report</span>
      </div>
      <p className="ui-answer">
        <span className="num">{formatCount(t.review)}</span> of{" "}
        <span className="num">{formatCount(t.published)}</span> published files
        needs review
      </p>
      <p className="ui-sub">
        Against <code>{repoLabel(report.source.repository)}</code> at{" "}
        <code>{shortSha(report.source.commit)}</code>
      </p>
      <dl className="ui-tally">
        <div className="neg">
          <dt>Needs review</dt>
          <dd className="num">{formatCount(t.review)}</dd>
        </div>
        <div>
          <dt>Built from source</dt>
          <dd className="num">{formatCount(t.built)}</dd>
        </div>
        <div>
          <dt>Byte-identical</dt>
          <dd className="num">{formatCount(t.identical)}</dd>
        </div>
        <div>
          <dt>Only in source</dt>
          <dd className="num">{formatCount(t.sourceOnly)}</dd>
        </div>
      </dl>
      {compact ? null : (
        <ul className="ui-status-list" aria-label="Published files">
          {report.files.map((file) => (
            <li key={file.path} className={file.explanation.kind}>
              <code>{file.path}</code>
              <span>{statusLabel[file.explanation.kind]}</span>
            </li>
          ))}
        </ul>
      )}
      {finding ? (
        <div className="ui-next">
          <p>
            <code>{finding.path}</code> carries{" "}
            <span className="num">
              {formatBytes(finding.extra.end - finding.extra.start)}
            </span>{" "}
            that no build step produces.
          </p>
          <p className="ui-meta">
            UNMASK never marks a release safe. A person decides.
          </p>
        </div>
      ) : null}
      <div className="ui-actions">
        <a
          className="ui-btn ui-btn-primary"
          href={`/r/${report.id}#${finding?.id ?? "files"}`}
        >
          Open evidence
        </a>
        <a
          className="ui-btn"
          href={`/api/reports/${report.id}`}
          download={`unmask-${report.id}.json`}
        >
          Download JSON
        </a>
      </div>
    </div>
  );
}
