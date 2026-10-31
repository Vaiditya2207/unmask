import { LockfileError, parseNpmLockfile } from "../core/dependency-graph.mjs";

export const SCREENING_LIMITS = Object.freeze({
  bodyBytes: 2 * 1024 * 1024,
  bodyTimeoutMs: 10000,
  identities: 200,
  concurrency: 4,
  deadlineMs: 60000,
  advisoriesPerDependency: 20,
  admissions: 6,
  admissionWindowMs: 600000,
});
const STATUSES = new Set([
  "found",
  "none-reported",
  "incomplete",
  "unavailable",
]);
const systemClock = { now: Date.now };

function advisorySummary(item) {
  return {
    id: item.id,
    aliases: Array.isArray(item.aliases) ? item.aliases.slice(0, 16) : [],
    ...(typeof item.summary === "string" ? { summary: item.summary } : {}),
    ...(typeof item.databaseSeverity === "string"
      ? { databaseSeverity: item.databaseSeverity }
      : {}),
    ...(typeof item.withdrawn === "string"
      ? { withdrawn: item.withdrawn }
      : {}),
  };
}

function normalize(identity, lookup, limits) {
  if (
    !lookup ||
    typeof lookup !== "object" ||
    !STATUSES.has(lookup.status) ||
    !Array.isArray(lookup.advisories)
  )
    return {
      ...identity,
      status: "unavailable",
      complete: false,
      reasons: ["invalid-lookup-result"],
      advisories: [],
    };
  const advisories = lookup.advisories
    .filter((item) => item && typeof item.id === "string")
    .map(advisorySummary);
  const reasons = Array.isArray(lookup.reasons)
    ? lookup.reasons.filter((reason) => typeof reason === "string")
    : [];
  if (advisories.length > limits.advisoriesPerDependency)
    reasons.push("advisory-output-limit");
  return {
    ...identity,
    status: lookup.status,
    complete: lookup.complete === true && reasons.length === 0,
    reasons,
    advisories: advisories.slice(0, limits.advisoriesPerDependency),
  };
}

// Screens unique exact registry identities with bounded concurrency, count and time; unscreened work stays visible.
export async function screenDependencyGraph(
  graph,
  { lookup, limits: overrides = {}, clock = systemClock, signal } = {},
) {
  const limits = { ...SCREENING_LIMITS, ...overrides };
  const started = clock.now();
  const results = new Array(graph.identities.length);
  const queue = graph.identities
    .slice(0, limits.identities)
    .map((identity, i) => [i, identity]);
  graph.identities.slice(limits.identities).forEach((identity, offset) => {
    results[limits.identities + offset] = {
      ...identity,
      status: "not-screened",
      complete: false,
      reasons: ["identity-limit"],
      advisories: [],
    };
  });
  async function worker() {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [index, identity] = next;
      const stopped = signal?.aborted
        ? "aborted"
        : clock.now() - started >= limits.deadlineMs
          ? "time-limit"
          : null;
      if (stopped) {
        results[index] = {
          ...identity,
          status: "not-screened",
          complete: false,
          reasons: [stopped],
          advisories: [],
        };
        continue;
      }
      try {
        const value = await lookup(identity.spec, { signal });
        results[index] = normalize(identity, value, limits);
      } catch {
        results[index] = {
          ...identity,
          status: "unavailable",
          complete: false,
          reasons: ["lookup-failed"],
          advisories: [],
        };
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limits.concurrency, queue.length) }, worker),
  );
  const count = (status) =>
    results.filter((item) => item.status === status).length;
  const summary = {
    entries: graph.entries,
    identities: results.length,
    found: count("found"),
    noneReported: count("none-reported"),
    incomplete: count("incomplete"),
    unavailable: count("unavailable"),
    notScreened: count("not-screened"),
    rejected: graph.rejected.length,
    local: graph.local.length,
  };
  const complete =
    graph.rejected.length === 0 && results.every((item) => item.complete);
  return {
    schemaVersion: "1",
    source: "OSV",
    lockfileVersion: graph.lockfileVersion,
    root: graph.root,
    screenedAt: new Date(started).toISOString(),
    status: summary.found
      ? "advisories-found"
      : complete
        ? "none-reported"
        : "incomplete",
    complete,
    summary,
    statement:
      "Advisory screening covers exact registry identities only. No reported advisory is not a safety verdict; rejected, local and unscreened entries were not checked.",
    dependencies: results,
    rejected: graph.rejected,
    local: graph.local,
    limits: {
      identities: limits.identities,
      concurrency: limits.concurrency,
      deadlineMs: limits.deadlineMs,
    },
  };
}

function readJsonBody(req, limits) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0,
      done = false;
    const timer = setTimeout(() => finish(408), limits.bodyTimeoutMs);
    timer.unref?.();
    function finish(status) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.removeAllListeners("data");
      if (status) {
        req.on("error", () => {});
        req.resume();
        reject(Object.assign(new Error("body rejected"), { status }));
      } else resolve(Buffer.concat(chunks, size));
    }
    if (Number(req.headers["content-length"]) > limits.bodyBytes)
      return finish(413);
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limits.bodyBytes) finish(413);
      else chunks.push(chunk);
    });
    req.on("end", () => finish());
    req.on("error", () => finish(400));
    req.on("aborted", () => finish(400));
  });
}

export function createDependencyScreening({
  lookup,
  limits: overrides = {},
  clock = systemClock,
} = {}) {
  if (lookup !== undefined && typeof lookup !== "function")
    throw new TypeError("advisoryLookup must be a function");
  const limits = { ...SCREENING_LIMITS, ...overrides };
  let active = false;
  let admissions = [];
  return async function handle(req, res, json) {
    if (req.method !== "POST")
      return json(405, { error: "method-not-allowed" }, { allow: "POST" });
    if (
      req.headers["sec-fetch-site"] === "cross-site" ||
      (req.headers.origin &&
        req.headers.origin !== `http://${req.headers.host}` &&
        req.headers.origin !== `https://${req.headers.host}`)
    )
      return json(403, { error: "origin-rejected" });
    if (
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
        req.headers["content-type"] || "",
      )
    )
      return json(415, { error: "expected-json-lockfile" });
    if (!lookup) return json(503, { error: "advisory-lookup-unavailable" });
    const now = clock.now();
    admissions = admissions.filter((at) => now - at < limits.admissionWindowMs);
    if (active || admissions.length >= limits.admissions) {
      const retryAfter = active
        ? 5
        : Math.ceil((admissions[0] + limits.admissionWindowMs - now) / 1000);
      return json(
        429,
        { error: "screening-limit", retryAfter },
        { "retry-after": String(retryAfter) },
      );
    }
    active = true;
    const controller = new AbortController();
    const abort = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on("close", abort);
    try {
      let body;
      try {
        body = await readJsonBody(req, limits);
      } catch (error) {
        return json(error.status || 400, {
          error:
            error.status === 413 ? "lockfile-too-large" : "body-unavailable",
        });
      }
      let graph;
      try {
        graph = parseNpmLockfile(
          new TextDecoder("utf-8", { fatal: true }).decode(body),
        );
      } catch (error) {
        return json(400, {
          error: "invalid-lockfile",
          reason:
            error instanceof LockfileError ? error.reason : "invalid-utf8",
        });
      }
      admissions.push(now);
      const result = await screenDependencyGraph(graph, {
        lookup,
        limits,
        clock,
        signal: controller.signal,
      });
      return json(200, result);
    } finally {
      active = false;
      res.removeListener("close", abort);
    }
  };
}
