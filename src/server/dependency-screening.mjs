import {
  LockfileError,
  explainDependencyPaths,
  explainLockfileLocation,
  parseNpmLockfile,
} from "../core/dependency-graph.mjs";

export const SCREENING_LIMITS = Object.freeze({
  bodyBytes: 2 * 1024 * 1024,
  bodyTimeoutMs: 10000,
  identities: 200,
  concurrency: 4,
  deadlineMs: 60000,
  advisoriesPerDependency: 20,
  explanations: 50,
  omissionExplanations: 50,
  admissions: 6,
  attempts: 30,
  readers: 2,
  admissionWindowMs: 600000,
});
const STATUSES = new Set([
  "found",
  "none-reported",
  "incomplete",
  "unavailable",
]);
const systemClock = { now: Date.now, setTimeout, clearTimeout };
const STATEMENT =
  "Coverage describes exact registry identities only; the project root, local, rejected and unscreened entries were not checked. No reported advisory is not a safety verdict.";

// Keeps only fields the guard classifier needs, with affected severity limited to the screened package.
function advisorySummary(item, name) {
  const affected = (Array.isArray(item.affected) ? item.affected : [])
    .filter(
      (entry) =>
        entry?.package?.ecosystem === "npm" &&
        entry.package.name === name &&
        typeof entry.ecosystemSeverity === "string",
    )
    .slice(0, 8)
    .map((entry) => ({
      package: { ecosystem: "npm", name },
      ecosystemSeverity: entry.ecosystemSeverity,
    }));
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
    ...(affected.length ? { affected } : {}),
  };
}

const unscreened = (identity, status, reason) => ({
  ...identity,
  status,
  complete: false,
  reasons: [reason],
  advisories: [],
});

// Accepts a lookup only when it is bound to the exact identity and its status agrees with its advisories and completeness.
function normalize(identity, lookup, limits) {
  if (
    !lookup ||
    typeof lookup !== "object" ||
    !STATUSES.has(lookup.status) ||
    !Array.isArray(lookup.advisories)
  )
    return unscreened(identity, "unavailable", "invalid-lookup-result");
  if (
    lookup.package?.name !== identity.name ||
    lookup.package?.version !== identity.version
  )
    return unscreened(identity, "unavailable", "identity-mismatch");
  const advisories = lookup.advisories
    .filter((item) => item && typeof item.id === "string")
    .map((item) => advisorySummary(item, identity.name));
  const reasons = Array.isArray(lookup.reasons)
    ? lookup.reasons.filter((reason) => typeof reason === "string")
    : [];
  let status = lookup.status;
  const settled =
    lookup.complete === true &&
    reasons.length === 0 &&
    advisories.length === lookup.advisories.length;
  if (
    (status === "found" && (!advisories.length || !settled)) ||
    (status === "none-reported" && (lookup.advisories.length > 0 || !settled))
  ) {
    reasons.push("inconsistent-lookup-result");
    status = advisories.length ? "incomplete" : "unavailable";
  }
  if (advisories.length > limits.advisoriesPerDependency)
    reasons.push("advisory-output-limit");
  return {
    ...identity,
    status,
    complete:
      ["found", "none-reported"].includes(status) && reasons.length === 0,
    reasons,
    advisories: advisories.slice(0, limits.advisoriesPerDependency),
  };
}

// Screens unique exact registry identities with bounded concurrency, count and a deadline that also bounds in-flight lookups.
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
    results[limits.identities + offset] = unscreened(
      identity,
      "not-screened",
      "identity-limit",
    );
  });
  const deadline = new AbortController();
  const combined = signal
    ? AbortSignal.any([signal, deadline.signal])
    : deadline.signal;
  const timer = (clock.setTimeout ?? setTimeout)(
    () => deadline.abort(),
    limits.deadlineMs,
  );
  let stop;
  const stopped = new Promise((resolve) => {
    stop = () => resolve({ stopped: true });
    combined.addEventListener("abort", stop, { once: true });
  });
  if (combined.aborted) stop();
  const reason = () => (signal?.aborted ? "aborted" : "time-limit");
  async function worker() {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [index, identity] = next;
      if (combined.aborted || clock.now() - started >= limits.deadlineMs) {
        results[index] = unscreened(identity, "not-screened", reason());
        continue;
      }
      const pending = Promise.resolve()
        .then(() => lookup(identity.spec, { signal: combined }))
        .then(
          (value) => ({ value }),
          () => ({ failed: true }),
        );
      const outcome = await Promise.race([pending, stopped]);
      results[index] = outcome.stopped
        ? unscreened(identity, "unavailable", reason())
        : outcome.failed
          ? unscreened(identity, "unavailable", "lookup-failed")
          : normalize(identity, outcome.value, limits);
    }
  }
  try {
    await Promise.all(
      Array.from(
        { length: Math.min(limits.concurrency, queue.length) },
        worker,
      ),
    );
  } finally {
    (clock.clearTimeout ?? clearTimeout)(timer);
    combined.removeEventListener("abort", stop);
  }
  let explained = 0;
  for (const item of results) {
    if (!item.advisories.length) continue;
    item.explanation =
      explained++ < limits.explanations
        ? explainDependencyPaths(graph, item.spec)
        : {
            spec: item.spec,
            locations: graph.index.bySpec.get(item.spec)?.length ?? 0,
            direct: null,
            paths: [],
            complete: false,
            reasons: ["explanation-limit"],
          };
  }
  const count = (status) =>
    results.filter((item) => item.status === status).length;
  const advisoryBearing = results
    .filter((item) => item.advisories.length)
    .map((item) => item.spec);
  const summary = {
    entries: graph.entries,
    identities: results.length,
    advisoryBearing: advisoryBearing.length,
    found: count("found"),
    noneReported: count("none-reported"),
    incomplete: count("incomplete"),
    unavailable: count("unavailable"),
    notScreened: count("not-screened"),
    rejected: graph.rejected.length,
    local: graph.local.length,
  };
  const registryComplete =
    graph.rejected.length === 0 && results.every((item) => item.complete);
  return {
    schemaVersion: "1",
    source: "OSV",
    lockfileVersion: graph.lockfileVersion,
    root: { ...graph.root, location: "", status: "not-screened" },
    screenedAt: new Date(started).toISOString(),
    status: advisoryBearing.length
      ? "advisories-found"
      : registryComplete
        ? "none-reported"
        : "incomplete",
    coverage: {
      scope: "exact-registry-identities",
      registryComplete,
      projectScreened: false,
    },
    summary,
    advisoryBearing,
    statement: STATEMENT,
    dependencies: results,
    rejected: graph.rejected.map((item, index) => ({
      ...item,
      status: "rejected",
      explanation:
        index < limits.omissionExplanations
          ? explainLockfileLocation(graph, item.location)
          : {
              location: item.location,
              locations: 1,
              direct: null,
              paths: [],
              complete: false,
              reasons: ["explanation-limit"],
            },
    })),
    local: graph.local.map((item) => ({ ...item, status: "not-screened" })),
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
  let active = false,
    reading = 0,
    admissions = [],
    attempts = [];
  const limited = (retryAfter) => [
    429,
    { error: "screening-limit", retryAfter },
    { "retry-after": String(retryAfter) },
  ];
  const wait = (list, max, now) =>
    list.length >= max
      ? Math.max(
          1,
          Math.ceil((list[0] + limits.admissionWindowMs - now) / 1000),
        )
      : 0;
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
    let now = clock.now();
    attempts = attempts.filter((at) => now - at < limits.admissionWindowMs);
    // Every body attempt is counted and concurrent reads are capped before any screening slot is held.
    const attemptWait = wait(attempts, limits.attempts, now);
    if (attemptWait || reading >= limits.readers)
      return json(...limited(attemptWait || 5));
    attempts.push(now);
    let body;
    reading++;
    try {
      body = await readJsonBody(req, limits);
    } catch (error) {
      return json(error.status || 400, {
        error: error.status === 413 ? "lockfile-too-large" : "body-unavailable",
      });
    } finally {
      reading--;
    }
    let graph;
    try {
      graph = parseNpmLockfile(
        new TextDecoder("utf-8", { fatal: true }).decode(body),
      );
    } catch (error) {
      return json(400, {
        error: "invalid-lockfile",
        reason: error instanceof LockfileError ? error.reason : "invalid-utf8",
      });
    }
    now = clock.now();
    admissions = admissions.filter((at) => now - at < limits.admissionWindowMs);
    if (active) return json(...limited(5));
    const admissionWait = wait(admissions, limits.admissions, now);
    if (admissionWait) return json(...limited(admissionWait));
    active = true;
    admissions.push(now);
    const controller = new AbortController();
    const abort = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on("close", abort);
    try {
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
