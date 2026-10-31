import type { Report } from "./report.ts";

// The analyzer service is separate from this site. Set UNMASK_API_URL to its
// origin; without it the site serves the sample report and says so.
export function analyzerUrl(): string | null {
  const value = process.env.UNMASK_API_URL?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

export const REPORT_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type JobStatus =
  "queued" | "running" | "incomplete" | "failed" | "completed";

export interface Job {
  id: string;
  nameAtExactVersion: string;
  status: JobStatus;
  createdAt: number;
  finishedAt?: number;
  reason?: string;
  report?: Report;
}

export async function fetchJob(
  id: string,
): Promise<{ ok: true; job: Job } | { ok: false; status: number }> {
  const base = analyzerUrl();
  if (!base || !REPORT_ID.test(id)) return { ok: false, status: 404 };
  try {
    const response = await fetch(`${base}/r/${id}.json`, {
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    if (!response.ok) return { ok: false, status: response.status };
    return { ok: true, job: (await response.json()) as Job };
  } catch {
    return { ok: false, status: 502 };
  }
}

export const checkErrors: Record<string, string> = {
  invalid:
    "That is not an exact npm release. Use a name and version, such as clsx@2.1.1.",
  offline:
    "The analyzer is not connected to this site yet. The sample report shows what a check returns.",
  busy: "The analyzer is at its limit of six new checks per ten minutes. Try again shortly.",
  failed:
    "The analyzer did not accept the check. Try again, or open the sample report.",
};
