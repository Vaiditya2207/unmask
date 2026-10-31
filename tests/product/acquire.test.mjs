import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  parsePackageSpec,
  fetchBlob,
  getRegistryRelease,
} from "../../src/core/acquire.mjs";
const sha = "a".repeat(40);
const registryUrl = "https://registry.npmjs.org/chalk/5.6.2";
const response = (chunks, headers = {}, status = 200) =>
  new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(Buffer.from(chunk));
        controller.close();
      },
    }),
    { status, headers },
  );
function recordedFetch(body, inspect = () => {}) {
  return async (url, options) => {
    inspect(url, options);
    return response([body]);
  };
}
test("parses only exact scoped and unscoped release specifications", () => {
  assert.deepEqual(parsePackageSpec("chalk@5.6.2"), {
    name: "chalk",
    version: "5.6.2",
  });
  assert.deepEqual(parsePackageSpec("@scope/name@1.0.0-beta.1+build.4"), {
    name: "@scope/name",
    version: "1.0.0-beta.1+build.4",
  });
  for (const spec of [
    "chalk",
    "chalk@latest",
    "chalk@^5.0.0",
    "chalk@5",
    "chalk@01.0.0",
    "chalk@1.0.0-01",
    "chalk@1.0.0 ",
    "http://x@1.0.0",
    "@scope/name@1.0.0/../",
    "chalk@*",
    "../x@1.0.0",
    "x%2fy@1.0.0",
    "x@y@1.0.0",
  ])
    assert.throws(() => parsePackageSpec(spec), {
      code: "invalid-package-spec",
    });
});
test("recorded bytes bind hashes and acquisition options without credentials", async () => {
  const result = await fetchBlob(registryUrl, {
    fetchImpl: recordedFetch("abc", (url, options) => {
      assert.equal(url, registryUrl);
      assert.equal(options.redirect, "error");
      assert.equal(options.credentials, "omit");
      assert.equal(options.headers.authorization, undefined);
      assert.equal(options.headers.accept, "*/*");
      assert.equal(options.headers["accept-encoding"], "identity");
    }),
  });
  assert.equal(result.bytes.toString(), "abc");
  assert.equal(
    result.digest.sha256,
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.equal(
    result.digest.sha512,
    createHash("sha512").update("abc").digest("hex"),
  );
  assert.equal(result.observation.url, registryUrl);
  assert.equal(result.observation.bytes, 3);
  assert.equal(result.observation.status, 200);
});
test("rejects malicious URLs before invoking transport", async () => {
  let calls = 0;
  for (const url of [
    "http://registry.npmjs.org/chalk",
    "https://registry.npmjs.org.evil/x",
    "https://registry.npmjs.org:443/x",
    "https://user@registry.npmjs.org/x",
    "https://registry.npmjs.org./x",
    "https://127.0.0.1/x",
    "https://[::1]/x",
    "https://169.254.169.254/x",
    "https://github.com/a/b",
    "https://registry.npmjs.org/x?token=secret",
    "https://registry.npmjs.org/x#fragment",
    "https://registry.npmjs.org/a/../x",
    "https://registry.npmjs.org/%2e%2e/x",
    "https://registry.npmjs.org\\@evil.test/x",
    "https://codeload.github.com/a/b/tar.gz/main",
    "https://codeload.github.com/a%2fb/c/tar.gz/" + sha,
  ]) {
    await assert.rejects(
      fetchBlob(url, {
        fetchImpl: async () => {
          calls++;
          return response(["x"]);
        },
      }),
      { code: "unapproved-url" },
    );
  }
  assert.equal(calls, 0);
});
test("rejects redirects, already-followed responses, HTTP failures and partial responses", async () => {
  for (const status of [301, 302, 307, 308, 404, 429, 500, 206])
    await assert.rejects(
      fetchBlob(registryUrl, {
        fetchImpl: async () => response([], {}, status),
      }),
      (e) => ["redirect-refused", "http-status"].includes(e.code),
    );
  const followed = response(["x"]);
  Object.defineProperty(followed, "redirected", { value: true });
  await assert.rejects(
    fetchBlob(registryUrl, { fetchImpl: async () => followed }),
    { code: "redirect-refused" },
  );
});
test("prechecks content length and enforces streamed bytes even when length is false", async () => {
  let reads = 0;
  const large = new Response(
    new ReadableStream({
      pull(controller) {
        reads++;
        controller.enqueue(Buffer.from("x"));
      },
    }),
    { headers: { "content-length": "100" } },
  );
  await assert.rejects(
    fetchBlob(registryUrl, { maxBytes: 3, fetchImpl: async () => large }),
    { code: "response-cap" },
  );
  assert.ok(reads <= 1);
  for (const headers of [{}, { "content-length": "1" }])
    await assert.rejects(
      fetchBlob(registryUrl, {
        maxBytes: 3,
        fetchImpl: async () => response(["ab", "cd"], headers),
      }),
      { code: "response-cap" },
    );
  for (const length of ["-1", "abc", "9007199254740992"])
    await assert.rejects(
      fetchBlob(registryUrl, {
        fetchImpl: async () => response([], { "content-length": length }),
      }),
      { code: "invalid-response" },
    );
});
test("external abort and deadline bound fetch and body waits", async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  await assert.rejects(
    fetchBlob(registryUrl, {
      signal: controller.signal,
      fetchImpl: async () => {
        called = true;
      },
    }),
    { code: "acquisition-aborted" },
  );
  assert.equal(called, false);
  await assert.rejects(
    fetchBlob(registryUrl, {
      timeoutMs: 5,
      fetchImpl: () => new Promise(() => {}),
    }),
    { code: "acquisition-timeout" },
  );
  const waiting = new Response(new ReadableStream({ start() {} }));
  await assert.rejects(
    fetchBlob(registryUrl, { timeoutMs: 5, fetchImpl: async () => waiting }),
    { code: "acquisition-timeout" },
  );
});
test("registry release preserves exact metadata bytes and fixed release URL", async () => {
  const body = JSON.stringify({
    name: "@scope/name",
    version: "1.2.3",
    repository: {
      type: "git",
      url: "git+https://github.com/Owner/Repo.git",
      directory: "packages/a",
    },
    gitHead: sha,
    dist: {
      tarball: "https://registry.npmjs.org/@scope/name/-/name-1.2.3.tgz",
      integrity: "sha512-AAAA",
    },
  });
  const result = await getRegistryRelease("@scope/name@1.2.3", {
    fetchImpl: recordedFetch(body, (url) =>
      assert.equal(url, "https://registry.npmjs.org/%40scope%2Fname/1.2.3"),
    ),
  });
  assert.equal(result.metadataBytes.toString(), body);
  assert.equal(
    result.metadataDigest.sha256,
    createHash("sha256").update(body).digest("hex"),
  );
  assert.equal(result.expectedIntegrity, "sha512-AAAA");
  assert.equal(result.sourceCandidate.commit, sha);
  assert.equal(result.sourceCandidate.directory, "packages/a");
});
test("registry identity mismatch, unsafe tarball and metadata cap refuse acquisition", async () => {
  for (const body of [
    JSON.stringify({ name: "other", version: "5.6.2" }),
    JSON.stringify({
      name: "chalk",
      version: "5.6.2",
      dist: { tarball: "https://evil.test/a" },
    }),
    "not json",
    "[]",
    " ".repeat(1048577),
  ]) {
    await assert.rejects(
      getRegistryRelease("chalk@5.6.2", { fetchImpl: recordedFetch(body) }),
      (e) =>
        [
          "registry-identity-mismatch",
          "unapproved-url",
          "invalid-registry-document",
          "response-cap",
        ].includes(e.code),
    );
  }
});
test("midstream external cancellation stops bounded acquisition", async () => {
  const abort = new AbortController();
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from("abc"));
    },
    cancel() {
      cancelled = true;
    },
  });
  const pending = fetchBlob(registryUrl, {
    signal: abort.signal,
    fetchImpl: async () => new Response(body),
  });
  setTimeout(() => abort.abort(), 5);
  await assert.rejects(pending, { code: "acquisition-aborted" });
  assert.equal(cancelled, true);
});
test("zero deadline and transport failures are coded without leaking transport text", async () => {
  let calls = 0;
  await assert.rejects(
    fetchBlob(registryUrl, {
      timeoutMs: 0,
      fetchImpl: async () => {
        calls++;
      },
    }),
    { code: "acquisition-timeout" },
  );
  assert.equal(calls, 0);
  await assert.rejects(
    fetchBlob(registryUrl, {
      fetchImpl: async () => {
        throw new Error("private transport text");
      },
    }),
    (error) =>
      error.code === "network-failure" && !error.message.includes("private"),
  );
});
test("streamed collection preserves order across thousands of small chunks", async () => {
  const chunks = Array.from({ length: 2000 }, (_, n) => Buffer.from([n % 251]));
  const result = await fetchBlob(registryUrl, {
    maxBytes: 2000,
    fetchImpl: async () => response(chunks),
  });
  assert.deepEqual(result.bytes, Buffer.concat(chunks));
});
test("invalid live-shaped metadata retains observed status and exact input digest", async () => {
  await assert.rejects(
    getRegistryRelease("chalk@5.6.2", {
      fetchImpl: recordedFetch("[object Object]"),
    }),
    (error) => {
      assert.equal(error.code, "invalid-registry-document");
      assert.equal(error.observation.status, 200);
      assert.equal(error.observation.bytes, 15);
      assert.equal(
        error.metadataDigest.sha256,
        "b28c94b2195c8ed259f0b415aaee3f39b0b2920a4537611499fa044956917a21",
      );
      return true;
    },
  );
});
test("registry shasum is a claim-only fallback and missing digests stay unavailable", async () => {
  for (const [dist, expectedIntegrity] of [
    [{ shasum: "00".repeat(20) }, "sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA="],
    [{}, null],
  ]) {
    const body = JSON.stringify({
      name: "chalk",
      version: "5.6.2",
      dist: {
        ...dist,
        tarball: "https://registry.npmjs.org/chalk/-/chalk-5.6.2.tgz",
      },
    });
    const result = await getRegistryRelease(
      { name: "chalk", version: "5.6.2" },
      { fetchImpl: recordedFetch(body) },
    );
    assert.equal(result.expectedIntegrity, expectedIntegrity);
    assert.equal(result.sourceCandidate, null);
  }
});
test("codeload acquisition uses only fixed canonical full-SHA endpoint", async () => {
  const url = `https://codeload.github.com/owner/repo/tar.gz/${sha}`;
  const result = await fetchBlob(url, {
    fetchImpl: recordedFetch("archive", (fetched) =>
      assert.equal(fetched, url),
    ),
  });
  assert.equal(result.bytes.toString(), "archive");
});
