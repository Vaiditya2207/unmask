import "./ui.css";
import "./report.css";
import { ViewerBar } from "@/components/report/ViewerBar";

export default function NotFound() {
  return (
    <div className="app">
      <ViewerBar />
      <main className="viewer viewer-status" id="main">
        <div className="title-row">
          <div>
            <h1>No report here</h1>
            <p className="subtitle">
              Reports are kept for up to 24 hours, and this site may have no
              analyzer connected.
            </p>
          </div>
        </div>
        <section className="card status-card">
          <p className="status-text-lg">
            Check the release again, or open the sample report to see what a
            check returns.
          </p>
          <p className="status-links">
            <a className="btn" href="/#check">
              Check a release
            </a>
            <a href="/r/sample">Open the sample report</a>
          </p>
        </section>
      </main>
    </div>
  );
}
