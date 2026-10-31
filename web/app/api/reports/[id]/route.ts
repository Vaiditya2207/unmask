import { NextResponse } from "next/server";
import { sampleReport } from "@/lib/sample-report.ts";
import { fetchJob } from "@/lib/analyzer.ts";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (id === "sample") return NextResponse.json(sampleReport);
  const result = await fetchJob(id);
  if (!result.ok)
    return NextResponse.json(
      { error: "Report not found" },
      { status: result.status },
    );
  return NextResponse.json(result.job, {
    headers: { "cache-control": "no-store" },
  });
}
