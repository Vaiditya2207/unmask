import { parsePackageSpec } from "./acquire.mjs";

const ENDPOINT = "https://api.osv.dev/v1/query";
export const ADVISORY_LIMITS = Object.freeze({
  timeoutMs: 12000,
  responseBytes: 1024 * 1024,
  pages: 3,
  advisories: 100,
});
const systemClock = { now: Date.now, setTimeout, clearTimeout };
class LookupFailure extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}
const fail = (reason) => {
  throw new LookupFailure(reason);
};
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function advisory(value, mark) {
  if (
    !object(value) ||
    typeof value.id !== "string" ||
    !/^[a-zA-Z0-9:_.-]{1,256}$/.test(value.id)
  ) {
    mark("invalid-record");
    return null;
  }
  let truncated = false;
  const recordMark = mark;
  mark = (reason) => {
    if (reason === "record-limit") truncated = true;
    recordMark(reason);
  };
  function string(value, max, clip = false) {
    if (value === undefined) return undefined;
    if (typeof value !== "string") {
      mark("invalid-record");
      return undefined;
    }
    const bytes = Buffer.from(value);
    if (bytes.length <= max) return value;
    mark("record-limit");
    if (!clip) return undefined;
    for (let end = max; end >= Math.max(0, max - 3); end--) {
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.subarray(0, end),
        );
      } catch {}
    }
    return "";
  }
  function list(value, max, convert) {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      mark("invalid-record");
      return [];
    }
    if (value.length > max) mark("record-limit");
    return value
      .slice(0, max)
      .map(convert)
      .filter((item) => item !== null && item !== undefined);
  }
  function https(value) {
    if (
      typeof value !== "string" ||
      value.length > 2048 ||
      !value.startsWith("https://") ||
      /[\s\x00-\x1f\x7f]/.test(value)
    ) {
      mark("invalid-record");
      return undefined;
    }
    try {
      const url = new URL(value);
      if (url.protocol === "https:" && !url.username && !url.password)
        return value;
    } catch {}
    mark("invalid-record");
    return undefined;
  }
  function timestamp(value) {
    if (value === undefined) return undefined;
    if (
      typeof value === "string" &&
      value.length <= 64 &&
      /^\d{4}-\d{2}-\d{2}T.+Z$/.test(value) &&
      Number.isFinite(Date.parse(value))
    )
      return value;
    mark("invalid-record");
    return undefined;
  }
  function severity(value) {
    return list(value, 8, (entry) => {
      if (
        !object(entry) ||
        typeof entry.type !== "string" ||
        typeof entry.score !== "string"
      ) {
        mark("invalid-record");
        return null;
      }
      const type = string(entry.type, 32),
        score = string(entry.score, 512);
      if (type === undefined || score === undefined) return null;
      const out = { type, score };
      if (entry.source !== undefined) {
        const source = https(entry.source);
        if (source) out.source = source;
      }
      return out;
    });
  }
  function range(value) {
    if (!object(value) || typeof value.type !== "string") {
      mark("invalid-record");
      return null;
    }
    const type = string(value.type, 32);
    if (type === undefined) return null;
    const out = {
      type,
      events: list(value.events, 32, (event) => {
        if (!object(event)) {
          mark("invalid-record");
          return null;
        }
        const keys = Object.keys(event);
        if (
          keys.length !== 1 ||
          !["introduced", "fixed", "last_affected", "limit"].includes(
            keys[0],
          ) ||
          typeof event[keys[0]] !== "string"
        ) {
          mark("invalid-record");
          return null;
        }
        const version = string(event[keys[0]], 256);
        return version === undefined ? null : { [keys[0]]: version };
      }),
    };
    if (value.repo !== undefined) {
      const repo = https(value.repo);
      if (repo) out.repo = repo;
    }
    return out;
  }
  const out = {
    id: value.id,
    aliases: [
      ...new Set(
        list(value.aliases, 16, (alias) => {
          if (
            typeof alias !== "string" ||
            !/^[a-zA-Z0-9:_.-]{1,256}$/.test(alias)
          ) {
            mark("invalid-record");
            return null;
          }
          return alias;
        }),
      ),
    ],
    severitySource: "OSV-declaration",
    severity: severity(value.severity),
    references: list(value.references, 16, (reference) => {
      if (!object(reference)) {
        mark("invalid-record");
        return null;
      }
      const url = https(reference.url);
      if (!url) return null;
      const type = string(reference.type, 32);
      return { ...(type !== undefined ? { type } : {}), url };
    }),
    affected: list(value.affected, 8, (affected) => {
      if (
        !object(affected) ||
        !object(affected.package) ||
        typeof affected.package.name !== "string" ||
        typeof affected.package.ecosystem !== "string"
      ) {
        mark("invalid-record");
        return null;
      }
      const name = string(affected.package.name, 214),
        ecosystem = string(affected.package.ecosystem, 64);
      if (name === undefined || ecosystem === undefined) return null;
      const pkg = { name, ecosystem };
      if (affected.package.purl !== undefined) {
        const purl = string(affected.package.purl, 1024);
        if (purl !== undefined) pkg.purl = purl;
      }
      const entry = {
        package: pkg,
        ranges: list(affected.ranges, 8, range),
        versions: list(affected.versions, 64, (version) =>
          string(version, 256),
        ),
        severity: severity(affected.severity),
      };
      const declared = string(affected.ecosystem_specific?.severity, 64);
      if (declared !== undefined) entry.ecosystemSeverity = declared;
      return entry;
    }),
  };
  for (const field of ["summary", "modified", "published", "withdrawn"]) {
    const item =
      field === "summary"
        ? string(value[field], 2048, true)
        : timestamp(value[field]);
    if (item !== undefined) out[field] = item;
  }
  const declared = string(value.database_specific?.severity, 64);
  if (declared !== undefined) out.databaseSeverity = declared;
  if (truncated) out.truncated = true;
  return out;
}

export async function lookupNpmAdvisories(
  spec,
  {
    fetchImpl = globalThis.fetch,
    clock = systemClock,
    signal,
    limits: overrides = {},
  } = {},
) {
  const started = clock.now();
  const result = {
    schemaVersion: "1",
    source: "OSV",
    package: null,
    queriedAt: new Date(started).toISOString(),
    status: "unavailable",
    complete: false,
    reasons: [],
    advisories: [],
    pagesFetched: 0,
    limits: { ...ADVISORY_LIMITS },
  };
  const reasons = new Set();
  const records = new Map();
  const mark = (reason) => reasons.add(reason);
  function finish() {
    result.advisories = [...records.values()].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    result.reasons = [...reasons].sort();
    result.complete = !reasons.size;
    result.status = reasons.size
      ? result.pagesFetched || records.size
        ? "incomplete"
        : "unavailable"
      : records.size
        ? "found"
        : "none-reported";
    return result;
  }
  let claim;
  try {
    claim = parsePackageSpec(spec);
  } catch {
    mark("invalid-package-spec");
    return finish();
  }
  result.package = { ...claim, ecosystem: "npm" };
  const limits = { ...ADVISORY_LIMITS, ...overrides };
  if (
    Object.keys(limits).some(
      (key) =>
        !Object.hasOwn(ADVISORY_LIMITS, key) ||
        !Number.isSafeInteger(limits[key]) ||
        limits[key] < 1 ||
        limits[key] > ADVISORY_LIMITS[key],
    )
  ) {
    mark("invalid-limits");
    return finish();
  }
  result.limits = limits;
  if (signal?.aborted) {
    mark("aborted");
    return finish();
  }
  const controller = new AbortController();
  const combined = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  let timedOut = false,
    active = true;
  const readers = new Set();
  const timer = clock.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, limits.timeoutMs);
  let interrupt;
  const interrupted = new Promise((_, reject) => {
    interrupt = () => {
      for (const reader of readers) reader.cancel().catch(() => {});
      reject(new LookupFailure(timedOut ? "timeout" : "aborted"));
    };
    combined.addEventListener("abort", interrupt, { once: true });
  });
  function alive() {
    if (!active || combined.aborted) fail(timedOut ? "timeout" : "aborted");
    if (clock.now() - started >= limits.timeoutMs) {
      timedOut = true;
      controller.abort();
      fail("timeout");
    }
  }
  async function page(token) {
    alive();
    const response = await fetchImpl(ENDPOINT, {
      method: "POST",
      redirect: "manual",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: combined,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        package: { name: claim.name, ecosystem: "npm" },
        version: claim.version,
        ...(token ? { page_token: token } : {}),
      }),
    });
    if (combined.aborted || !active) response.body?.cancel().catch(() => {});
    alive();
    if (
      response.redirected ||
      (response.url && response.url !== ENDPOINT) ||
      (response.status >= 300 && response.status < 400)
    ) {
      response.body?.cancel().catch(() => {});
      fail("redirect-rejected");
    }
    if (response.status !== 200) {
      response.body?.cancel().catch(() => {});
      fail("http-error");
    }
    if (
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
        response.headers.get("content-type") ?? "",
      )
    ) {
      response.body?.cancel().catch(() => {});
      fail("invalid-response");
    }
    const declared = response.headers.get("content-length");
    if (
      declared !== null &&
      (!/^\d+$/.test(declared) || Number(declared) > limits.responseBytes)
    ) {
      response.body?.cancel().catch(() => {});
      fail("response-limit");
    }
    const reader = response.body?.getReader();
    if (!reader) fail("invalid-response");
    readers.add(reader);
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        alive();
        const { done, value } = await reader.read();
        alive();
        if (done) break;
        size += value.byteLength;
        if (size > limits.responseBytes) fail("response-limit");
        chunks.push(value);
      }
    } finally {
      readers.delete(reader);
      reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    let parsed;
    try {
      parsed = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.concat(chunks, size),
        ),
      );
    } catch {
      fail("invalid-response");
    }
    if (
      !object(parsed) ||
      Object.hasOwn(parsed, "error") ||
      (parsed.vulns !== undefined && !Array.isArray(parsed.vulns)) ||
      (parsed.vulns === undefined &&
        parsed.next_page_token === undefined &&
        Object.keys(parsed).length > 0)
    )
      fail("invalid-response");
    if (
      parsed.next_page_token !== undefined &&
      (typeof parsed.next_page_token !== "string" ||
        parsed.next_page_token.length > 4096 ||
        /[\x00-\x1f\x7f]/.test(parsed.next_page_token))
    )
      fail("invalid-response");
    return parsed;
  }
  async function query() {
    const tokens = new Set();
    let token;
    for (let i = 0; i < limits.pages; i++) {
      const value = await page(token);
      alive();
      result.pagesFetched++;
      for (const raw of value.vulns ?? []) {
        alive();
        const item = advisory(raw, mark);
        if (!item || records.has(item.id)) continue;
        if (records.size >= limits.advisories) {
          mark("advisory-limit");
          return;
        }
        records.set(item.id, item);
      }
      token = value.next_page_token;
      if (!token) return;
      if (tokens.has(token)) {
        mark("pagination-loop");
        return;
      }
      tokens.add(token);
      if (records.size >= limits.advisories) {
        mark("advisory-limit");
        return;
      }
    }
    mark("page-limit");
  }
  try {
    await Promise.race([query(), interrupted]);
  } catch (error) {
    mark(error instanceof LookupFailure ? error.reason : "request-failed");
  } finally {
    active = false;
    clock.clearTimeout(timer);
    combined.removeEventListener("abort", interrupt);
    for (const reader of readers) reader.cancel().catch(() => {});
  }
  return finish();
}
