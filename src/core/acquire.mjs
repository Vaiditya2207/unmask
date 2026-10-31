import { createHash } from "node:crypto";
import { resolveSource } from "./resolve.mjs";

const MAX_BLOB_BYTES = 50 * 1024 * 1024;
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_TIMEOUT_MS = 30000;
export class AcquisitionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
function reject(code, message) {
  throw new AcquisitionError(code, message);
}
export function parsePackageSpec(spec) {
  if (typeof spec !== "string" || spec.length > 512)
    reject("invalid-package-spec", "Expected exact package name@version");
  const at = spec.lastIndexOf("@");
  const name = spec.slice(0, at),
    version = spec.slice(at + 1);
  const part = "[a-z0-9][a-z0-9._-]*";
  const validName = new RegExp(`^(?:${part}|@${part}/${part})$`, "u");
  const semver =
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
  const match = version.match(semver);
  if (
    at <= 0 ||
    name.length > 214 ||
    !validName.test(name) ||
    !match ||
    match[4]
      ?.split(".")
      .some((x) => /^[0-9]+$/u.test(x) && x.length > 1 && x.startsWith("0"))
  )
    reject("invalid-package-spec", "Expected exact package name@version");
  return { name, version };
}
function approvedUrl(value) {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    /[\s\\\0-\x1f\x7f]/u.test(value)
  )
    reject(
      "unapproved-url",
      "URL is outside the approved acquisition boundary",
    );
  const match =
    /^https:\/\/(registry\.npmjs\.org|codeload\.github\.com)(\/[^?#]*)$/u.exec(
      value,
    );
  if (!match)
    reject(
      "unapproved-url",
      "URL is outside the approved acquisition boundary",
    );
  const url = new URL(value);
  let path;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    reject("unapproved-url", "Invalid URL path encoding");
  }
  if (
    path.includes("%") ||
    /[\0-\x20\x7f\\]/u.test(path) ||
    path.split("/").some((p) => p === "." || p === "..") ||
    url.href !== value
  )
    reject("unapproved-url", "Noncanonical acquisition URL");
  if (
    match[1] === "codeload.github.com" &&
    !/^\/[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9_.-]+\/tar\.gz\/[a-f0-9]{40}$/u.test(
      path,
    )
  )
    reject(
      "unapproved-url",
      "Source URL requires a canonical repository and full SHA",
    );
  if (match[1] === "codeload.github.com" && value.includes("%"))
    reject("unapproved-url", "Encoded source identifiers are unsupported");
  return value;
}
function digest(bytes) {
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sha512: createHash("sha512").update(bytes).digest("hex"),
  };
}
export async function fetchBlob(
  url,
  {
    fetchImpl = globalThis.fetch,
    signal,
    maxBytes = MAX_BLOB_BYTES,
    timeoutMs = MAX_TIMEOUT_MS,
  } = {},
) {
  approvedUrl(url);
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0 ||
    maxBytes > MAX_BLOB_BYTES
  )
    throw new TypeError("Invalid acquisition byte limit");
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 0 ||
    timeoutMs > MAX_TIMEOUT_MS
  )
    throw new TypeError("Invalid acquisition deadline");
  if (typeof fetchImpl !== "function")
    throw new TypeError("fetchImpl must be a function");
  const controller = new AbortController();
  const abortExternal = () =>
    controller.abort(
      new AcquisitionError("acquisition-aborted", "Acquisition cancelled"),
    );
  if (signal?.aborted) abortExternal();
  signal?.addEventListener("abort", abortExternal, { once: true });
  const observation = { url, observedAt: new Date().toISOString(), bytes: 0 };
  let reader, response, timer, rejectAbort;
  const aborted = new Promise((resolve, rejectPromise) => {
    rejectAbort = rejectPromise;
  });
  aborted.catch(() => {});
  const onAbort = () => rejectAbort(controller.signal.reason);
  controller.signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (timeoutMs === 0)
      reject("acquisition-timeout", "Acquisition deadline exceeded");
    timer = setTimeout(
      () =>
        controller.abort(
          new AcquisitionError(
            "acquisition-timeout",
            "Acquisition deadline exceeded",
          ),
        ),
      timeoutMs,
    );
    const operation = (async () => {
      response = await fetchImpl(url, {
        redirect: "error",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: { accept: "*/*", "accept-encoding": "identity" },
        signal: controller.signal,
      });
      if (controller.signal.aborted) throw controller.signal.reason;
      observation.status = response.status;
      if (
        response.redirected ||
        (response.status >= 300 && response.status < 400) ||
        (response.url && response.url !== url)
      )
        reject("redirect-refused", "Redirected acquisition is forbidden");
      if (response.status !== 200)
        reject(
          "http-status",
          "Acquisition did not return a complete successful response",
        );
      const length = response.headers.get("content-length");
      if (length !== null) {
        if (!/^[0-9]+$/u.test(length) || !Number.isSafeInteger(Number(length)))
          reject("invalid-response", "Invalid response length");
        observation.contentLength = Number(length);
        if (Number(length) > maxBytes)
          reject("response-cap", "Response exceeds acquisition byte limit");
      }
      let storage = Buffer.alloc(0);
      if (response.body) {
        reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (controller.signal.aborted) throw controller.signal.reason;
          if (done) break;
          if (!(value instanceof Uint8Array))
            reject("invalid-response", "Response stream must contain bytes");
          if (value.byteLength > maxBytes - observation.bytes)
            reject("response-cap", "Response exceeds acquisition byte limit");
          const required = observation.bytes + value.byteLength;
          if (required > storage.length) {
            const capacity = Math.min(
              maxBytes,
              Math.max(required, storage.length ? storage.length * 2 : 65536),
            );
            const grown = Buffer.alloc(capacity);
            storage.copy(grown, 0, 0, observation.bytes);
            storage = grown;
          }
          storage.set(value, observation.bytes);
          observation.bytes = required;
        }
      }
      const bytes = storage.subarray(0, observation.bytes);
      return { bytes, digest: digest(bytes), observation };
    })();
    return await Promise.race([operation, aborted]);
  } catch (error) {
    const failure = controller.signal.aborted
      ? controller.signal.reason
      : error instanceof AcquisitionError
        ? error
        : new AcquisitionError(
            "network-failure",
            "Acquisition transport failed",
          );
    failure.observation = observation;
    controller.abort(failure);
    try {
      Promise.resolve(
        reader ? reader.cancel() : response?.body?.cancel(),
      ).catch(() => {});
    } catch {}
    throw failure;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortExternal);
    controller.signal.removeEventListener("abort", onAbort);
    reader?.releaseLock();
  }
}
export async function getRegistryRelease(spec, { fetchImpl, signal } = {}) {
  const identity =
    typeof spec === "string"
      ? parsePackageSpec(spec)
      : parsePackageSpec(`${spec?.name}@${spec?.version}`);
  const url = `https://registry.npmjs.org/${encodeURIComponent(identity.name)}/${encodeURIComponent(identity.version)}`;
  const blob = await fetchBlob(url, {
    fetchImpl,
    signal,
    maxBytes: MAX_METADATA_BYTES,
  });
  try {
    let metadata;
    try {
      metadata = JSON.parse(blob.bytes.toString("utf8"));
    } catch {
      reject("invalid-registry-document", "Registry release is not valid JSON");
    }
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
      reject("invalid-registry-document", "Registry release must be an object");
    if (
      metadata.name !== identity.name ||
      metadata.version !== identity.version
    )
      reject(
        "registry-identity-mismatch",
        "Registry release identity differs from the exact requested version",
      );
    const tarballUrl = approvedUrl(metadata.dist?.tarball);
    if (!tarballUrl.startsWith("https://registry.npmjs.org/"))
      reject(
        "unapproved-url",
        "Registry tarball must remain on the public registry",
      );
    const expectedIntegrity =
      typeof metadata.dist?.integrity === "string"
        ? metadata.dist.integrity
        : /^[a-f0-9]{40}$/iu.test(metadata.dist?.shasum ?? "")
          ? `sha1-${Buffer.from(metadata.dist.shasum, "hex").toString("base64")}`
          : null;
    return {
      metadata,
      metadataBytes: blob.bytes,
      metadataDigest: blob.digest,
      tarballUrl,
      expectedIntegrity,
      sourceCandidate: resolveSource({ registryDoc: metadata }).candidate,
      observation: blob.observation,
    };
  } catch (error) {
    if (error instanceof AcquisitionError) {
      error.observation = blob.observation;
      error.metadataDigest = blob.digest;
    }
    throw error;
  }
}
