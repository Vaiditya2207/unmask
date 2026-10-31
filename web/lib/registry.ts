// Reads the public npm registry record for one release. Nothing is downloaded
// beyond the version manifest, and nothing from the package is executed.

export const REGISTRY = "https://registry.npmjs.org";

const NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-zA-Z0-9][a-zA-Z0-9._~-]*$/;
const EXACT =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const INSTALL_HOOKS = ["preinstall", "install", "postinstall"] as const;

export type Spec =
  | { ok: true; name: string; version: string | null }
  | { ok: false; error: string };

export function parseSpec(input: string, { exact = false } = {}): Spec {
  const value = input.trim();
  if (!value)
    return { ok: false, error: "Enter a package name, such as clsx@2.1.1." };
  if (value.length > 300)
    return {
      ok: false,
      error: "That is longer than any npm package name and version.",
    };
  if (/^(https?:|git\+|file:|github:)/.test(value) || value.includes(" "))
    return {
      ok: false,
      error:
        "Use a registry name and version, such as clsx@2.1.1. URLs and paths are not accepted.",
    };
  const at = value.lastIndexOf("@");
  const hasVersion = at > 0;
  const name = hasVersion ? value.slice(0, at) : value;
  const version = hasVersion ? value.slice(at + 1) : null;
  if (!NAME.test(name) || name.length > 214)
    return { ok: false, error: `“${name}” is not a valid npm package name.` };
  if (version === null) {
    if (exact)
      return {
        ok: false,
        error: `Add an exact version, such as ${name}@1.0.0.`,
      };
    return { ok: true, name, version: null };
  }
  if (!EXACT.test(version))
    return {
      ok: false,
      error: `Use an exact version, such as ${name}@1.0.0. Tags and ranges like “${version}” are not accepted.`,
    };
  return { ok: true, name, version };
}

export interface RegistryRecord {
  name: string;
  version: string;
  publisher: string | null;
  fileCount: number | null;
  unpackedSize: number | null;
  integrity: string | null;
  tarball: string | null;
  repository: string | null;
  gitHead: string | null;
  installScripts: { hook: string; command: string }[];
  native: boolean;
  provenance: boolean;
}

export function manifestUrl(name: string, version: string | null) {
  const encoded = name.startsWith("@") ? name.replace("/", "%2F") : name;
  return `${REGISTRY}/${encoded}/${version ?? "latest"}`;
}

export function repositoryUrl(repository: unknown): string | null {
  const raw =
    typeof repository === "string"
      ? repository
      : repository && typeof repository === "object" && "url" in repository
        ? String((repository as { url: unknown }).url)
        : null;
  if (!raw) return null;
  const shorthand = raw.match(/^(?:github:)?([\w.-]+)\/([\w.-]+)$/);
  if (shorthand) return `https://github.com/${shorthand[1]}/${shorthand[2]}`;
  const cleaned = raw
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^ssh:\/\/git@/, "https://")
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/\.git$/, "")
    .replace(/#.*$/, "");
  return /^https:\/\//.test(cleaned) ? cleaned : null;
}

export function toRecord(manifest: Record<string, unknown>): RegistryRecord {
  const dist = (manifest.dist ?? {}) as Record<string, unknown>;
  const scripts = (manifest.scripts ?? {}) as Record<string, string>;
  const user = manifest._npmUser as { name?: string } | undefined;
  const attestations = dist.attestations as
    { provenance?: unknown } | undefined;
  return {
    name: String(manifest.name),
    version: String(manifest.version),
    publisher: user?.name ?? null,
    fileCount: typeof dist.fileCount === "number" ? dist.fileCount : null,
    unpackedSize:
      typeof dist.unpackedSize === "number" ? dist.unpackedSize : null,
    integrity: typeof dist.integrity === "string" ? dist.integrity : null,
    tarball: typeof dist.tarball === "string" ? dist.tarball : null,
    repository: repositoryUrl(manifest.repository),
    gitHead: typeof manifest.gitHead === "string" ? manifest.gitHead : null,
    installScripts: INSTALL_HOOKS.filter((hook) => scripts[hook]).map(
      (hook) => ({
        hook,
        command: scripts[hook],
      }),
    ),
    native: manifest.gypfile === true,
    provenance: Boolean(attestations?.provenance),
  };
}

export async function lookupRelease(
  name: string,
  version: string | null,
  init?: RequestInit,
): Promise<
  { ok: true; record: RegistryRecord } | { ok: false; error: string }
> {
  let response: Response;
  try {
    response = await fetch(manifestUrl(name, version), {
      ...init,
      headers: { accept: "application/json" },
    });
  } catch {
    return {
      ok: false,
      error:
        "Couldn’t reach registry.npmjs.org. Check the connection and try again.",
    };
  }
  if (response.status === 404)
    return {
      ok: false,
      error: version
        ? `The registry has no ${name}@${version}.`
        : `The registry has no package named ${name}.`,
    };
  if (!response.ok)
    return {
      ok: false,
      error: `The registry answered ${response.status}. Try again in a moment.`,
    };
  return {
    ok: true,
    record: toRecord((await response.json()) as Record<string, unknown>),
  };
}

// The registry's record for the sample release, as served for clsx@2.1.1.
export const clsxRecord: RegistryRecord = {
  name: "clsx",
  version: "2.1.1",
  publisher: "lukeed",
  fileCount: 10,
  unpackedSize: 8555,
  integrity:
    "sha512-eYm0QWBtUrBWZWG0d386OGAw16Z995PiOVo2B7bjWSbHedGl5e0ZWaq65kOGgUSNesEIDkB9ISbTg/JK9dhCZA==",
  tarball: "https://registry.npmjs.org/clsx/-/clsx-2.1.1.tgz",
  repository: "https://github.com/lukeed/clsx",
  gitHead: "925494cf31bcd97d3337aacd34e659e80cae7fe2",
  installScripts: [],
  native: false,
  provenance: false,
};
