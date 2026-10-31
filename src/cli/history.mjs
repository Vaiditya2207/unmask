import {
  AcquisitionError,
  fetchBlob,
  parsePackageSpec,
} from "../core/acquire.mjs";
import { LocalInputError } from "../core/pipeline.mjs";

const MAX_PACKUMENT_BYTES = 40 * 1024 * 1024;
const TIMEOUT_MS = 20000;
const DEFAULT_LIMIT = 15;
const MAX_LIMIT = 100;
const RECENT_MS = 7 * 24 * 60 * 60 * 1000;
const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall"];
const usage = () =>
  new LocalInputError("usage", "Use history NAME [--limit 1-100] [--json]");
export function parseHistoryArgs(argv) {
  const options = { limit: DEFAULT_LIMIT, json: false };
  const seen = new Set();
  let name;
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (seen.has(value)) throw usage();
    if (value === "--json") options.json = true;
    else if (value === "--limit") {
      const raw = argv[++index];
      if (!/^[1-9][0-9]{0,2}$/.test(raw ?? "") || Number(raw) > MAX_LIMIT)
        throw new LocalInputError(
          "invalid-limit",
          `--limit must be an integer from 1 to ${MAX_LIMIT}`,
        );
      options.limit = Number(raw);
    } else if (value.startsWith("--") || name !== undefined) throw usage();
    else name = value;
    if (value.startsWith("--")) seen.add(value);
  }
  if (name === undefined) throw usage();
  try {
    parsePackageSpec(`${name}@0.0.0`);
  } catch (error) {
    if (error instanceof AcquisitionError)
      throw new LocalInputError(
        "invalid-package-name",
        "History requires a bare npm package name without a version",
      );
    throw error;
  }
  return { ...options, name };
}
const UNSAFE =
  /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const JSON_UNSAFE = /[\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const escapeUnsafe = (text, pattern = UNSAFE) =>
  text.replace(
    pattern,
    (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"),
  );
const abbreviate = (value, max) =>
  value.length > max ? value.slice(0, max) + "..." : value;
const validDate = (value) =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
function exactPin(name, version) {
  try {
    parsePackageSpec(`${name}@${version}`);
    return true;
  } catch {
    return false;
  }
}
export function summarizeHistory(packument, { limit, now = Date.now() }) {
  if (!packument || typeof packument !== "object" || Array.isArray(packument))
    throw new LocalInputError(
      "registry-invalid",
      "Registry metadata is not a JSON object",
    );
  const versions =
    packument.versions && typeof packument.versions === "object"
      ? packument.versions
      : {};
  const time =
    packument.time && typeof packument.time === "object" ? packument.time : {};
  const tags = new Map();
  for (const [tag, version] of Object.entries(packument["dist-tags"] ?? {}))
    if (typeof version === "string")
      tags.set(version, [...(tags.get(version) ?? []), tag]);
  const known = new Set([
    ...Object.keys(versions),
    ...Object.keys(time).filter(
      (key) => !["created", "modified"].includes(key) && validDate(time[key]),
    ),
  ]);
  const releases = [];
  for (const version of known) {
    const manifest = Object.hasOwn(versions, version)
      ? versions[version]
      : undefined;
    const available = Boolean(manifest && typeof manifest === "object");
    releases.push({
      version,
      exactPin: exactPin(packument.name, version),
      published: validDate(time[version]) ? time[version] : null,
      available,
      tags: tags.get(version) ?? [],
      deprecated:
        available && typeof manifest.deprecated === "string"
          ? manifest.deprecated
          : null,
      installScripts: available
        ? INSTALL_SCRIPTS.filter(
            (name) => typeof manifest.scripts?.[name] === "string",
          )
        : [],
      recent: validDate(time[version])
        ? now - Date.parse(time[version]) < RECENT_MS
        : false,
    });
  }
  const stamp = (release) =>
    release.published ? Date.parse(release.published) : 0;
  releases.sort(
    (a, b) => stamp(b) - stamp(a) || (a.version < b.version ? 1 : -1),
  );
  const selectable = (release) =>
    release.available && !release.deprecated && release.exactPin;
  const latest = releases.find(
    (release) => release.version === packument["dist-tags"]?.latest,
  );
  const candidate =
    latest && selectable(latest)
      ? latest
      : releases.find(
          (release) => selectable(release) && !release.version.includes("-"),
        );
  return {
    name: packument.name,
    totalVersions: releases.length,
    removedVersions: releases.filter((release) => !release.available).length,
    deprecatedVersions: releases.filter((release) => release.deprecated).length,
    distTags: Object.fromEntries(
      [...tags].flatMap(([version, names]) =>
        names.map((tag) => [tag, version]),
      ),
    ),
    unpublished: Boolean(time.unpublished),
    shown: releases.slice(0, limit),
    candidate: candidate?.version ?? null,
  };
}
export function renderHistory(summary) {
  const lines = [
    `History ${summary.name}: ${summary.totalVersions} versions, ${summary.deprecatedVersions} deprecated, ${summary.removedVersions} removed from registry`,
    `Dist-tags: ${
      Object.entries(summary.distTags)
        .map(
          ([tag, version]) =>
            `${abbreviate(tag, 40)}=${abbreviate(version, 64)}`,
        )
        .join(", ") || "none"
    }`,
  ];
  if (summary.unpublished)
    lines.push("! The package is marked unpublished in the registry.");
  lines.push(`Newest ${summary.shown.length} releases:`);
  for (const release of summary.shown) {
    const marks = [
      ...release.tags.map((tag) => `[${abbreviate(tag, 40)}]`),
      ...(release.available ? [] : ["[removed]"]),
      ...(release.recent ? ["[recent]"] : []),
      ...(release.installScripts.length
        ? [`[install scripts: ${release.installScripts.join(",")}]`]
        : []),
    ];
    lines.push(
      `  ${(release.published ?? "unknown date").slice(0, 10)}  ${abbreviate(release.version, 64)}${marks.length ? " " + marks.join(" ") : ""}`,
    );
    if (release.deprecated)
      lines.push(`      deprecated: ${abbreviate(release.deprecated, 160)}`);
  }
  lines.push("Selection guidance:");
  if (summary.candidate)
    lines.push(
      `  Pin an exact version, e.g. ${summary.name}@${summary.candidate}, and check it first: unmask check ${summary.name}@${summary.candidate} --out DIR`,
    );
  else
    lines.push(
      "  No non-deprecated stable release is available; do not select a version without review.",
    );
  lines.push(
    "  Avoid ranges and dist-tags in installs; removed versions cannot be verified from the registry.",
    "  Release age, popularity or a lack of findings is not proof of safety.",
  );
  return lines.map((line) => escapeUnsafe(line)).join("\n") + "\n";
}
export async function runHistory(argv, runtime = {}) {
  const { name, limit, json } = parseHistoryArgs(argv);
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}`;
  let packument;
  try {
    const blob = await fetchBlob(url, {
      fetchImpl: runtime.fetchImpl,
      signal: runtime.signal,
      maxBytes: MAX_PACKUMENT_BYTES,
      timeoutMs: TIMEOUT_MS,
    });
    packument = JSON.parse(blob.bytes.toString("utf8"));
  } catch (error) {
    if (error instanceof AcquisitionError)
      throw new LocalInputError(
        error.observation?.status === 404
          ? "registry-not-found"
          : "registry-unavailable",
        error.observation?.status === 404
          ? `The registry has no package named ${name}.`
          : `Registry metadata could not be read (${error.code}).`,
      );
    throw new LocalInputError(
      "registry-invalid",
      "Registry metadata is not valid JSON",
    );
  }
  if (packument?.name !== name)
    throw new LocalInputError(
      "registry-identity-mismatch",
      "Registry metadata names a different package",
    );
  const summary = summarizeHistory(packument, { limit, now: runtime.now });
  (runtime.stdout ?? process.stdout).write(
    json
      ? escapeUnsafe(JSON.stringify(summary, null, 2), JSON_UNSAFE) + "\n"
      : renderHistory(summary),
  );
  return 0;
}
