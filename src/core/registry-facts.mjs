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
      REGISTRY_FACTS_LIMITS.maxValueBytes ||
    (Array.isArray(value) && value.length > REGISTRY_FACTS_LIMITS.maxItems)
  )
    return { ...result, status: "omitted-limit" };
  if (!valid(value)) return { ...result, status: "invalid-type" };
  return {
    ...result,
    status: "registry-reported-unverified",
    value: project(value),
  };
}

export function projectRegistryClaims(document) {
  return {
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
    unverifiedClaims: projectRegistryClaims(document),
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

const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const metadataFields = ["deprecated", "license", "engines", "repository"];
const recorded = (claim) => claim.status === "registry-reported-unverified";
function stable(value) {
  return JSON.stringify(
    object(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort(order)
            .map((key) => [key, value[key]]),
        )
      : value,
  );
}
function timestamp(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  )
    return null;
  const canonical = value.includes(".") ? value : value.replace("Z", ".000Z");
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === canonical
    ? canonical
    : null;
}
function compareRelease(current, previous, ambiguousTime) {
  if (ambiguousTime) return { status: "not-assessed-ambiguous-time" };
  if (!previous) return { status: "not-assessed-no-predecessor" };
  const left = previous.claims;
  const right = current.claims;
  const publisher =
    recorded(left.publisher) && recorded(right.publisher)
      ? {
          status:
            left.publisher.value.name === right.publisher.value.name
              ? "unchanged"
              : "changed",
          before: left.publisher.value.name,
          after: right.publisher.value.name,
        }
      : { status: "not-assessed" };
  const unassessedFields = metadataFields.filter(
    (field) => !recorded(left[field]) || !recorded(right[field]),
  );
  const metadataChanges = metadataFields
    .filter(
      (field) =>
        recorded(left[field]) &&
        recorded(right[field]) &&
        stable(left[field].value) !== stable(right[field].value),
    )
    .map((field) => ({
      field,
      before: left[field].value,
      after: right[field].value,
    }));
  return {
    status:
      unassessedFields.length || publisher.status === "not-assessed"
        ? "partial"
        : "compared",
    againstVersion: previous.version,
    publisher,
    metadataChanges,
    unassessedFields,
  };
}

export async function getRegistryHistory(name, options = {}) {
  registryIdentity(`${name}@0.0.0`);
  const limit = options.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new TypeError("Invalid registry history limit");
  const { document, source } = await readRegistryDocument(
    name,
    undefined,
    options,
  );
  const times = object(document.time) ? document.time : {};
  const versions = object(document.versions) ? document.versions : {};
  const keys = [
    ...new Set([
      ...Object.keys(times).filter(
        (key) => !["created", "modified"].includes(key),
      ),
      ...Object.keys(versions),
    ]),
  ];
  if (keys.length > 5000)
    throw new AcquisitionError(
      "registry-history-cap",
      "Registry version history exceeds record limit",
    );
  let invalidVersionKeys = 0,
    undatedVersions = 0;
  const timeline = [];
  for (const version of keys) {
    try {
      registryIdentity(`${name}@${version}`);
    } catch {
      invalidVersionKeys++;
      continue;
    }
    const releasedAt = timestamp(times[version]);
    if (!releasedAt) {
      undatedVersions++;
      continue;
    }
    const entry = versions[version];
    const metadataStatus = !Object.hasOwn(versions, version)
      ? "not-recorded"
      : !object(entry)
        ? "invalid-type"
        : entry.name !== name || entry.version !== version
          ? "identity-mismatch"
          : "registry-reported-unverified";
    const claims = projectRegistryClaims(
      metadataStatus === "registry-reported-unverified" ? entry : {},
    );
    for (const claim of Object.values(claims))
      claim.pointer = `/versions/${version}${claim.pointer}`;
    timeline.push({
      version,
      releasedAt,
      timePointer: `/time/${version}`,
      metadataStatus,
      claims,
    });
  }
  timeline.sort(
    (a, b) => order(a.releasedAt, b.releasedAt) || order(a.version, b.version),
  );
  const counts = new Map();
  for (const entry of timeline)
    counts.set(entry.releasedAt, (counts.get(entry.releasedAt) ?? 0) + 1);
  for (let i = 0; i < timeline.length; i++) {
    const entry = timeline[i];
    entry.comparison = compareRelease(
      entry,
      timeline[i - 1],
      counts.get(entry.releasedAt) > 1 ||
        (i > 0 && counts.get(timeline[i - 1].releasedAt) > 1),
    );
  }
  return {
    schemaVersion: "1",
    status: timeline.length ? "recorded-history" : "history-unavailable",
    identity: { name },
    source,
    timeline: timeline.slice(-limit).reverse(),
    coverage: {
      recordedVersions: keys.length - invalidVersionKeys,
      datedVersions: timeline.length,
      undatedVersions,
      invalidVersionKeys,
      returned: Math.min(limit, timeline.length),
      omitted: Math.max(0, timeline.length - limit),
      recordLimit: 5000,
    },
    scope: {
      method: "adjacent-dated-version-records-in-current-registry-snapshot",
      historicalEdits: "not-assessed-single-snapshot",
      ownershipTransfers: "not-assessed",
      safetyVerdict: "not-provided",
      modelAssessment: "not-performed-metadata-only",
      limitation:
        "Publish times and declarations are registry-reported and unverified. Comparisons describe differences between adjacent dated records in this snapshot, not edits over time or proven ownership transfers. Missing, malformed or omitted fields remain unassessed. Removed releases may retain dates without metadata. Equal timestamps do not establish ordering. Changes, unchanged metadata and popularity do not establish safety.",
    },
  };
}
