import {
  evaluateGuardDecision,
  getGuardProfile,
} from "../core/guard-policy.mjs";

export function guardDecisionResponse(job, { search = "" } = {}) {
  const params = new URLSearchParams(search);
  const profile = params.has("profile") ? params.get("profile") : "strict";
  try {
    if (params.size > 1 || [...params.keys()].some((key) => key !== "profile"))
      throw new TypeError("Invalid query");
    getGuardProfile(profile);
  } catch {
    return {
      status: 400,
      body: {
        error: "invalid-guard-profile",
        profiles: ["strict", "balanced", "audit"],
      },
    };
  }
  if (!job) return { status: 404, body: { error: "report-unavailable" } };
  const pending = ["queued", "running"].includes(job.status);
  return {
    status: pending ? 202 : 200,
    body: {
      ...evaluateGuardDecision(job, { profile }),
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
