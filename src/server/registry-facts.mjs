import {
  getRegistryFacts,
  getRegistryHistory,
  registryIdentity,
} from "../core/registry-facts.mjs";

export function createRegistryFactsHandler(options = {}) {
  const maxConcurrent = options.maxConcurrent ?? 2;
  const maxRequests = options.maxRequests ?? 30;
  if (
    !Number.isSafeInteger(maxConcurrent) ||
    maxConcurrent < 1 ||
    maxConcurrent > 2 ||
    !Number.isSafeInteger(maxRequests) ||
    maxRequests < 1 ||
    maxRequests > 30
  )
    throw new TypeError("Invalid registry lookup admission limits");
  let active = 0,
    used = 0,
    windowStart = Date.now();
  return async function handleRegistryFacts(req, json) {
    const url = new URL(req.url, "http://localhost");
    const history = url.pathname === "/api/registry/history";
    if (url.pathname !== "/api/registry/facts" && !history) return false;
    if (req.method !== "GET") {
      json(
        405,
        { status: "rejected", reason: "method-not-allowed" },
        { allow: "GET" },
      );
      return true;
    }
    const spec = url.searchParams.get("package");
    let limit = 20;
    try {
      const allowed = history ? ["package", "limit"] : ["package"];
      if (
        !spec ||
        [...url.searchParams.keys()].some((key) => !allowed.includes(key)) ||
        allowed.some((key) => url.searchParams.getAll(key).length > 1)
      )
        throw new Error();
      if (history) {
        registryIdentity(`${spec}@0.0.0`);
        if (url.searchParams.has("limit")) {
          const raw = url.searchParams.get("limit");
          if (!/^[1-9]\d{0,2}$/.test(raw)) throw new Error();
          limit = Number(raw);
          if (limit > 100) throw new Error();
        }
      } else registryIdentity(spec);
    } catch {
      json(400, {
        status: "rejected",
        reason: history
          ? "package-name-and-bounded-limit-required"
          : "exact-package-required",
      });
      return true;
    }
    const now = Date.now();
    if (now - windowStart >= 60000) {
      used = 0;
      windowStart = now;
    }
    if (active >= maxConcurrent || used >= maxRequests) {
      json(
        429,
        { status: "unavailable", reason: "registry-lookup-limit" },
        {
          "retry-after": String(
            Math.max(1, Math.ceil((60000 - (now - windowStart)) / 1000)),
          ),
        },
      );
      return true;
    }
    used++;
    active++;
    try {
      json(
        200,
        history
          ? await getRegistryHistory(spec, { ...options, limit })
          : await getRegistryFacts(spec, options),
      );
    } catch (error) {
      const reason = [
        "acquisition-timeout",
        "response-cap",
        "redirect-refused",
        "invalid-registry-document",
        "registry-identity-mismatch",
        "http-status",
        "network-failure",
        "invalid-response",
        "registry-history-cap",
      ].includes(error.code)
        ? error.code
        : "registry-unavailable";
      const status =
        reason === "acquisition-timeout"
          ? 504
          : error.observation?.status === 404
            ? 404
            : 502;
      json(status, {
        status: "unavailable",
        reason,
        safetyVerdict: "not-provided",
      });
    } finally {
      active--;
    }
    return true;
  };
}
