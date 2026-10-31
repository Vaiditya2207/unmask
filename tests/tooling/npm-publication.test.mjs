import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { checkPackage } from "../../scripts/check-package.mjs";
import {
  publishNpm,
  verifyNpmReceipt,
} from "../../scripts/npm-publication.mjs";
import { buildFixture } from "./build-fixture.mjs";

function fixture(t, { enabled = true, existing = false, scoped = false } = {}) {
  const f = buildFixture(t, {
    clean: true,
    configure({ root, pkg }) {
      if (scoped) {
        pkg.name = "@fixture/unmask";
        const lockPath = path.join(root, "package-lock.json");
        const lock = JSON.parse(readFileSync(lockPath));
        lock.name = pkg.name;
        lock.packages[""].name = pkg.name;
        writeFileSync(lockPath, JSON.stringify(lock));
      }
      pkg.private = false;
      pkg.publishConfig = {
        registry: "https://registry.npmjs.org/",
        access: "public",
      };
      writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg));
      writeFileSync(
        path.join(root, "release.config.json"),
        JSON.stringify({
          enabled: true,
          npmPublishEnabled: enabled,
          approvedPackageName: pkg.name,
        }),
      );
    },
  });
  f.build();
  const artifact = checkPackage(f.root, path.join(f.root, "output"), {
    expectedSha: f.sha,
    requireClean: true,
  });
  const archive = path.join(f.root, "output", artifact.filename);
  const integrity = `sha512-${createHash("sha512").update(readFileSync(archive)).digest("base64")}`;
  const prepared = { sha: f.sha, version: f.pkg.version, artifact };
  const env = {
    GITHUB_EVENT_NAME: "push",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: f.sha,
    CHECKS_RESULT: "success",
    SMOKE_RESULT: "success",
    NODE_AUTH_TOKEN: "test-only-not-a-credential",
  };
  let published = existing;
  const publishedBytes = readFileSync(archive);
  const calls = [];
  const metadata = {
    name: f.pkg.name,
    version: f.pkg.version,
    dist: {
      integrity,
      tarball: scoped
        ? "https://registry.npmjs.org/@fixture/unmask/-/unmask-1.0.0.tgz"
        : `https://registry.npmjs.org/${f.pkg.name}/-/${f.pkg.name}-${f.pkg.version}.tgz`,
    },
  };
  return {
    ...f,
    prepared,
    archive,
    env,
    integrity,
    calls,
    metadata,
    execute(command, args, options) {
      calls.push({ command, args, options });
      assert.equal(command, "npm");
      assert.equal(args[0], "publish");
      assert.equal(args[1], archive);
      assert.ok(args.includes("--ignore-scripts"));
      assert.ok(args.includes("--access"));
      assert.equal(args[args.indexOf("--access") + 1], "public");
      assert.deepEqual(options.stdio, ["ignore", "ignore", "pipe"]);
      assert.equal(options.maxBuffer, 65536);
      assert.equal(
        args.some((arg) => arg.includes(env.NODE_AUTH_TOKEN)),
        false,
      );
      assert.equal(options.env.NODE_AUTH_TOKEN, env.NODE_AUTH_TOKEN);
      published = true;
    },
    async fetchImpl(url, options) {
      if (new URL(url).pathname.endsWith(".tgz"))
        return new Response(publishedBytes);
      assert.equal(new URL(url).origin, "https://registry.npmjs.org");
      assert.equal(options.redirect, "manual");
      assert.equal(options.headers?.authorization, undefined);
      return published
        ? Response.json(metadata)
        : new Response(null, { status: 404 });
    },
  };
}

async function run(f, extra = {}) {
  return publishNpm(f.root, {
    prepared: f.prepared,
    archive: f.archive,
    env: f.env,
    execute: f.execute,
    fetchImpl: f.fetchImpl,
    pause: async () => {},
    ...extra,
  });
}

test("first publish sends the exact tested tarball and verifies public registry integrity", async (t) => {
  const f = fixture(t);
  const receipt = await run(f);
  assert.equal(f.calls.length, 1);
  assert.equal(receipt.registryPublished, true);
  assert.equal(receipt.commit, f.sha);
  assert.equal(receipt.digest, f.prepared.artifact.digest);
  assert.equal(receipt.integrity, f.integrity);
  assert.equal(JSON.stringify(receipt).includes(f.env.NODE_AUTH_TOKEN), false);
  await verifyNpmReceipt(f.root, {
    prepared: f.prepared,
    archive: f.archive,
    receipt,
    fetchImpl: f.fetchImpl,
  });
});

for (const [label, change] of [
  ["PR event", { GITHUB_EVENT_NAME: "pull_request" }],
  ["branch push", { GITHUB_REF: "refs/heads/feature" }],
  ["failed smoke", { SMOKE_RESULT: "failure" }],
  ["failed checks", { CHECKS_RESULT: "failure" }],
  ["missing token", { NODE_AUTH_TOKEN: "" }],
]) {
  test(`publication refuses ${label} before any provider action`, async (t) => {
    const f = fixture(t);
    Object.assign(f.env, change);
    await assert.rejects(
      run(f, {
        fetchImpl: async () => {
          assert.fail("Provider must not be called");
        },
      }),
      /main|checks|smoke|token|context/i,
    );
    assert.equal(f.calls.length, 0);
  });
}

test("disabled npm configuration does not contact registry or invoke publication", async (t) => {
  const f = fixture(t, { enabled: false });
  await assert.rejects(
    run(f, {
      fetchImpl: async () => {
        assert.fail("Registry must not be called");
      },
    }),
    /disabled|gate/i,
  );
  assert.equal(f.calls.length, 0);
});

test("changed archive bytes fail before registry lookup or publication", async (t) => {
  const f = fixture(t);
  writeFileSync(f.archive, "replaced");
  await assert.rejects(
    run(f, {
      fetchImpl: async () => {
        assert.fail("Registry must not be called");
      },
    }),
    /digest/i,
  );
  assert.equal(f.calls.length, 0);
});

test("an exact existing registry version is verified without publishing it again", async (t) => {
  const f = fixture(t, { existing: true });
  const receipt = await run(f);
  assert.equal(receipt.registryPublished, true);
  assert.equal(f.calls.length, 0);
});

test("an existing version with different bytes is refused before publication", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    run(f, {
      fetchImpl: async () =>
        Response.json({
          ...f.metadata,
          dist: { integrity: "sha512-incorrect" },
        }),
    }),
    /integrity|registry|bytes/i,
  );
  assert.equal(f.calls.length, 0);
});

test("registry readback mismatch cannot produce a publication receipt", async (t) => {
  const f = fixture(t);
  f.metadata.dist.integrity = "sha512-incorrect";
  await assert.rejects(run(f), /integrity|registry|bytes/i);
  assert.equal(f.calls.length, 1);
});

test("provider errors cannot disclose the token or raw diagnostics", async (t) => {
  const f = fixture(t);
  const execute = () => {
    throw new Error(`Raw provider says ${f.env.NODE_AUTH_TOKEN}`);
  };
  await assert.rejects(run(f, { execute }), (error) => {
    assert.match(error.message, /publish|registry/i);
    assert.equal(String(error).includes(f.env.NODE_AUTH_TOKEN), false);
    assert.equal(String(error).includes("Raw provider"), false);
    return true;
  });
});

test("an unverified or altered receipt cannot mark the GitHub manifest as registry-published", async (t) => {
  const f = fixture(t);
  const receipt = await run(f);
  await assert.rejects(
    verifyNpmReceipt(f.root, {
      prepared: f.prepared,
      archive: f.archive,
      receipt: { ...receipt, commit: "f".repeat(40) },
      fetchImpl: f.fetchImpl,
    }),
    /receipt|commit/i,
  );
});

test("registry tarball bytes must match even when metadata claims the expected hash", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    run(f, {
      fetchImpl: async (url, options) =>
        new URL(url).pathname.endsWith(".tgz")
          ? new Response(Buffer.alloc(f.prepared.artifact.size, 42))
          : f.fetchImpl(url, options),
    }),
    /integrity|registry|digest/i,
  );
  assert.equal(f.calls.length, 1);
});

test("registry metadata cannot redirect the artifact read to another origin", async (t) => {
  const f = fixture(t);
  f.metadata.dist.tarball = "https://other.invalid/archive.tgz";
  await assert.rejects(run(f), /registry|integrity|origin/i);
  assert.equal(f.calls.length, 1);
});

test("scoped first publication uses the encoded metadata route and canonical scoped tarball", async (t) => {
  const f = fixture(t, { scoped: true });
  const receipt = await run(f);
  assert.equal(receipt.name, "@fixture/unmask");
  assert.equal(
    receipt.metadataUrl,
    "https://registry.npmjs.org/%40fixture%2Funmask/1.0.0",
  );
  assert.equal(
    receipt.tarballUrl,
    "https://registry.npmjs.org/@fixture/unmask/-/unmask-1.0.0.tgz",
  );
  assert.equal(f.calls.length, 1);
});

for (const code of ["EOTP", "E401", "E403", "ENEEDAUTH", "EPUBLISHCONFLICT"]) {
  test(`npm failure exposes only allowlisted ${code}, never captured secrets`, async (t) => {
    const f = fixture(t);
    await assert.rejects(
      run(f, {
        execute(_command, _args, options) {
          assert.deepEqual(options.stdio, ["ignore", "ignore", "pipe"]);
          assert.equal(options.maxBuffer, 65536);
          throw Object.assign(new Error("SYNTHETIC_SECRET_IN_MESSAGE"), {
            stderr: Buffer.from(
              `npm error code ${code}\nnpm error SYNTHETIC_SECRET_IN_STDERR ${f.env.NODE_AUTH_TOKEN}\n`,
            ),
            stdout: "SYNTHETIC_SECRET_IN_STDOUT",
          });
        },
      }),
      (error) => {
        assert.equal(
          error.message,
          `Npm publish failed (${code}); no exact public registry version verified`,
        );
        assert.doesNotMatch(String(error), /SYNTHETIC_SECRET/);
        assert.equal(String(error).includes(f.env.NODE_AUTH_TOKEN), false);
        assert.equal(error.cause, undefined);
        return true;
      },
    );
  });
}

test("unrecognized npm code and raw output remain undisclosed", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    run(f, {
      execute() {
        throw Object.assign(new Error("SYNTHETIC_SECRET"), {
          stderr:
            "npm ERR! code ESECRET_TOKEN\nnpm ERR! E401 in a raw message SYNTHETIC_SECRET",
        });
      },
    }),
    (error) => {
      assert.equal(
        error.message,
        "Npm publish failed; no exact public registry version verified",
      );
      assert.doesNotMatch(String(error), /ESECRET_TOKEN|E401|SYNTHETIC_SECRET/);
      return true;
    },
  );
});
