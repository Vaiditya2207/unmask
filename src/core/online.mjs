import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  getRegistryRelease,
  fetchBlob,
  parsePackageSpec,
  AcquisitionError,
} from "./acquire.mjs";
import { resolveSource } from "./resolve.mjs";
import {
  analyzeLocal,
  LocalInputError,
  effectiveLimits,
  preserveInputBytes,
} from "./pipeline.mjs";
import { createReport, validateReport } from "./report.mjs";
import { addManifestObservations } from "./manifests.mjs";

function integrity(raw, actual) {
  const values = [];
  let malformed = raw !== null && raw !== undefined && typeof raw !== "string";
  const recognized = { sha1: 20, sha256: 32, sha384: 48, sha512: 64 };
  const unsupported = new Set();
  for (const token of typeof raw === "string"
    ? raw.trim().split(/\s+/).filter(Boolean)
    : []) {
    const expression = token.split("?")[0];
    const dash = expression.indexOf("-");
    const algorithm = dash === -1 ? expression : expression.slice(0, dash);
    const encoded = dash === -1 ? "" : expression.slice(dash + 1);
    if (!Object.hasOwn(recognized, algorithm)) {
      unsupported.add(algorithm);
      continue;
    }
    const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Buffer.from(normalized, "base64");
    const canonical = bytes.toString("base64");
    if (
      !/^[A-Za-z0-9+/_-]+={0,2}$/.test(encoded) ||
      bytes.length !== recognized[algorithm] ||
      canonical.replace(/=+$/, "") !== normalized.replace(/=+$/, "") ||
      (encoded.includes("=") && canonical !== normalized)
    ) {
      malformed = true;
      continue;
    }
    if (algorithm === "sha256" || algorithm === "sha512")
      values.push({ algorithm, digest: bytes.toString("hex") });
    else unsupported.add(algorithm);
  }
  const algorithm = values.some((value) => value.algorithm === "sha512")
    ? "sha512"
    : "sha256";
  const candidates = values
    .filter((value) => value.algorithm === algorithm)
    .sort((a, b) => (a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0));
  const selected =
    candidates.find((value) => value.digest === actual[algorithm]) ||
    candidates[0];
  const expected = selected
    ? {
        ...selected,
        status: selected.digest === actual[algorithm] ? "match" : "mismatch",
        ...(unsupported.size
          ? { unsupportedAlgorithms: [...unsupported].sort() }
          : {}),
      }
    : {
        status: "unavailable",
        reason: unsupported.size
          ? "unsupported-algorithm"
          : "missing-or-invalid",
      };
  return {
    expected,
    failures: malformed
      ? [
          {
            code: "invalid-registry-integrity",
            message: "Recognized registry integrity metadata is malformed",
          },
        ]
      : [],
  };
}
function rebuild(report, updates) {
  const next = createReport({
    inputs: updates.inputs || report.inputs,
    source: updates.source || report.source,
    comparison: {
      files: report.files,
      coverage: report.coverage,
      evidence: report.evidence,
    },
    manifests: updates.manifests || report.manifests,
    failures: updates.failures || report.failures,
    run: updates.run || report.run,
    analyzerVersion: report.analyzerVersion,
    limitsVersion: report.limitsVersion,
  });
  next.cues = report.cues;
  next.annotations = report.annotations;
  next.model = report.model;
  return validateReport(next);
}
export async function addConfiguredModel(report, model) {
  if (model === undefined) return report;
  if (typeof model !== "function")
    return validateReport({
      ...report,
      model: { status: "unavailable", reason: "not-configured" },
    });
  try {
    const section = await model(structuredClone(report));
    return validateReport({ ...report, model: section });
  } catch {
    return validateReport({
      ...report,
      model: { status: "unavailable", reason: "model-request-failed" },
    });
  }
}

export async function analyzeRegistry(
  spec,
  {
    workDir,
    fetchImpl,
    signal,
    limits: overrides,
    model,
    persistCache = true,
  } = {},
) {
  let identity;
  try {
    identity = parsePackageSpec(spec);
  } catch (error) {
    if (error instanceof AcquisitionError)
      throw new LocalInputError(error.code, error.message);
    throw error;
  }
  if (typeof workDir !== "string" || !workDir)
    throw new LocalInputError(
      "work-dir-required",
      "Registry analysis requires an explicit private work directory",
    );
  if (typeof persistCache !== "boolean")
    throw new LocalInputError(
      "invalid-cache-policy",
      "persistCache must be an explicit boolean",
    );
  const limits = effectiveLimits(overrides);
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  const jobDir = await mkdtemp(path.join(workDir, "job-"));
  const observations = [];
  try {
    let release, artifact;
    try {
      release = await getRegistryRelease(identity, { fetchImpl, signal });
      observations.push(release.observation);
      await writeFile(
        path.join(jobDir, "registry.json"),
        release.metadataBytes,
        { flag: "wx", mode: 0o600 },
      );
      if (persistCache)
        await preserveInputBytes(
          workDir,
          { digest: release.metadataDigest },
          release.metadataBytes,
          observations,
        );
      artifact = await fetchBlob(release.tarballUrl, {
        fetchImpl,
        signal,
        maxBytes: limits.compressedBytes,
      });
      observations.push(artifact.observation);
    } catch (error) {
      if (error instanceof AcquisitionError)
        throw new LocalInputError(error.code, error.message);
      throw error;
    }
    const tarballPath = path.join(jobDir, "artifact.tgz");
    await writeFile(tarballPath, artifact.bytes, { flag: "wx", mode: 0o600 });
    const resolution = resolveSource({
      claim: identity,
      registryDoc: release.metadata,
    });
    const candidate = resolution.candidate;
    const sourceOptions = {};
    const failures = [];
    let sourceFetchFailed = false;
    if (candidate) {
      try {
        const source = await fetchBlob(candidate.archiveUrl, {
          fetchImpl,
          signal,
          maxBytes: limits.compressedBytes,
        });
        observations.push(source.observation);
        sourceOptions.sourceArchivePath = path.join(jobDir, "source.tgz");
        sourceOptions.commit = candidate.commit;
        sourceOptions.sourceRoot = candidate.sourceRoot;
        if (
          typeof release.metadata.repository === "object" &&
          release.metadata.repository !== null &&
          Object.hasOwn(release.metadata.repository, "directory")
        )
          sourceOptions.sourceDir = candidate.directory;
        await writeFile(sourceOptions.sourceArchivePath, source.bytes, {
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        if (!(error instanceof AcquisitionError)) throw error;
        if (error.observation) observations.push(error.observation);
        sourceFetchFailed = true;
        failures.push({
          code: "source-acquisition-failed",
          message: "Selected publisher source archive could not be acquired",
          reason: error.code,
        });
      }
    }
    const report = await analyzeLocal({
      tarballPath,
      ...sourceOptions,
      claim: identity,
      limits: overrides,
      cacheDir: persistCache ? workDir : undefined,
    });
    const checked = integrity(
      release.expectedIntegrity,
      report.inputs.artifact,
    );
    if (
      release.metadata.dist?.integrity !== undefined &&
      typeof release.metadata.dist.integrity !== "string"
    )
      checked.failures.push({
        code: "invalid-registry-integrity",
        message: "Registry integrity must be a string",
      });
    const source = candidate
      ? {
          ...report.source,
          method: candidate.method,
          repository: candidate.repository,
          commit: candidate.commit,
          alternatives: resolution.alternatives,
          ...(sourceFetchFailed
            ? {
                status: "unavailable",
                complete: false,
                reason: "source-acquisition-failed",
              }
            : {}),
        }
      : {
          ...report.source,
          method: resolution.method,
          status: resolution.status,
          alternatives: resolution.alternatives,
          reason: resolution.reason || "no-source-candidate",
        };
    const inputs = {
      ...report.inputs,
      artifact: {
        ...report.inputs.artifact,
        kind: "registry",
        expectedIntegrity: checked.expected,
        provenance: { status: "not-assessed" },
      },
      registryDocument: { ...release.metadataDigest, kind: "registry" },
      limits: {
        ...report.inputs.limits,
        acquisition: {
          metadataBytes: 1048576,
          timeoutMs: 30000,
          redirects: "forbidden",
        },
      },
      ...(report.inputs.sourceArchive
        ? { sourceArchive: { ...report.inputs.sourceArchive, kind: "remote" } }
        : {}),
    };
    const next = rebuild(report, {
      inputs,
      source,
      manifests: {
        ...report.manifests,
        registry: {
          status: "usable",
          value: release.metadata,
          evidenceIds: [],
        },
      },
      failures: [...report.failures, ...failures, ...checked.failures],
      run: {
        ...report.run,
        observations: [...report.run.observations, ...observations],
      },
    });
    return await addConfiguredModel(addManifestObservations(next), model);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
}
