import { NextResponse } from "next/server";
import { sampleReport } from "@/lib/sample-report.ts";
import { analyzerUrl, REPORT_ID } from "@/lib/analyzer.ts";

// Serves the sample, or passes the analyzer's job or report JSON through unchanged.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (id === "sample") return NextResponse.json(sampleReport);
  const base = analyzerUrl();
  if (!base || !REPORT_ID.test(id))
    return NextResponse.json({ error: "Report not found" }, { status: 404 });
  try {
    const response = await fetch(`${base}/r/${id}.json`, {
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    return new NextResponse(await response.text(), {
      status: response.status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Analyzer unavailable" },
      { status: 502 },
    );
  }
}
