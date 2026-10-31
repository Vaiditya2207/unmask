const deterministicCaps = new Set([
  "compressed-cap",
  "expanded-cap",
  "ratio-cap",
  "entry-cap",
  "path-cap",
  "path-depth-cap",
  "path-node-cap",
  "metadata-cap",
]);
const deterministicAdvisoryCaps = new Set([
  "result-byte-cap",
  "storage-byte-cap",
  "response-limit",
  "page-limit",
  "advisory-limit",
  "record-limit",
]);
const transientModelStatuses = new Set([
  "unavailable",
  "timeout",
  "failed",
  "invalid",
  "quota-exceeded",
]);

function reusable(record) {
  // A transiently incomplete advisory snapshot stays readable by id but must not answer a resubmission; repeatable caps may.
  if (
    !record.report ||
    transientModelStatuses.has(record.report.model?.status) ||
    (record.vulnerabilityCheck !== undefined &&
      record.vulnerabilityCheck?.complete !== true &&
      !(
        record.vulnerabilityCheck?.reasons?.length > 0 &&
        record.vulnerabilityCheck.reasons.every((reason) =>
          deterministicAdvisoryCaps.has(reason),
        )
      ))
  )
    return false;
  if (record.status === "done") return record.report.policy?.exitCode !== 2;
  return (
    record.status === "incomplete" &&
    record.report.policy?.exitCode === 2 &&
    record.report.failures?.length > 0 &&
    record.report.failures.every(
      (failure) =>
        deterministicCaps.has(failure.code) ||
        (failure.code === "source-selection-unresolved" &&
          failure.reason === "ambiguous-manifest"),
    )
  );
}

export function createReportStore({
  maxEntries = 200,
  maxBytes = 64 * 1024 * 1024,
  ttlMs = 1800000,
  clock = { now: Date.now },
} = {}) {
  for (const value of [maxEntries, maxBytes, ttlMs])
    if (!Number.isSafeInteger(value) || value < 1)
      throw new TypeError("Store limits must be positive integers");
  const records = new Map();
  let bytes = 0;
  function remove(id) {
    const record = records.get(id);
    if (record) {
      bytes -= record.bytes;
      records.delete(id);
    }
  }
  function expire() {
    for (const [id, record] of records)
      if (clock.now() >= record.expiresAt) remove(id);
  }
  function get(id) {
    expire();
    const record = records.get(id);
    if (!record) return undefined;
    records.delete(id);
    records.set(id, record);
    return JSON.parse(record.json);
  }
  return {
    get,
    put(record) {
      expire();
      const json = JSON.stringify(record);
      const size = Buffer.byteLength(json);
      if (size > maxBytes) return false;
      remove(record.id);
      while (records.size >= maxEntries || bytes + size > maxBytes)
        remove(records.keys().next().value);
      const now = clock.now();
      const completedAt =
        Number.isSafeInteger(record.finishedAt) && record.finishedAt >= 0
          ? Math.min(record.finishedAt, now)
          : now;
      records.set(record.id, {
        json,
        bytes: size,
        expiresAt: completedAt + ttlMs,
      });
      bytes += size;
      return true;
    },
    findKey(key) {
      expire();
      for (const [id, record] of records) {
        const item = JSON.parse(record.json);
        if (item.key === key && reusable(item)) return get(id);
      }
    },
    get bytes() {
      expire();
      return bytes;
    },
    get size() {
      expire();
      return records.size;
    },
  };
}
