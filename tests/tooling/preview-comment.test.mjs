import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  upsertPreviewComment,
  PREVIEW_COMMENT_MARKER,
  githubAPI,
} from "../../scripts/web-preview.mjs";

const commit = "a".repeat(40);
const repo = {
  id: 1440901935,
  full_name: "Vaiditya2207/unmask",
  owner: { id: 145288107 },
};
const receipt = () => ({
  status: "verified",
  service: "unmask-web-preview",
  pr: 12,
  commit,
  version: "0.1.1",
  url: "https://pr-12---unmask-web-preview-test.a.run.app",
});
const pull = () => ({
  number: 12,
  state: "open",
  head: { sha: commit, repo },
  base: { ref: "main", repo },
});
const owned = (id = 7, body = PREVIEW_COMMENT_MARKER + "\nold") => ({
  id,
  body,
  user: { login: "github-actions[bot]", type: "Bot" },
  issue_url: "https://api.github.com/repos/Vaiditya2207/unmask/issues/12",
});
function fixture(comments = []) {
  const calls = [];
  let current = pull();
  const f = {
    calls,
    changeHead() {
      current.head.sha = "b".repeat(40);
    },
    api: async (route, options = {}) => {
      calls.push({ route, ...options });
      if (route.endsWith("/pulls/12")) return current;
      if (route.includes("/issues/12/comments?")) return comments;
      if (route.endsWith("/issues/comments/7") && !options.method)
        return comments.find((item) => item.id === 7);
      if (options.method === "POST" || options.method === "PATCH")
        return owned(7, options.body.body);
      throw new Error("Unexpected fake API request");
    },
  };
  return f;
}

test("verified preview creates one bot-marked PR message with URL, full head, version and run link", async () => {
  const f = fixture();
  const result = await upsertPreviewComment({
    receipt: receipt(),
    runId: 123,
    api: f.api,
  });
  assert.equal(result.status, "created");
  const writes = f.calls.filter((call) => call.method);
  assert.equal(writes.length, 1);
  assert.equal(
    writes[0].route,
    "/repos/Vaiditya2207/unmask/issues/12/comments",
  );
  assert.equal(writes[0].method, "POST");
  const body = writes[0].body.body;
  assert.ok(body.startsWith(PREVIEW_COMMENT_MARKER));
  assert.ok(body.includes(`[Open preview](${receipt().url})`));
  assert.ok(body.includes(commit));
  assert.ok(body.includes("0.1.1"));
  assert.ok(
    body.includes("https://github.com/Vaiditya2207/unmask/actions/runs/123"),
  );
});

test("upsert edits only its marked github-actions bot message and leaves other comments alone", async () => {
  const others = [
    { ...owned(8), user: { login: "human", type: "User" } },
    owned(9, "unrelated bot comment"),
  ];
  const f = fixture([...others, owned()]);
  assert.equal(
    (await upsertPreviewComment({ receipt: receipt(), runId: 123, api: f.api }))
      .status,
    "updated",
  );
  const writes = f.calls.filter((call) => call.method);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, "PATCH");
  assert.equal(writes[0].route, "/repos/Vaiditya2207/unmask/issues/comments/7");
  const alone = fixture(others);
  assert.equal(
    (
      await upsertPreviewComment({
        receipt: receipt(),
        runId: 123,
        api: alone.api,
      })
    ).status,
    "created",
  );
});

test("unsafe URL, wrong repository, unverified deployment and stale head reject all writes", async () => {
  for (const change of [
    { url: "https://evil.example/" },
    { url: "https://pr-12---unmask-web-production.a.run.app" },
    { url: receipt().url + "/path" },
    { url: "https://pr-99---unmask-web-preview-test.a.run.app" },
    { status: "failed" },
    { commit: "bad" },
  ]) {
    const f = fixture();
    await assert.rejects(
      upsertPreviewComment({
        receipt: { ...receipt(), ...change },
        runId: 123,
        api: f.api,
      }),
    );
    assert.equal(
      f.calls.some((call) => call.method),
      false,
    );
  }
  for (const variant of ["stale", "wrong-repo", "closed"]) {
    const f = fixture();
    const api = async (route, options) => {
      const value = await f.api(route, options);
      if (route.endsWith("/pulls/12"))
        return variant === "stale"
          ? { ...value, head: { ...value.head, sha: "b".repeat(40) } }
          : variant === "wrong-repo"
            ? { ...value, base: { ...value.base, repo: { ...repo, id: 7 } } }
            : { ...value, state: "closed" };
      return value;
    };
    await assert.rejects(
      upsertPreviewComment({ receipt: receipt(), runId: 123, api }),
    );
    assert.equal(
      f.calls.some((call) => call.method),
      false,
    );
  }
});

test("comment listing is bounded and a head update during listing prevents publication", async () => {
  const f = fixture();
  const api = async (route, options) => {
    const value = await f.api(route, options);
    if (route.includes("comments?")) f.changeHead();
    return value;
  };
  await assert.rejects(
    upsertPreviewComment({ receipt: receipt(), runId: 123, api }),
  );
  assert.equal(
    f.calls.some((call) => call.method),
    false,
  );
  let pages = 0,
    writes = 0;
  await assert.rejects(
    upsertPreviewComment({
      receipt: receipt(),
      runId: 123,
      api: async (route, options = {}) => {
        if (options.method) writes++;
        if (route.includes("comments?")) {
          pages++;
          return Array.from({ length: 100 }, (_, index) =>
            owned(index + 100, "unrelated"),
          );
        }
        return pull();
      },
    }),
    /pagination/u,
  );
  assert.equal(pages, 5);
  assert.equal(writes, 0);
});

test("uncertain comment POST is never blindly retried and deployment remains independently verified", async () => {
  let writes = 0;
  const f = fixture();
  const api = async (route, options) => {
    if (options?.method) {
      writes++;
      throw Object.assign(new Error("uncertain"), {
        previewWriteUncertain: true,
      });
    }
    return f.api(route, options);
  };
  const verified = receipt();
  const result = await upsertPreviewComment({
    receipt: verified,
    runId: 123,
    api,
  });
  assert.equal(result.status, "uncertain");
  assert.equal(writes, 1);
  assert.equal(verified.status, "verified");
});

test("write API restricts PR comment routes and does not retry a socket-ambiguous POST", async () => {
  let calls = 0;
  const api = githubAPI({
    token: "synthetic",
    fetchImpl: async () => {
      calls++;
      throw Object.assign(new Error("socket"), {
        cause: { code: "ECONNRESET" },
      });
    },
  });
  await assert.rejects(
    api("/repos/Vaiditya2207/unmask/issues/12/comments", {
      method: "POST",
      body: { body: "test" },
    }),
    (error) => error.previewWriteUncertain === true,
  );
  assert.equal(calls, 1);
  for (const route of [
    "/repos/Pranay0083/unmask/issues/12/comments",
    "/repos/Vaiditya2207/unmask/pulls/12",
    "/repos/unknown/unmask/issues/12/comments",
  ])
    await assert.rejects(
      api(route, { method: "POST", body: { body: "test" } }),
    );
  assert.equal(calls, 1);
});

test("only trusted deploy job receives comment write permissions in a separate step", () => {
  const deploy = readFileSync(
    new URL("../../.github/workflows/web-preview-deploy.yml", import.meta.url),
    "utf8",
  );
  const build = readFileSync(
    new URL("../../.github/workflows/web-preview-build.yml", import.meta.url),
    "utf8",
  );
  const cleanup = readFileSync(
    new URL("../../.github/workflows/web-preview-cleanup.yml", import.meta.url),
    "utf8",
  );
  assert.match(deploy, /pull-requests: write/u);
  assert.match(deploy, /id: comment/u);
  assert.match(deploy, /node scripts\/web-preview.mjs comment/u);
  assert.doesNotMatch(build + cleanup, /pull-requests: write/u);
});

test("HTTP comment creation accepts 201 and a repeated identical body is a read-only no-op", async () => {
  let stored;
  const writes = [];
  const api = githubAPI({
    token: "synthetic",
    fetchImpl: async (url, options) => {
      if (url.endsWith("/pulls/12")) return Response.json(pull());
      if (url.includes("/issues/12/comments?"))
        return Response.json(stored ? [stored] : []);
      if (url.endsWith("/issues/comments/7") && options.method === "GET")
        return Response.json(stored);
      writes.push(options);
      stored = owned(7, JSON.parse(options.body).body);
      return Response.json(stored, {
        status: options.method === "POST" ? 201 : 200,
      });
    },
  });
  const first = await upsertPreviewComment({
    receipt: receipt(),
    runId: 123,
    api,
  });
  assert.equal(first.status, "created");
  assert.equal(writes[0].method, "POST");
  assert.equal(writes[0].headers["content-type"], "application/json");
  assert.equal(
    (await upsertPreviewComment({ receipt: receipt(), runId: 123, api }))
      .status,
    "unchanged",
  );
  assert.equal(writes.length, 1);
  assert.equal(
    (await upsertPreviewComment({ receipt: receipt(), runId: 124, api }))
      .status,
    "updated",
  );
  assert.equal(writes[1].method, "PATCH");
});

test("known comment denial and uncertain write responses remain separate from deployment success", async () => {
  for (const variant of ["denied", "server", "malformed-success"]) {
    let writes = 0;
    const api = githubAPI({
      token: "synthetic",
      fetchImpl: async (url, options) => {
        if (url.endsWith("/pulls/12")) return Response.json(pull());
        if (url.includes("comments?")) return Response.json([]);
        writes++;
        return variant === "malformed-success"
          ? new Response("not-json", { status: 201 })
          : new Response("private upstream body", {
              status: variant === "denied" ? 403 : 500,
            });
      },
    });
    const result = await upsertPreviewComment({
      receipt: receipt(),
      runId: 123,
      api,
    });
    assert.equal(result.status, variant === "denied" ? "failed" : "uncertain");
    assert.equal(writes, 1);
    assert.doesNotMatch(JSON.stringify(result), /private upstream body/u);
  }
});

test("a later comment page is searched and ownership changes or duplicate marked comments stop writes", async () => {
  const f = fixture([owned()]);
  let page = 0;
  const api = async (route, options) => {
    if (route.includes("comments?")) {
      page++;
      return page === 1
        ? Array.from({ length: 100 }, (_, id) => owned(id + 100, "unrelated"))
        : [owned()];
    }
    return f.api(route, options);
  };
  assert.equal(
    (await upsertPreviewComment({ receipt: receipt(), runId: 123, api }))
      .status,
    "updated",
  );
  assert.equal(page, 2);
  for (const duplicate of [false, true]) {
    let writes = 0;
    await assert.rejects(
      upsertPreviewComment({
        receipt: receipt(),
        runId: 123,
        api: async (route, options = {}) => {
          if (options.method) writes++;
          if (route.endsWith("/pulls/12")) return pull();
          if (route.includes("comments?"))
            return duplicate ? [owned(), owned(8)] : [owned()];
          return {
            ...owned(),
            user: { login: "another-bot[bot]", type: "Bot" },
          };
        },
      }),
    );
    assert.equal(writes, 0);
  }
});
