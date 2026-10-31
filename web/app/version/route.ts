export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    {
      version: process.env.RELEASE_VERSION || "unknown",
      commit: process.env.RELEASE_COMMIT || "unknown",
    },
    { headers: { "cache-control": "no-store" } },
  );
}
