import type { Finding } from "@/lib/report.ts";
import { formatBytes, shortSha } from "@/lib/report.ts";
import { Mark } from "@/components/ui/Mark";

export function EvidencePanel({
  finding,
  wide = false,
  hypothesis = true,
}: {
  finding: Finding;
  wide?: boolean;
  hypothesis?: boolean;
}) {
  const { content } = finding.published;
  const before = content.slice(0, finding.extra.start);
  const added = content.slice(finding.extra.start, finding.extra.end);
  return (
    <div
      className={`ui ui-evidence${wide ? " wide" : ""}`}
      data-ui
      role="group"
      aria-label={`Evidence for ${finding.path}`}
    >
      <div className="ui-head">
        <span className="ui-title">
          <code>{finding.path}</code>
        </span>
        <span className="pill pill-negative">Needs review</span>
      </div>
      <p className="ui-summary">{finding.summary}</p>
      <dl className="ui-compare">
        <div>
          <dt>Expected</dt>
          <dd>
            Built from <code>{finding.expected.from}</code> by{" "}
            <code>{finding.expected.step}</code>
          </dd>
          <dd className="num">{formatBytes(finding.expected.bytes)}</dd>
          <dd>
            <code>{shortSha(finding.expected.sha256)}</code>
          </dd>
        </div>
        <div>
          <dt>Published</dt>
          <dd>
            In the tarball as <code>package/{finding.path}</code>
          </dd>
          <dd className="num">{formatBytes(finding.published.bytes)}</dd>
          <dd>
            <code>{shortSha(finding.published.sha256)}</code>
          </dd>
        </div>
      </dl>
      <pre
        className="ui-code"
        tabIndex={0}
        aria-label={`Contents of ${finding.path}`}
      >
        <code>
          <span className="ui-code-same">{before}</span>
          <mark
            className="ui-code-added"
            title={`Bytes ${finding.extra.start}–${finding.extra.end}`}
          >
            {added}
          </mark>
        </code>
      </pre>
      <ul className="ui-checks" aria-label="Checks">
        {finding.checks.map((check) => (
          <li key={check.label} className={check.passed ? "pass" : "fail"}>
            <span className="ui-check-mark">
              <Mark ok={check.passed} />
            </span>
            <span className="ui-check-label">
              {check.label}
              <span className="visually-hidden">
                {check.passed ? ": passed" : ": did not pass"}
              </span>
            </span>
            <span className="ui-check-detail">{check.detail}</span>
          </li>
        ))}
      </ul>
      {hypothesis && finding.hypothesis ? (
        <div className="ui-hypothesis">
          <p className="ui-hypothesis-head">
            Hypothesis from <code>{finding.hypothesis.model}</code>
            <span className="ui-meta">
              {finding.hypothesis.connected
                ? "cited bytes verified"
                : "written by hand, model not connected"}
            </span>
          </p>
          <p>{finding.hypothesis.text}</p>
        </div>
      ) : null}
    </div>
  );
}
