import { analyzerUrl, REPORT_ID } from "./analyzer.ts";

export const DETAILS_BYTES = 4 * 1024 * 1024;

export async function readDetailsBody(response: Response): Promise<string> {
  if (Number(response.headers.get("content-length")) > DETAILS_BYTES)
    throw new Error("Details exceed the response limit");
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > DETAILS_BYTES)
        throw new Error("Details exceed the response limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(joined);
}

export async function proxyPackageDetails(
  id: string,
  origin: string | null = analyzerUrl(),
): Promise<Response> {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
  if (!origin || !REPORT_ID.test(id))
    return Response.json(
      { error: "Report not found" },
      { status: 404, headers },
    );
  try {
    const response = await fetch(`${origin}/r/${id}.details.json`, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      headers: { accept: "application/json" },
    });
    const body = await readDetailsBody(response);
    const forwarded = new Headers(headers);
    for (const name of ["retry-after", "content-disposition"]) {
      const value = response.headers.get(name);
      if (value) forwarded.set(name, value);
    }
    return new Response([204, 304].includes(response.status) ? null : body, {
      status: response.status,
      headers: forwarded,
    });
  } catch {
    return Response.json(
      { error: "Package details unavailable" },
      { status: 502, headers },
    );
  }
}
