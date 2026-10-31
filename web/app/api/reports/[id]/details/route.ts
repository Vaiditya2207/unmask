import { proxyPackageDetails } from "@/lib/package-details-proxy.ts";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return proxyPackageDetails((await params).id);
}
