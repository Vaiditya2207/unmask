import {
  AcquisitionError,
  fetchBlob,
  parsePackageSpec,
} from "../core/acquire.mjs";
import { LocalInputError } from "../core/pipeline.mjs";
import { checkHosted } from "./hosted.mjs";

const failure = (code, message) => new LocalInputError(code, message);

export async function resolveScanSpec(spec, runtime = {}) {
  if (typeof spec !== "string" || spec.length > 512)
    throw failure(
      "invalid-package-spec",
      "Use a package name, exact version or dist-tag.",
    );
  try {
    const identity = parsePackageSpec(spec);
    return {
      ...identity,
      selector: identity.version,
      spec,
      registryUrl: null,
      observedAt: null,
    };
  } catch (error) {
    if (!(error instanceof AcquisitionError)) throw error;
  }
  const at = spec.lastIndexOf("@");
  const name = at > 0 ? spec.slice(0, at) : spec;
  const selector = at > 0 ? spec.slice(at + 1) : "latest";
  try {
    parsePackageSpec(`${name}@0.0.0`);
  } catch {
    throw failure("invalid-package-spec", "Use a public npm package name.");
  }
  if (!/^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/.test(selector))
    throw failure(
      "unsupported-selector",
      "Semver ranges are unsupported; use an exact version or named dist-tag such as latest.",
    );
  const registryUrl = `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(selector)}`;
  try {
    const blob = await fetchBlob(registryUrl, {
      fetchImpl: runtime.fetchImpl,
      signal: runtime.signal,
      maxBytes: 1024 * 1024,
      timeoutMs: 15000,
    });
    let metadata;
    try {
      metadata = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(blob.bytes),
      );
    } catch {
      throw failure(
        "invalid-registry-document",
        "Registry resolution must return valid UTF-8 JSON.",
      );
    }
    if (
      !metadata ||
      metadata.name !== name ||
      typeof metadata.version !== "string"
    )
      throw failure(
        "registry-identity-mismatch",
        "Registry resolution returned an unexpected package identity.",
      );
    let identity;
    try {
      identity = parsePackageSpec(`${name}@${metadata.version}`);
    } catch {
      throw failure(
        "invalid-registry-document",
        "Registry resolution did not return an exact version.",
      );
    }
    return {
      ...identity,
      selector,
      spec: `${name}@${identity.version}`,
      registryUrl,
      observedAt: blob.observation.observedAt,
    };
  } catch (error) {
    if (error instanceof AcquisitionError)
      throw failure(error.code, error.message);
    throw error;
  }
}

export async function runScan(argv, runtime = {}) {
  if (
    argv.length < 1 ||
    argv.length > 2 ||
    (argv.length === 2 && argv[1] !== "--json")
  )
    throw failure(
      "usage",
      "Use scan package[@version-or-tag] [--json]. Semver ranges are unsupported.",
    );
  const json = argv[1] === "--json";
  const stdout = runtime.stdout ?? process.stdout;
  const resolution = await resolveScanSpec(argv[0], runtime);
  if (!json) stdout.write(`Pinned ${argv[0]} -> ${resolution.spec}\n`);
  const report = await checkHosted(resolution.spec, {
    serverUrl: (runtime.env ?? process.env).UNMASK_SERVER_URL,
    fetchImpl: runtime.fetchImpl,
    signal: runtime.signal,
    limits: runtime.hostedLimits,
  });
  if (json)
    stdout.write(
      JSON.stringify({ requested: argv[0], resolution, report }) + "\n",
    );
  else
    stdout.write(
      `Completed ${resolution.spec}: policy exit ${report.policy.exitCode}; AI status ${JSON.stringify(report.model?.status ?? "unavailable")}.\nNo findings do not establish safety.\n`,
    );
  return report.policy.exitCode;
}
