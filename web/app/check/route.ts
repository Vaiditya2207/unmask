import { NextResponse } from "next/server";
import { parseSpec } from "@/lib/registry.ts";
import { analyzerUrl, REPORT_ID } from "@/lib/analyzer.ts";

// Accepts the home page form, validates the release, and hands it to the analyzer.
export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  const value = String(form?.get("package") ?? "")
    .trim()
    .slice(0, 300);
  const back = (error: string) =>
    NextResponse.redirect(
      new URL(
        `/?check=${encodeURIComponent(value)}&error=${error}#check`,
        request.url,
      ),
      303,
    );
  const toReport = (id: string) =>
    NextResponse.redirect(new URL(`/r/${id}`, request.url), 303);

  const spec = parseSpec(value, { exact: true });
  if (!spec.ok) return back("invalid");
  const api = analyzerUrl();
  if (!api) return back("offline");

  try {
    const response = await fetch(`${api}/check`, {
      method: "POST",
      body: new URLSearchParams({ package: `${spec.name}@${spec.version}` }),
      redirect: "manual",
      headers: { accept: "application/json" },
    });
    if (response.status === 429) return back("busy");
    const location = response.headers
      .get("location")
      ?.match(/\/r\/([A-Za-z0-9_-]{1,64})(?:$|[?#.])/);
    if (location) return toReport(location[1]);
    if (response.ok) {
      const body = (await response.json().catch(() => null)) as {
        id?: unknown;
      } | null;
      if (typeof body?.id === "string" && REPORT_ID.test(body.id))
        return toReport(body.id);
    }
    return back("failed");
  } catch {
    return back("failed");
  }
}

export function GET(request: Request) {
  return NextResponse.redirect(new URL("/#check", request.url), 303);
}
