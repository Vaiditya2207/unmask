export const POLICY_VERSION = "default-1";

const nonempty = (value) => typeof value === "string" && value.length > 0;
const usable = (manifest) =>
  manifest?.status === "usable" &&
  manifest.value &&
  typeof manifest.value === "object" &&
  !Array.isArray(manifest.value);

export function policyResult(report) {
  const findings = [];
  const artifact = report.inputs.artifact;
  const manifests = report.manifests;
  function finding(ruleId, evidenceIds = [], details = {}) {
    findings.push({
      ruleId,
      evidenceIds: [...new Set(evidenceIds)].sort(),
      ...details,
    });
  }
  const expected = artifact.expectedIntegrity;
  if (
    expected &&
    ["sha256", "sha512"].includes(expected.algorithm) &&
    typeof expected.digest === "string" &&
    typeof artifact[expected.algorithm] === "string" &&
    expected.digest !== artifact[expected.algorithm]
  ) {
    finding("integrity-mismatch", [], {
      algorithm: expected.algorithm,
      expected: expected.digest,
      actual: artifact[expected.algorithm],
    });
  }
  if (
    artifact.provenance?.verificationImplemented === true &&
    artifact.provenance.status === "failed"
  )
    finding("provenance-verification-failed");
  if (report.inputs.claim && usable(manifests.artifact)) {
    const conflicts = ["name", "version"].filter(
      (field) =>
        typeof report.inputs.claim[field] === "string" &&
        report.inputs.claim[field] !== manifests.artifact.value[field],
    );
    if (conflicts.length)
      finding("identity-claim-conflict", manifests.artifact.evidenceIds, {
        fields: conflicts,
      });
  }
  const sourceUsable =
    report.source.complete === true &&
    ["selected", "resolved"].includes(report.source.status) &&
    !["unresolved", "conflicting"].includes(report.source.method) &&
    report.coverage.sourceComplete === true &&
    usable(manifests.artifact) &&
    usable(manifests.source);
  if (sourceUsable) {
    const a = manifests.artifact.value;
    const s = manifests.source.value;
    const manifestEvidence = [
      ...(manifests.artifact.evidenceIds || []),
      ...(manifests.source.evidenceIds || []),
    ];
    for (const name of ["preinstall", "install", "postinstall"]) {
      if (nonempty(a.scripts?.[name]) && a.scripts[name] !== s.scripts?.[name])
        finding("lifecycle-source-absent", manifestEvidence, { script: name });
    }
    const gyp = report.files.find(
      (file) => file.path === "binding.gyp" && file.state === "artifact-only",
    );
    if (
      gyp &&
      !nonempty(a.scripts?.install) &&
      !nonempty(a.scripts?.preinstall) &&
      a.gypfile !== false
    )
      finding("lifecycle-implicit-gyp", [
        ...manifestEvidence,
        ...(gyp.evidenceIds || []),
      ]);
  }
  return {
    exitCode:
      report.coverage.complete !== true || report.failures.length > 0
        ? 2
        : findings.length > 0
          ? 3
          : 0,
    findings,
  };
}
