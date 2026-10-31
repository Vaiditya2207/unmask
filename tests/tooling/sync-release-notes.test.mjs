import assert from "node:assert/strict";
import { test } from "node:test";
import * as sync from "../../scripts/sync-release-notes.mjs";

const sha = "a".repeat(40);
function fixture(change = {}) {
  let current = {
    id: 12,
    tag_name: "v0.1.2",
    target_commitish: sha,
    name: "Release title",
    body: "Existing artifact and runtime evidence.",
    draft: false,
    prerelease: false,
    immutable: true,
    published_at: "2026-10-31T00:00:00Z",
    assets: [
      { id: 1, name: "artifact.tgz", digest: "sha256:unchanged", size: 42 },
    ],
    ...change,
  };
  const writes = [];
  const api = async (endpoint, options = {}) => {
    if (options.method === "PATCH") {
      assert.equal(endpoint, "releases/12");
      assert.deepEqual(Object.keys(options.body), ["body"]);
      writes.push(options.body);
      current = { ...current, ...options.body };
      return current;
    }
    if (endpoint === "releases?per_page=100&page=1")
      return [
        current,
        { ...current, id: 11, tag_name: "v0.1.1" },
        { ...current, id: 10, tag_name: "v0.1.0" },
        { ...current, id: 99, tag_name: "v9.0.0", draft: true },
      ];
    if (endpoint === "releases/12") return structuredClone(current);
    if (endpoint === "git/ref/tags/v0.1.2")
      return { object: { type: "commit", sha } };
    if (endpoint === `compare/v0.1.1...${sha}?per_page=100&page=1`)
      return {
        status: "ahead",
        total_commits: 1,
        commits: [{ sha, commit: { message: "Ship fixes" } }],
      };
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };
  return {
    api,
    writes,
    get current() {
      return current;
    },
  };
}

test("backfill preserves evidence, patches body only and is idempotent", async () => {
  assert.equal(typeof sync.syncReleaseNotes, "function");
  const f = fixture();
  const input = { repository: "Vaiditya2207/unmask", api: f.api };
  assert.equal((await sync.syncReleaseNotes(input)).updated, true);
  assert.ok(
    f.current.body.startsWith(
      "Existing artifact and runtime evidence.\n\n## Commits",
    ),
  );
  assert.match(f.current.body, /Changes since v0\.1\.1/);
  assert.equal((await sync.syncReleaseNotes(input)).updated, false);
  assert.equal(f.writes.length, 1);
});

test("mismatched tag binding prevents any write", async () => {
  assert.equal(typeof sync.syncReleaseNotes, "function");
  const f = fixture({ target_commitish: "b".repeat(40) });
  await assert.rejects(
    () =>
      sync.syncReleaseNotes({ repository: "Vaiditya2207/unmask", api: f.api }),
    /tag|commit/i,
  );
  assert.equal(f.writes.length, 0);
});

test("non-equivalent existing commit section is preserved for manual review", async () => {
  assert.equal(typeof sync.syncReleaseNotes, "function");
  const f = fixture({ body: "Evidence\n\n## Commits\nHuman-written section" });
  await assert.rejects(
    () =>
      sync.syncReleaseNotes({ repository: "Vaiditya2207/unmask", api: f.api }),
    /existing commit section/i,
  );
  assert.equal(f.writes.length, 0);
});

test("readback detects changed protected release fields", async () => {
  assert.equal(typeof sync.syncReleaseNotes, "function");
  const f = fixture();
  const api = async (endpoint, options) => {
    const result = await f.api(endpoint, options);
    return endpoint === "releases/12" && f.writes.length
      ? { ...result, name: "Changed by another actor" }
      : result;
  };
  await assert.rejects(
    () => sync.syncReleaseNotes({ repository: "Vaiditya2207/unmask", api }),
    /changed|verification/i,
  );
});

test("mutable releases and concurrent body edits prevent writes", async () => {
  const mutable = fixture({ immutable: false });
  await assert.rejects(
    () =>
      sync.syncReleaseNotes({
        repository: "Vaiditya2207/unmask",
        api: mutable.api,
      }),
    /immutable/,
  );
  assert.equal(mutable.writes.length, 0);
  const f = fixture();
  let reads = 0;
  const api = async (endpoint, options) => {
    const value = await f.api(endpoint, options);
    if (endpoint === "releases/12" && ++reads > 1)
      return { ...value, body: "Concurrent edit" };
    return value;
  };
  await assert.rejects(
    () => sync.syncReleaseNotes({ repository: "Vaiditya2207/unmask", api }),
    /changed before/,
  );
  assert.equal(f.writes.length, 0);
});

test("annotated tags resolve to the bound commit", async () => {
  const f = fixture();
  const api = async (endpoint, options) => {
    if (endpoint === "git/ref/tags/v0.1.2")
      return { object: { type: "tag", sha: "c".repeat(40) } };
    if (endpoint === `git/tags/${"c".repeat(40)}`)
      return { object: { type: "commit", sha } };
    return f.api(endpoint, options);
  };
  assert.equal(
    (await sync.syncReleaseNotes({ repository: "Vaiditya2207/unmask", api }))
      .updated,
    true,
  );
});
