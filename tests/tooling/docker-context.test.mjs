import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import * as candidate from "../../scripts/check-candidate.mjs";
import { checkPackage } from "../../scripts/check-package.mjs";
import { buildFixture } from "./build-fixture.mjs";

function fixture(t) {
  const f = buildFixture(t, {
    clean: true,
    configure({ root }) {
      writeFileSync(path.join(root, "Dockerfile"), "FROM scratch\n");
      writeFileSync(
        path.join(root, ".dockerignore"),
        "**\n!Dockerfile\n!artifact.tgz\n!package.json\n!package-lock.json\n!candidate.json\n",
      );
      mkdirSync(path.join(root, "private"));
      writeFileSync(path.join(root, "private/never-copy"), "fixture secret");
    },
  });
  f.build();
  const artifact = checkPackage(f.root, path.join(f.root, "output"), {
    expectedSha: f.sha,
    requireClean: true,
  });
  return {
    ...f,
    artifact,
    archive: path.join(f.root, "output", artifact.filename),
  };
}

test("isolated Docker context contains the exact archive and matching lock, never source replacement", (t) => {
  assert.equal(typeof candidate.createDockerContext, "function");
  const f = fixture(t);
  const context = candidate.createDockerContext(f.root, {
    archive: f.archive,
    artifact: f.artifact,
    sha: f.sha,
  });
  t.after(() => context.cleanup());
  assert.deepEqual(readdirSync(context.directory).sort(), [
    ".dockerignore",
    "Dockerfile",
    "artifact.tgz",
    "candidate.json",
    "package-lock.json",
    "package.json",
  ]);
  assert.deepEqual(
    readFileSync(path.join(context.directory, "artifact.tgz")),
    readFileSync(f.archive),
  );
  assert.deepEqual(
    readFileSync(path.join(context.directory, "package-lock.json")),
    readFileSync(path.join(f.root, "package-lock.json")),
  );
  assert.equal(context.manifest.commit, f.sha);
  assert.equal(context.manifest.packageDigest, f.artifact.digest);
  assert.equal(context.manifest.lockDigest, f.artifact.lockDigest);
  context.verify();
});

for (const file of [
  "artifact.tgz",
  "package-lock.json",
  "package.json",
  "Dockerfile",
  "candidate.json",
]) {
  test(`context verification rejects replaced ${file}`, (t) => {
    const f = fixture(t);
    const context = candidate.createDockerContext(f.root, {
      archive: f.archive,
      artifact: f.artifact,
      sha: f.sha,
    });
    t.after(() => context.cleanup());
    writeFileSync(path.join(context.directory, file), "replaced");
    assert.throws(() => context.verify(), /digest|bytes|context/i);
  });
}
