import "./report.css";
import { ReportShell } from "@/components/report/ReportShell";

export default function NotFound() {
  return (
    <ReportShell>
      <header className="report-header">
        <div className="report-header__text">
          <h1 className="report-title">No report here</h1>
          <p className="report-meta">
            <span className="report-meta__line">
              The analyzer keeps a report for up to 30 minutes.
            </span>
          </p>
        </div>
      </header>
      <section className="report-card state-card" aria-label="Report missing">
        <div className="stopped-panel">
          <div className="stopped-panel__body">
            <h2 className="stopped-panel__title">
              This report has expired, or it never existed
            </h2>
            <p className="stopped-panel__text">
              Check the release again, or open an example report to see what a
              check returns.
            </p>
          </div>
          <p className="stopped-panel__links">
            <a className="button button--secondary" href="/r/sample">
              Open an example
            </a>
            <a className="button button--compact" href="/#check">
              Check a release
            </a>
          </p>
        </div>
      </section>
    </ReportShell>
  );
}
