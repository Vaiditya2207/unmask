function repository(value) {
  const input = typeof value === "string" ? value : value?.url;
  if (
    typeof input !== "string" ||
    input.length > 512 ||
    /[\s%\\?#\0]/u.test(input)
  )
    return null;
  let pair;
  if (input.startsWith("github:")) pair = input.slice(7);
  else if (input.startsWith("git@github.com:"))
    pair = input.slice("git@github.com:".length);
  else {
    const match =
      /^(https|git\+https|git|ssh|git\+ssh):\/\/([^/]+)\/(.+)$/u.exec(input);
    if (!match) return null;
    const ssh = ["ssh", "git+ssh"].includes(match[1]);
    if (match[2] !== (ssh ? "git@github.com" : "github.com")) return null;
    pair = match[3];
  }
  if (pair.endsWith(".git")) pair = pair.slice(0, -4);
  const match =
    /^([a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?)\/([a-z0-9_.-]{1,100})$/iu.exec(
      pair,
    );
  if (!match || match[1].includes("--") || [".", ".."].includes(match[2]))
    return null;
  return {
    owner: match[1].toLowerCase(),
    repo: match[2].toLowerCase(),
    repository: `https://github.com/${match[1].toLowerCase()}/${match[2].toLowerCase()}`,
  };
}
function directory(value) {
  if (value === undefined || value === "") return "";
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    /[\0\\]/u.test(value) ||
    value.startsWith("/") ||
    /^[a-z]:/iu.test(value) ||
    value.split("/").some((p) => !p || p === "." || p === "..")
  )
    return null;
  return value;
}
function candidate(repo, commit, dir, method) {
  if (
    !repo ||
    typeof commit !== "string" ||
    !/^[a-f0-9]{40}$/iu.test(commit) ||
    dir === null
  )
    return null;
  const sha = commit.toLowerCase();
  return {
    repository: repo.repository,
    commit: sha,
    directory: dir,
    method,
    archiveUrl: `https://codeload.github.com/${repo.owner}/${repo.repo}/tar.gz/${sha}`,
    sourceRoot: `${repo.repo}-${sha}`,
  };
}
function same(a, b) {
  return a.repository === b.repository && a.commit === b.commit;
}
function identity(value) {
  if (typeof value === "string") {
    const at = value.lastIndexOf("@");
    return at > 0
      ? { name: value.slice(0, at), version: value.slice(at + 1) }
      : null;
  }
  return value &&
    typeof value.name === "string" &&
    typeof value.version === "string"
    ? { name: value.name, version: value.version }
    : null;
}
export function resolveSource({
  claim,
  artifactManifest,
  registryDoc,
  explicitSource,
  commit,
  sourceDir,
} = {}) {
  const result = {
    status: "unresolved",
    method: "unresolved",
    candidate: null,
    alternatives: [],
    provenance: { status: "not-assessed" },
    conflicts: [],
  };
  const requested = identity(claim),
    artifact = identity(artifactManifest),
    registry = identity(registryDoc);
  if (
    (requested &&
      artifact &&
      (requested.name !== artifact.name ||
        requested.version !== artifact.version)) ||
    (requested &&
      registry &&
      (requested.name !== registry.name ||
        requested.version !== registry.version))
  )
    result.conflicts.push({
      code: "identity-claim-conflict",
      claim: requested,
      artifact,
      registry,
    });
  const registryRepo = repository(registryDoc?.repository);
  const artifactRepo = repository(artifactManifest?.repository);
  if (
    registryRepo &&
    artifactRepo &&
    registryRepo.repository !== artifactRepo.repository
  )
    result.conflicts.push({
      code: "repository-claim-conflict",
      artifact: artifactRepo.repository,
      registry: registryRepo.repository,
    });
  const publisher = candidate(
    registryRepo,
    registryDoc?.gitHead,
    directory(registryDoc?.repository?.directory),
    "publisher-gitHead",
  );
  if (publisher) result.alternatives.push(publisher);
  const explicitRepo =
    typeof explicitSource === "string" ? repository(explicitSource) : null;
  if (explicitSource !== undefined && !explicitRepo) {
    result.reason = "unsupported-explicit-repository";
    return result;
  }
  const dir = sourceDir === undefined ? undefined : directory(sourceDir);
  if (dir === null) {
    result.reason = "invalid-source-directory";
    return result;
  }
  if (commit !== undefined) {
    const pinned = candidate(
      explicitRepo ?? registryRepo ?? artifactRepo,
      commit,
      dir ?? "",
      "user-full-SHA",
    );
    if (!pinned) {
      result.reason = "invalid-user-pin";
      return result;
    }
    if (publisher && !same(publisher, pinned))
      result.conflicts.push({
        code: "source-claim-conflict",
        alternatives: [publisher, pinned],
      });
    result.alternatives.push(pinned);
    return {
      ...result,
      status: "selected",
      method: pinned.method,
      candidate: pinned,
    };
  }
  if (!publisher) {
    result.reason = "no-full-sha-source-candidate";
    return result;
  }
  if (explicitRepo && explicitRepo.repository !== publisher.repository) {
    result.reason = "explicit-repository-disagrees";
    return result;
  }
  const selected =
    dir === undefined ? publisher : { ...publisher, directory: dir };
  return {
    ...result,
    status: "selected",
    method: selected.method,
    candidate: selected,
  };
}
