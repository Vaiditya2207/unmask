import { evaluateGuardDecision } from "../core/guard-policy.mjs";

export function guardDecisionResponse(job) {
  if (!job) return { status: 404, body: { error: "report-unavailable" } };
  const pending = ["queued", "running"].includes(job.status);
  return {
    status: pending ? 202 : 200,
    body: {
      ...evaluateGuardDecision(job),
      reportId: job.id,
      checkStatus: job.status,
      assessedAt:
        job.finishedAt === undefined
          ? null
          : new Date(job.finishedAt).toISOString(),
    },
    headers: pending ? { "retry-after": "3" } : {},
  };
}
