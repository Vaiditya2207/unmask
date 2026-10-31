import "../../report.css";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { ReportShell } from "@/components/report/ReportShell";
import { ReportView, showsExplorer } from "@/components/report/ReportView";
import { JobStatus } from "@/components/report/JobStatus";
import { PackageDetailsView } from "@/components/report/PackageDetailsView";
import { exampleReport } from "@/lib/sample-report.ts";
import {
  analyzerUrl,
  fetchJob,
  modelMetadata,
  type Fetched,
} from "@/lib/analyzer.ts";
import { buildView, evidencePaths, type Report } from "@/lib/report.ts";
import {
  evidenceAnchors,
  fetchPackageDetails,
  record,
} from "@/lib/package-details.ts";
import { parseVulnerabilityCheck } from "@/lib/vulnerabilities.ts";

type Params = Promise<{ id: string }>;
type Search = Promise<Record<string, string | string[] | undefined>>;

// One fetch per request, shared by the metadata and the page.
const load = cache(async (id: string): Promise<Fetched> => {
  const example = exampleReport(id);
  if (example) return { ok: true, kind: "report", report: example };
  return fetchJob(id);
});

const specOf = (report: Report) =>
  report.inputs.claim
    ? `${report.inputs.claim.name}@${report.inputs.claim.version}`
    : "Report";

const first = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

const fileName = (spec: string) => spec.replace(/[^\w.@-]+/g, "_");

export async function generateMetadata({
  params,
}: {
  params: Params;
}): Promise<Metadata> {
  const { id } = await params;
  const result = await load(id);
  const name = !result.ok
    ? "Report"
    : result.kind === "report"
      ? specOf(result.report)
      : result.job.nameAtExactVersion;
  return { title: `UNMASK · ${name}`, robots: { index: false } };
}

export default async function ReportPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Search;
}) {
  const { id } = await params;
  const result = await load(id);
  if (!result.ok) notFound();
  const example = exampleReport(id) !== null;
  const crumb = example ? "Examples" : "Reports";
  if (result.kind === "job")
    return (
      <ReportShell crumb={crumb} spec={result.job.nameAtExactVersion}>
        <JobStatus job={result.job} />
      </ReportShell>
    );
  const { report } = result;
  const view = buildView(report);
  const query = await searchParams;
  const download = {
    href: `/api/reports/${id}`,
    filename: `unmask-${fileName(view.spec)}.json`,
  };

  // A live report also has the analyzer's package-details projection. The examples have none, so they
  // render as before; a live report without one keeps the whole comparison and says so once.
  const analyzer = example ? null : analyzerUrl();
  const details = analyzer ? await fetchPackageDetails(id) : null;
  const check = details
    ? parseVulnerabilityCheck(
        details.vulnerabilityCheck,
        record(record(details.identity.items[0]).requested),
      )
    : null;
  const advisories =
    check && (check.status === "found" || check.status === "incomplete")
      ? {
          count: check.advisories.length,
          complete: check.status === "found",
        }
      : null;

  return (
    <ReportShell
      crumb={crumb}
      spec={view.spec}
      download={download}
      details={
        details
          ? {
              href: `/api/reports/${id}/details`,
              filename: `unmask-${fileName(view.spec)}-details.json`,
            }
          : undefined
      }
    >
      <ReportView
        view={view}
        download={download}
        initialKey={first(query.file)}
        initialTab={first(query.show)}
        advisories={advisories}
      >
        {analyzer && details ? (
          <PackageDetailsView
            details={details}
            id={id}
            analyzer={analyzer}
            anchors={evidenceAnchors({ evidence: report.evidence })}
            rawModel={modelMetadata(report)}
            evidencePaths={
              showsExplorer(view) ? evidencePaths(report) : undefined
            }
          />
        ) : analyzer ? (
          <p className="pkg-unavailable">
            Package details, including the OSV advisory lookup, are not
            available from the analyzer for this report. The comparison above
            does not depend on them.
          </p>
        ) : null}
      </ReportView>
    </ReportShell>
  );
}
