import "../../ui.css";
import "../../report.css";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ViewerBar } from "@/components/report/ViewerBar";
import { ReportView } from "@/components/report/ReportView";
import { AutoRefresh } from "@/components/report/AutoRefresh";
import { sampleReport } from "@/lib/sample-report.ts";
import { fetchJob, type Job } from "@/lib/analyzer.ts";
import { formatUtc } from "@/lib/report.ts";
import { PackageDetailsView } from "@/components/report/PackageDetailsView";
import { fetchPackageDetails, evidenceAnchors } from "@/lib/package-details.ts";

type Params = Promise<{ id: string }>;

export async function generateMetadata({
  params,
}: {
  params: Params;
}): Promise<Metadata> {
  const { id } = await params;
  return {
    title:
      id === "sample"
        ? "UNMASK · Sample report for clsx@2.1.1"
        : "UNMASK · Report",
    robots: { index: false },
  };
}

const messages: Record<Exclude<Job["status"], "completed">, string> = {
  queued:
    "Waiting for the check before it to finish. This page refreshes on its own.",
  running:
    "Reading the tarball and the source. This page refreshes on its own; reloading does not start another check.",
  incomplete:
    "The check stopped at its limits before it could finish. No retry runs on its own.",
  failed: "The analyzer could not produce a report for this release.",
};

function StatusView({ job }: { job: Job }) {
  const status = job.status === "completed" ? "failed" : job.status;
  const active = status === "queued" || status === "running";
  return (
    <main className="viewer viewer-status" id="main">
      {active ? <AutoRefresh /> : null}
      <div className="title-row">
        <div>
          <h1>{job.nameAtExactVersion}</h1>
          <p className="subtitle">
            Requested {formatUtc(new Date(job.createdAt).toISOString())}
          </p>
        </div>
      </div>
      <section className="card status-card" aria-live="polite">
        <div className="card-head">
          <h2>Check</h2>
          <span className={`pill ${active ? "pill-quiet" : "pill-negative"}`}>
            {status[0].toUpperCase() + status.slice(1)}
          </span>
        </div>
        <p className="status-text-lg">{messages[status]}</p>
        {job.reason ? (
          <p className="faint">
            Reason: <code>{job.reason}</code>
          </p>
        ) : null}
        <p className="status-links">
          <a className="btn" href="/#check">
            {active ? "Check another release" : "Request a new check"}
          </a>
          <a href={`/api/reports/${job.id}`}>View job JSON</a>
        </p>
      </section>
    </main>
  );
}

export default async function ReportPage({ params }: { params: Params }) {
  const { id } = await params;
  if (id === "sample")
    return (
      <div className="app">
        <ViewerBar spec="clsx@2.1.1" />
        <ReportView report={sampleReport} />
      </div>
    );
  const result = await fetchJob(id);
  if (!result.ok) notFound();
  if (result.kind === "report") {
    const details =
      result.schemaVersion === "1" ? await fetchPackageDetails(id) : null;
    if (details)
      return (
        <div className="app">
          <ViewerBar />
          <PackageDetailsView
            details={details}
            id={id}
            analyzer={result.analyzer}
            anchors={evidenceAnchors({ evidence: result.evidence })}
            rawModel={result.modelMetadata}
          />
        </div>
      );
    return (
      <div className="app">
        <ViewerBar />
        <main className="viewer viewer-status" id="main">
          <div className="title-row">
            <div>
              <h1>Report ready</h1>
              <p className="subtitle">
                Check <code>{id.slice(0, 8)}</code>, report schema{" "}
                {result.schemaVersion}
              </p>
            </div>
          </div>
          <section className="card status-card">
            <p className="status-text-lg">
              The package breakdown is unavailable from this analyzer. Its
              schema {result.schemaVersion} report remains available in the
              evidence viewer; opening it does not start another check.
            </p>
            <p className="status-links">
              <a className="btn" href={`${result.analyzer}/r/${id}`}>
                Open the report
              </a>
              <a href={`/api/reports/${id}`}>Download JSON</a>
            </p>
          </section>
        </main>
      </div>
    );
  }
  const { job } = result;
  return (
    <div className="app">
      <ViewerBar spec={job.nameAtExactVersion} />
      {job.status === "completed" && job.report ? (
        <ReportView report={job.report} />
      ) : (
        <StatusView job={job} />
      )}
    </div>
  );
}
