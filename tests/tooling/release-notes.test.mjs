import assert from "node:assert/strict";
import { test } from "node:test";
import * as notes from "../../scripts/release-notes.mjs";

const sha = "a".repeat(40);
const repository = "owner/repo";
const release = (tag_name, extra = {}) => ({
  tag_name,
  draft: false,
  prerelease: false,
  ...extra,
});
const commit = (id, message) => ({
  sha: id.toString(16).padStart(40, "0"),
  commit: { message },
});

test("notes compare the highest published stable release to the exact candidate", async () => {
  assert.equal(typeof notes.releaseNotes, "function");
  const body = await notes.releaseNotes({
    repository,
    sha,
    releases: [
      release("v1.9.0"),
      release("v1.10.0"),
      release("v2.0.0", { draft: true }),
      release("v3.0.0", { prerelease: true }),
      release("v9.0.0-rc.1"),
      release("v01.0.0"),
      release("unrelated"),
    ],
    api: async (endpoint) => {
      assert.equal(endpoint, `compare/v1.10.0...${sha}?per_page=100&page=1`);
      return {
        status: "ahead",
        total_commits: 2,
        commits: [
          commit(1, "Fix first issue\n\nPrivate detail"),
          commit(2, "Ship second issue"),
        ],
      };
    },
  });
  assert.match(body, /Fix first issue/);
  assert.match(body, /Ship second issue/);
  assert.ok(
    body.includes(`https://github.com/owner/repo/commit/${commit(2).sha}`),
  );
  assert.ok(
    body.includes(`https://github.com/owner/repo/compare/v1.10.0...${sha}`),
  );
  assert.doesNotMatch(body, /Private detail/);
});

test("notes bound long subjects and commit count and disclose omitted commits", async () => {
  assert.equal(typeof notes.releaseNotes, "function");
  const body = await notes.releaseNotes({
    repository,
    sha,
    releases: [release("v1.0.0")],
    api: async () => ({
      status: "ahead",
      total_commits: 105,
      commits: Array.from({ length: 100 }, (_, i) =>
        commit(i + 1, "x".repeat(10000)),
      ),
    }),
  });
  assert.equal((body.match(/^- \[/gm) || []).length, 100);
  assert.match(body, /Showing 100 of 105 commits/);
  assert.ok(body.length < 40000);
});

test("commit subjects cannot inject HTML, markdown links or mentions", async () => {
  assert.equal(typeof notes.releaseNotes, "function");
  const body = await notes.releaseNotes({
    repository,
    sha,
    releases: [release("v1.0.0")],
    api: async () => ({
      status: "ahead",
      total_commits: 1,
      commits: [
        commit(1, "<img> [click](https://bad) @someone `code` *bold* & entity"),
      ],
    }),
  });
  assert.doesNotMatch(body, /<img>|\[click\]|@someone|`code`|\*bold\*/);
  assert.match(body, /&lt;img&gt;/);
});

test("initial releases show bounded history without inventing a previous tag", async () => {
  assert.equal(typeof notes.releaseNotes, "function");
  const body = await notes.releaseNotes({
    repository,
    sha,
    releases: [],
    api: async (endpoint) => {
      assert.equal(endpoint, `commits?sha=${sha}&per_page=100&page=1`);
      return [commit(1, "Initial implementation")];
    },
  });
  assert.match(body, /Initial implementation/);
  assert.ok(body.includes(`https://github.com/owner/repo/commits/${sha}`));
  assert.doesNotMatch(body, /undefined|compare\//);
});

test("identical release sources explicitly report no new commits", async () => {
  assert.equal(typeof notes.releaseNotes, "function");
  const body = await notes.releaseNotes({
    repository,
    sha,
    releases: [release("v1.0.0")],
    api: async () => ({ status: "identical", total_commits: 0, commits: [] }),
  });
  assert.match(body, /No new commits/);
});

for (const response of [
  { status: "diverged", total_commits: 1, commits: [commit(1, "Wrong range")] },
  { status: "behind", total_commits: 0, commits: [] },
  { status: "ahead", total_commits: 2, commits: [commit(1, "Incomplete")] },
  {
    status: "ahead",
    total_commits: 1,
    commits: [{ sha: "bad", commit: { message: "Invalid" } }],
  },
]) {
  test(`invalid or incomplete comparison fails closed: ${JSON.stringify(response)}`, async () => {
    assert.equal(typeof notes.releaseNotes, "function");
    await assert.rejects(() =>
      notes.releaseNotes({
        repository,
        sha,
        releases: [release("v1.0.0")],
        api: async () => response,
      }),
    );
  });
}

test("GitHub failures are surfaced instead of publishing an empty changelog", async () => {
  assert.equal(typeof notes.releaseNotes, "function");
  await assert.rejects(
    () =>
      notes.releaseNotes({
        repository,
        sha,
        releases: [release("v1.0.0")],
        api: async () => {
          throw new Error("GitHub unavailable");
        },
      }),
    /GitHub unavailable/,
  );
});
