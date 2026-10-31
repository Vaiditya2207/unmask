import {
  buildCycloneDxSbom,
  CYCLONEDX_MEDIA_TYPE,
} from "../core/evidence-exports.mjs";

const EXPORTS = {
  "cdx.json": {
    type: `${CYCLONEDX_MEDIA_TYPE}; charset=utf-8`,
    filename: "unmask-sbom.cdx.json",
    build: (report, versionInfo) =>
      buildCycloneDxSbom(report, { toolVersion: versionInfo.version }),
  },
};

export function matchExportPath(path) {
  const match = /^\/r\/([a-f0-9]{32})\.([a-z]+\.json)$/.exec(path);
  return match && Object.hasOwn(EXPORTS, match[2])
    ? { id: match[1], kind: match[2] }
    : null;
}

export function serveExport({ path, queue, versionInfo, send }) {
  const route = matchExportPath(path);
  if (!route) return false;
  const json = (status, value, headers = {}, type = "application/json") =>
    send(status, JSON.stringify(value), `${type}; charset=utf-8`, headers);
  const job = queue.get(route.id);
  if (!job) {
    json(404, { error: "report-unavailable" });
    return true;
  }
  if (["queued", "running"].includes(job.status)) {
    json(202, { status: job.status }, { "retry-after": "3" });
    return true;
  }
  if (!job.report) {
    json(409, { error: "report-not-produced", status: job.status });
    return true;
  }
  const spec = EXPORTS[route.kind];
  let body;
  try {
    body = spec.build(job.report, versionInfo);
  } catch {
    json(422, { error: "report-not-exportable" });
    return true;
  }
  send(200, JSON.stringify(body), spec.type, {
    "content-disposition": `attachment; filename="${spec.filename}"`,
  });
  return true;
}
