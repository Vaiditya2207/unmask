import {
  buildReportFileInventory,
  explorationJson,
} from "../core/report-exploration.mjs";

function queryParameters(raw, allowed) {
  if (raw.length > 16384) throw new TypeError("Query too long");
  decodeURIComponent(raw.replace(/\+/g, " "));
  const params = new URLSearchParams(raw);
  for (const key of params.keys())
    if (!allowed.includes(key) || params.getAll(key).length !== 1)
      throw new TypeError("Unknown or duplicate query key");
  return params;
}
function integer(params, name, fallback) {
  if (!params.has(name)) return fallback;
  const value = params.get(name);
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new TypeError("Invalid integer");
  return Number(value);
}

export function handleReportExploration({ path, getJob, send }) {
  const match = /^\/r\/([a-f0-9]{32})\/files\.json(?:\?([^#]*))?$/.exec(path);
  if (!match) return false;
  const json = (status, body, headers = {}) =>
    send(status, explorationJson(body), "application/json; charset=utf-8", {
      "content-disposition": 'attachment; filename="unmask-files.json"',
      ...headers,
    });
  let options;
  try {
    const params = queryParameters(match[2] ?? "", [
      "state",
      "prefix",
      "offset",
      "limit",
    ]);
    options = {
      state: params.get("state") ?? "all",
      prefix: params.get("prefix") ?? "",
      offset: integer(params, "offset", 0),
      limit: integer(params, "limit", 50),
    };
    buildReportFileInventory({ files: [] }, options);
  } catch {
    json(400, { error: "invalid-query" });
    return true;
  }
  const job = getJob(match[1]);
  if (!job) json(404, { error: "report-unavailable" });
  else if (!job.report) {
    const pending = ["queued", "running"].includes(job.status);
    json(
      pending ? 202 : 409,
      {
        error: pending ? "report-pending" : "report-unavailable",
        status: job.status,
      },
      pending ? { "retry-after": "3" } : {},
    );
  } else
    json(200, {
      reportId: match[1],
      ...buildReportFileInventory(job.report, options),
    });
  return true;
}
