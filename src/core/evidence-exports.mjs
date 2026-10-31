import { validateReport } from "./report.mjs";

export const SBOM_LIMITS = Object.freeze({
  maxComponents: 2000,
  maxNameLength: 214,
  maxRangeLength: 1024,
});
export const CYCLONEDX_MEDIA_TYPE = "application/vnd.cyclonedx+json";

const ROOT_REF = "unmask:artifact";
const DECLARED_FIELDS = [
  ["dependencies", "required"],
  ["optionalDependencies", "optional"],
  ["peerDependencies", "optional"],
  ["devDependencies", "excluded"],
];
const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const npmName = (value) =>
  typeof value === "string" &&
  value.length <= SBOM_LIMITS.maxNameLength &&
  /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i.test(value);
const property = (name, value) => ({
  name: `unmask:${name}`,
  value: String(value),
});

function splitName(name) {
  const slash = name.startsWith("@") ? name.indexOf("/") : -1;
  return slash > 0
    ? { group: name.slice(0, slash), name: name.slice(slash + 1) }
    : { name };
}

export function npmPurl(name, version) {
  if (!npmName(name) || typeof version !== "string" || !version) return null;
  const parts = splitName(name);
  const namespace = parts.group ? `${encodeURIComponent(parts.group)}/` : "";
  return `pkg:npm/${namespace}${encodeURIComponent(parts.name)}@${encodeURIComponent(version)}`;
}

export function reportIdentity(report) {
  const manifest = report.manifests.artifact;
  const declared =
    manifest.status === "usable" && object(manifest.value)
      ? manifest.value
      : null;
  const claim = report.inputs.claim ?? null;
  const declaredName =
    typeof declared?.name === "string" ? declared.name : null;
  const declaredVersion =
    typeof declared?.version === "string" ? declared.version : null;
  const status =
    claim && declared
      ? claim.name === declaredName && claim.version === declaredVersion
        ? "claim-matches-manifest"
        : "claim-conflicts-with-manifest"
      : claim
        ? "claimed-manifest-unavailable"
        : declared
          ? "manifest-declared-unclaimed"
          : "unknown";
  const name = claim?.name ?? declaredName;
  const version = claim?.version ?? declaredVersion;
  return {
    status,
    name,
    version,
    purl: npmPurl(name, version),
    requested: claim ? { name: claim.name, version: claim.version } : null,
    declared: declared
      ? { name: declaredName, version: declaredVersion }
      : null,
    manifestStatus: manifest.status,
    declaredManifest: declared,
  };
}

function bundledObservations(report) {
  const found = new Map();
  for (const file of report.files) {
    if (typeof file.path !== "string") continue;
    const segments = file.path.split("/");
    for (let i = 0; i < segments.length - 1; i++) {
      if (segments[i] !== "node_modules") continue;
      const scoped = segments[i + 1].startsWith("@");
      const end = i + (scoped ? 3 : 2);
      if (end >= segments.length) continue;
      const name = segments.slice(i + 1, end).join("/");
      const prefix = segments.slice(0, end).join("/");
      const item = found.get(prefix) ?? { prefix, name, files: 0, bytes: 0 };
      item.files++;
      item.bytes += file.size;
      found.set(prefix, item);
    }
  }
  return [...found.values()].sort((a, b) => order(a.prefix, b.prefix));
}

export function buildCycloneDxSbom(report, { toolVersion = null } = {}) {
  validateReport(report);
  const identity = reportIdentity(report);
  const declared = identity.declaredManifest;
  const artifact = report.inputs.artifact;
  const components = [];
  const dependsOn = [];
  const fieldStatus = [];
  let invalidEntries = 0;
  let omitted = 0;
  function add(component, runtime) {
    if (components.length >= SBOM_LIMITS.maxComponents) {
      omitted++;
      return;
    }
    components.push(component);
    if (runtime) dependsOn.push(component["bom-ref"]);
  }
  for (const [field, scope] of DECLARED_FIELDS) {
    const value = declared?.[field];
    if (declared === null) {
      fieldStatus.push(property(`declared:${field}`, "manifest-unavailable"));
      continue;
    }
    if (value === undefined) {
      fieldStatus.push(property(`declared:${field}`, "not-declared"));
      continue;
    }
    if (!object(value)) {
      fieldStatus.push(property(`declared:${field}`, "invalid-type"));
      continue;
    }
    fieldStatus.push(property(`declared:${field}`, "declared"));
    for (const name of Object.keys(value).sort(order)) {
      const range = value[name];
      if (
        !npmName(name) ||
        typeof range !== "string" ||
        range.length > SBOM_LIMITS.maxRangeLength
      ) {
        invalidEntries++;
        continue;
      }
      add(
        {
          type: "library",
          "bom-ref": `unmask:declared:${field}:${name}`,
          ...splitName(name),
          scope,
          properties: [
            property("resolution", "unresolved"),
            property("evidence", "publisher-declared-manifest-entry"),
            property("declared-field", field),
            property("declared-range", range),
          ],
        },
        scope !== "excluded",
      );
    }
  }
  const bundledDeclared = new Set(
    [declared?.bundledDependencies, declared?.bundleDependencies]
      .filter(Array.isArray)
      .flat()
      .filter((item) => typeof item === "string"),
  );
  for (const item of bundledObservations(report)) {
    if (!npmName(item.name)) {
      invalidEntries++;
      continue;
    }
    add(
      {
        type: "library",
        "bom-ref": `unmask:bundled:${item.prefix}`,
        ...splitName(item.name),
        scope: "required",
        properties: [
          property("resolution", "unresolved"),
          property("evidence", "observed-bundled-path-in-artifact"),
          property("bundled-path", item.prefix),
          property("bundled-files", item.files),
          property("bundled-bytes", item.bytes),
          property("bundled-declared", bundledDeclared.has(item.name)),
        ],
      },
      true,
    );
  }
  const root = {
    type: "library",
    "bom-ref": ROOT_REF,
    ...(identity.name && npmName(identity.name)
      ? splitName(identity.name)
      : { name: "unidentified-npm-artifact" }),
    ...(identity.version ? { version: identity.version } : {}),
    ...(identity.purl ? { purl: identity.purl } : {}),
    hashes: [
      { alg: "SHA-256", content: artifact.sha256 },
      { alg: "SHA-512", content: artifact.sha512 },
    ],
    properties: [
      property("identity-status", identity.status),
      property("manifest-status", identity.manifestStatus),
      property(
        "expected-integrity",
        artifact.expectedIntegrity?.status ??
          artifact.expectedIntegrity?.algorithm ??
          "not-recorded",
      ),
      property("source-status", report.source.status),
      property("source-method", report.source.method),
      ...(report.source.commit
        ? [property("source-commit-recorded", report.source.commit)]
        : []),
    ],
  };
  const unresolved = components.length;
  return {
    $schema: "http://cyclonedx.org/schema/bom-1.6.schema.json",
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      tools: {
        components: [
          {
            type: "application",
            name: "unmask",
            ...(toolVersion ? { version: toolVersion } : {}),
          },
        ],
      },
      component: root,
      properties: [
        property("sbom-scope", "observed-artifact-and-declared-direct-entries"),
        property("dependency-resolution", "not-performed"),
        property("transitive-dependencies", "not-assessed"),
        property("unresolved-dependencies", unresolved),
        property("invalid-entries-omitted", invalidEntries),
        property("components-omitted", omitted),
        property("vulnerabilities", "not-included"),
        property("signature", "unsigned"),
        property("inventory-complete", report.coverage.inventory.complete),
        property("report-schema", report.schemaVersion),
        property("analyzer-version", report.analyzerVersion),
        ...fieldStatus,
      ],
    },
    components,
    dependencies: [{ ref: ROOT_REF, dependsOn }],
    compositions: [
      {
        aggregate: declared === null ? "unknown" : "incomplete",
        dependencies: [ROOT_REF],
      },
      ...(components.length
        ? [
            {
              aggregate: "unknown",
              dependencies: components.map((item) => item["bom-ref"]),
            },
          ]
        : []),
    ],
  };
}
