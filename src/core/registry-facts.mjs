import { AcquisitionError, fetchBlob, parsePackageSpec } from "./acquire.mjs";

export const REGISTRY_FACTS_LIMITS = Object.freeze({
  maxBytes: 1024 * 1024,
  timeoutMs: 10000,
  maxValueBytes: 8192,
  maxItems: 100,
});
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string";
const stringMap = (value) => object(value) && Object.values(value).every(text);
const record = (value, keys) =>
  Object.fromEntries(
    keys
      .filter((key) => Object.hasOwn(value, key))
      .map((key) => [key, value[key]]),
  );
const person = (value) => object(value) && text(value.name);

export function registryIdentity(spec) {
  const identity = parsePackageSpec(spec);
  if (
    identity.version
      .split(/[.+-]/)
      .slice(0, 3)
      .some((part) => !Number.isSafeInteger(Number(part)))
  )
    throw new AcquisitionError(
      "invalid-package-spec",
      "Expected exact package name@version",
    );
  return identity;
}

export async function readRegistryDocument(name, version, options = {}) {
  registryIdentity(`${name}@${version ?? "0.0.0"}`);
  const maxBytes = options.maxBytes ?? REGISTRY_FACTS_LIMITS.maxBytes;
  const timeoutMs = options.timeoutMs ?? REGISTRY_FACTS_LIMITS.timeoutMs;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > REGISTRY_FACTS_LIMITS.maxBytes ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > REGISTRY_FACTS_LIMITS.timeoutMs
  )
    throw new TypeError("Invalid registry facts limits");
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}${version === undefined ? "" : `/${encodeURIComponent(version)}`}`;
  const blob = await fetchBlob(url, {
    fetchImpl: options.fetchImpl,
    signal: options.signal,
    maxBytes,
    timeoutMs,
  });
  let document;
  try {
    document = JSON.parse(blob.bytes.toString("utf8"));
  } catch {
    throw new AcquisitionError(
      "invalid-registry-document",
      "Registry metadata is not JSON",
    );
  }
  if (
    !object(document) ||
    document.name !== name ||
    (version !== undefined && document.version !== version)
  )
    throw new AcquisitionError(
      "registry-identity-mismatch",
      "Registry identity differs from request",
    );
  return {
    document,
    source: {
      url,
      retrievedAt: new Date().toISOString(),
      sha256: blob.digest.sha256,
      bytes: blob.observation.bytes,
    },
  };
}

function claim(document, key, valid, project = (value) => value) {
  const result = { pointer: `/${key}`, status: "not-recorded" };
  if (!Object.hasOwn(document, key)) return result;
  const value = document[key];
  if (
    Buffer.byteLength(JSON.stringify(value)) >
    REGISTRY_FACTS_LIMITS.maxValueBytes
  )
    return { ...result, status: "omitted-limit" };
  if (!valid(value)) return { ...result, status: "invalid-type" };
  return {
    ...result,
    status: "registry-reported-unverified",
    value: project(value),
  };
}

export async function getRegistryFacts(spec, options = {}) {
  const identity = registryIdentity(spec);
  const { document, source } = await readRegistryDocument(
    identity.name,
    identity.version,
    options,
  );
  return {
    schemaVersion: "1",
    identity,
    source,
    verifiedObservations: {
      documentIdentity: "matches-exact-request",
      documentDigest: "sha256-of-retrieved-bytes",
    },
    unverifiedClaims: {
      maintainers: claim(
        document,
        "maintainers",
        (value) =>
          Array.isArray(value) &&
          value.length <= REGISTRY_FACTS_LIMITS.maxItems &&
          value.every(person),
        (value) => value.map((item) => ({ name: item.name })),
      ),
      publisher: claim(document, "_npmUser", person, (value) => ({
        name: value.name,
      })),
      deprecated: claim(document, "deprecated", text),
      license: claim(
        document,
        "license",
        (value) =>
          text(value) ||
          (object(value) &&
            text(value.type) &&
            (value.url === undefined || text(value.url))),
        (value) => (text(value) ? value : record(value, ["type", "url"])),
      ),
      engines: claim(document, "engines", stringMap),
      repository: claim(
        document,
        "repository",
        (value) =>
          text(value) ||
          (object(value) &&
            text(value.url) &&
            ["type", "directory"].every(
              (key) => value[key] === undefined || text(value[key]),
            )),
        (value) =>
          text(value) ? value : record(value, ["type", "url", "directory"]),
      ),
    },
    scope: {
      method: "bounded-public-npm-metadata",
      safetyVerdict: "not-provided",
      modelAssessment: "not-performed-metadata-only",
      artifactInspection: "not-performed",
      limitation:
        "Registry declarations only. Maintainers and publisher names are recorded metadata, not verified identities or ownership history. Repository, license and engine declarations are not independently verified. Missing deprecation does not establish support or safety. No popularity-based safety inference.",
    },
  };
}
