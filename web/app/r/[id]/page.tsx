import "../../report.css";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { ReportShell } from "@/components/report/ReportShell";
import { ReportView } from "@/components/report/ReportView";
import { JobStatus } from "@/components/report/JobStatus";
import { exampleReport } from "@/lib/sample-report.ts";
import { fetchJob, type Fetched } from "@/lib/analyzer.ts";
import { buildView, type Report } from "@/lib/report.ts";

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
  const crumb = exampleReport(id) ? "Examples" : "Reports";
  if (result.kind === "job")
    return (
      <ReportShell crumb={crumb} spec={result.job.nameAtExactVersion}>
        <JobStatus job={result.job} />
      </ReportShell>
    );
  const view = buildView(result.report);
  const query = await searchParams;
  const download = {
    href: `/api/reports/${id}`,
    filename: `unmask-${view.spec.replace(/[^\w.@-]+/g, "_")}.json`,
  };
  return (
    <ReportShell crumb={crumb} spec={view.spec} download={download}>
      <ReportView
        view={view}
        download={download}
        initialKey={first(query.file)}
        initialTab={first(query.show)}
      />
    </ReportShell>
  );
}
