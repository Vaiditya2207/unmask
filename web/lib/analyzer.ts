import { isReport, type Report } from "./report.ts";

// The analyzer service is separate from this site. Set UNMASK_API_URL to its
// origin; without it the site serves the example reports and says so.
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

// Job states as src/server/queue.mjs writes them. A job that finished with a report is never served as a
// job: GET /r/<id>.json returns the bare report instead.
export type JobStatus = "queued" | "running" | "done" | "incomplete" | "failed";

export interface Job {
  id: string;
  nameAtExactVersion: string;
  status: JobStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  reason?: string;
  report?: Report;
  advisoryResult?: unknown;
}

const STATUSES: JobStatus[] = [
  "queued",
  "running",
  "done",
  "incomplete",
  "failed",
];

export type Fetched =
  | { ok: true; kind: "job"; job: Job }
  | { ok: true; kind: "report"; report: Report }
  | { ok: false; status: number };

export async function fetchJob(id: string): Promise<Fetched> {
  const base = analyzerUrl();
  if (!base || !REPORT_ID.test(id)) return { ok: false, status: 404 };
  try {
    const response = await fetch(`${base}/r/${id}.json`, {
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    if (!response.ok) return { ok: false, status: response.status };
    const body = (await response.json()) as unknown;
    if (isReport(body)) return { ok: true, kind: "report", report: body };
    const job = body as Record<string, unknown> | null;
    if (
      job &&
      typeof job.nameAtExactVersion === "string" &&
      STATUSES.includes(job.status as JobStatus) &&
      typeof job.createdAt === "number"
    )
      return {
        ok: true,
        kind: "job",
        job: {
          id,
          nameAtExactVersion: job.nameAtExactVersion,
          status: job.status as JobStatus,
          createdAt: job.createdAt,
          startedAt:
            typeof job.startedAt === "number" ? job.startedAt : undefined,
          finishedAt:
            typeof job.finishedAt === "number" ? job.finishedAt : undefined,
          reason: typeof job.reason === "string" ? job.reason : undefined,
        },
      };
    return { ok: false, status: 502 };
  } catch {
    return { ok: false, status: 502 };
  }
}

// The model fields the package details show when their projection omits its own model metadata. Only these
// keys are read from the raw report; hypotheses stay with the details projection.
export const MODEL_KEYS = [
  "status",
  "modelId",
  "promptHash",
  "configHash",
  "reason",
  "attempts",
] as const;

export function modelMetadata(report: Report): Record<string, unknown> {
  return Object.fromEntries(MODEL_KEYS.map((key) => [key, report.model[key]]));
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
