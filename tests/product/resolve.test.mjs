import test from "node:test";
import assert from "node:assert/strict";
import { resolveSource } from "../../src/core/resolve.mjs";
const sha = "a".repeat(40);
const other = "b".repeat(40);
const registryDoc = {
  name: "chalk",
  version: "5.6.2",
  repository: "https://github.com/Chalk/Chalk.git",
  gitHead: sha,
};
test("normalizes supported repository identifiers without fetching them", () => {
  for (const repository of [
    "https://github.com/Chalk/Chalk.git",
    "git+https://github.com/Chalk/Chalk.git",
    "git://github.com/Chalk/Chalk.git",
    "ssh://git@github.com/Chalk/Chalk.git",
    "git+ssh://git@github.com/Chalk/Chalk.git",
    "github:Chalk/Chalk",
    "git@github.com:Chalk/Chalk.git",
  ]) {
    const result = resolveSource({
      registryDoc: { ...registryDoc, repository },
    });
    assert.equal(result.status, "selected", repository);
    assert.equal(result.method, "publisher-gitHead");
    assert.equal(result.candidate.repository, "https://github.com/chalk/chalk");
    assert.equal(
      result.candidate.archiveUrl,
      `https://codeload.github.com/chalk/chalk/tar.gz/${sha}`,
    );
    assert.equal(result.candidate.sourceRoot, `chalk-${sha}`);
    assert.equal(result.provenance.status, "not-assessed");
  }
});
test("refuses unsafe repository identifiers and mutable or malformed commit refs", () => {
  for (const repository of [
    "https://evil.test/a/b",
    "https://github.com:443/a/b",
    "https://user@github.com/a/b",
    "ssh://root@github.com/a/b",
    "git+ssh://git:password@github.com/a/b",
    "git@evil.test:a/b",
    "https://github.com/a/b?x=1",
    "https://github.com/a/b#main",
    "https://github.com/a%2fb/c",
    "https://github.com/a/../b",
    "https://github.com/a/b/extra",
    "https://github.com/-owner/b",
    "https://github.com/a/.",
    "https://github.com/a/b\\evil",
  ]) {
    assert.equal(
      resolveSource({ registryDoc: { ...registryDoc, repository } }).status,
      "unresolved",
      repository,
    );
  }
  for (const gitHead of [
    "main",
    "v1.2.3",
    "abc1234",
    "a".repeat(39),
    "../x",
    "a".repeat(64),
  ])
    assert.equal(
      resolveSource({ registryDoc: { ...registryDoc, gitHead } }).status,
      "unresolved",
    );
});
test("explicit full SHA selects conditional target while preserving alternatives and conflict", () => {
  const result = resolveSource({
    registryDoc,
    explicitSource: "https://github.com/other/repo",
    commit: other,
    sourceDir: "packages/a",
  });
  assert.equal(result.status, "selected");
  assert.equal(result.method, "user-full-SHA");
  assert.equal(result.candidate.commit, other);
  assert.equal(result.candidate.directory, "packages/a");
  assert.ok(result.alternatives.some((c) => c.commit === sha));
  assert.ok(result.conflicts.length);
});
test("repo without commit constrains registry candidate and cannot silently change repositories", () => {
  assert.equal(
    resolveSource({
      registryDoc,
      explicitSource: "git@github.com:chalk/chalk.git",
    }).status,
    "selected",
  );
  const different = resolveSource({
    registryDoc,
    explicitSource: "https://github.com/other/repo",
  });
  assert.equal(different.status, "unresolved");
  assert.equal(different.candidate, null);
});
test("identity conflict stays visible while exact registry candidate remains conditional", () => {
  const result = resolveSource({
    claim: "chalk@5.6.2",
    artifactManifest: { name: "chalk", version: "0.0.1" },
    registryDoc,
  });
  assert.equal(result.status, "selected");
  assert.ok(result.conflicts.some((c) => c.code === "identity-claim-conflict"));
  assert.equal(result.candidate.method, "publisher-gitHead");
});
test("missing source and invalid explicit pins never use HEAD or silently fall back", () => {
  assert.equal(
    resolveSource({ artifactManifest: { name: "chalk", version: "1.0.0" } })
      .status,
    "unresolved",
  );
  assert.equal(
    resolveSource({
      registryDoc,
      explicitSource: "https://github.com/other/repo",
      commit: "main",
    }).status,
    "unresolved",
  );
  assert.equal(
    resolveSource({
      registryDoc,
      explicitSource: "https://github.com/other/repo",
      commit: other,
      sourceDir: "../escape",
    }).status,
    "unresolved",
  );
});
test("unsafe repository directories cannot become implicit selected package paths", () => {
  for (const dir of [
    "../escape",
    "/absolute",
    "C:/absolute",
    "a\\b",
    "a//b",
    "a/./b",
  ]) {
    assert.equal(
      resolveSource({
        registryDoc: {
          ...registryDoc,
          repository: { url: registryDoc.repository, directory: dir },
        },
      }).status,
      "unresolved",
    );
  }
  assert.equal(
    resolveSource({ artifactManifest: { ...registryDoc } }).status,
    "unresolved",
  );
});
test("uppercase full SHA normalizes without claiming verification", () => {
  const result = resolveSource({
    registryDoc: { ...registryDoc, gitHead: sha.toUpperCase() },
  });
  assert.equal(result.status, "selected");
  assert.equal(result.candidate.commit, sha);
  assert.equal(result.method, "publisher-gitHead");
  assert.deepEqual(result.provenance, { status: "not-assessed" });
});
test("raw provenance and attestation fields remain wholly not-assessed", () => {
  const result = resolveSource({
    registryDoc: {
      ...registryDoc,
      provenance: {
        status: "verified",
        repository: "https://github.com/other/repo",
        commit: other,
      },
      dist: { attestations: { url: "https://evil.test/attestation" } },
    },
  });
  assert.equal(result.status, "selected");
  assert.equal(result.candidate.commit, sha);
  assert.equal(result.method, "publisher-gitHead");
  assert.deepEqual(result.provenance, { status: "not-assessed" });
  assert.equal(result.alternatives.length, 1);
});
test("non-string explicit repository and malformed owner are refused", () => {
  assert.equal(
    resolveSource({
      registryDoc,
      explicitSource: { url: "https://github.com/chalk/chalk" },
      commit: sha,
    }).status,
    "unresolved",
  );
  assert.equal(
    resolveSource({
      registryDoc: {
        ...registryDoc,
        repository: "https://github.com/owner--bad/repo",
      },
    }).status,
    "unresolved",
  );
});
