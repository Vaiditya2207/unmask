import { NextResponse } from "next/server";
import { exampleReport } from "@/lib/sample-report.ts";
import { analyzerUrl, REPORT_ID } from "@/lib/analyzer.ts";
import { isReport, type Report } from "@/lib/report.ts";

const json = "application/json; charset=utf-8";

function attachment(report: Report) {
  const claim = report.inputs.claim;
  const name = claim ? `${claim.name}@${claim.version}` : "report";
  return `attachment; filename="unmask-${name.replace(/[^\w.@-]+/g, "_")}.json"`;
}

// Serves an example report, or passes the analyzer's job or report JSON through unchanged.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const example = exampleReport(id);
  if (example)
    return new NextResponse(`${JSON.stringify(example, null, 2)}\n`, {
      headers: {
        "content-type": json,
        "content-disposition": attachment(example),
      },
    });
  const base = analyzerUrl();
  if (!base || !REPORT_ID.test(id))
    return NextResponse.json({ error: "Report not found" }, { status: 404 });
  try {
    const response = await fetch(`${base}/r/${id}.json`, {
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    // The analyzer answers a missing or expired id with an HTML page; keep this endpoint JSON.
    if (!response.ok)
      return NextResponse.json(
        {
          error:
            response.status === 404 ? "Report not found" : "Analyzer error",
        },
        { status: response.status },
      );
    const body = await response.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      return NextResponse.json({ error: "Analyzer error" }, { status: 502 });
    }
    return new NextResponse(body, {
      status: response.status,
      headers: {
        "content-type": json,
        "cache-control": "no-store",
        ...(isReport(parsed)
          ? { "content-disposition": attachment(parsed) }
          : {}),
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Analyzer unavailable" },
      { status: 502 },
    );
  }
}
