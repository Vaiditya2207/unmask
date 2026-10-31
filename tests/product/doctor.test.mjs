import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { main } from "../../src/cli/main.mjs";

async function fixture(t) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "unmask-doctor-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}
function runtime(cwd) {
  const output = [];
  return {
    cwd,
    nodeVersion: "v24.22.2",
    stdout: { write: (text) => output.push(text) },
    output,
    env: new Proxy(
      {},
      {
        get() {
          throw new Error("Environment access forbidden");
        },
      },
    ),
  };
}
async function serve(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test("doctor command checks real service version without reading environment", async (t) => {
  const paths = [];
  const url = await serve(t, (req, res) => {
    paths.push(req.url);
    assert.equal(req.headers.authorization, undefined);
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        req.url === "/healthz"
          ? { status: "ok" }
          : {
              version: "0.1.2",
              commit: "a".repeat(40),
              tarballSha256: "b".repeat(64),
            },
      ),
    );
  });
  const rt = runtime(await fixture(t));
  assert.equal(await main(["doctor", "--server-url", url, "--json"], rt), 0);
  const result = JSON.parse(rt.output.join(""));
  assert.deepEqual(paths, ["/version"]);
  assert.equal(
    result.checks.find((item) => item.id === "service").status,
    "ok",
  );
  assert.equal(result.service.version, "0.1.2");
  assert.equal(
    result.checks.find((item) => item.id === "guard").status,
    "unknown",
  );
  assert.match(result.limitations.join(" "), /shell|guard/);
});

test("doctor offline avoids requests and diagnoses unsupported Node", async (t) => {
  const rt = runtime(await fixture(t));
  rt.nodeVersion = "v20.1.0";
  rt.fetchImpl = () => {
    throw new Error("Network forbidden");
  };
  assert.equal(await main(["doctor", "--offline", "--json"], rt), 1);
  const result = JSON.parse(rt.output.join(""));
  assert.equal(
    result.checks.find((item) => item.id === "node").status,
    "error",
  );
  assert.equal(
    result.checks.find((item) => item.id === "service").status,
    "skipped",
  );
});

test("doctor rejects credential URLs before fetch and never prints them", async (t) => {
  const rt = runtime(await fixture(t));
  rt.fetchImpl = () => {
    throw new Error("Network forbidden");
  };
  const code = await main(
    [
      "doctor",
      "--server-url",
      "https://user:DO_NOT_PRINT@example.com",
      "--json",
    ],
    rt,
  );
  assert.equal(code, 2);
  assert.doesNotMatch(rt.output.join(""), /DO_NOT_PRINT/);
});

test("doctor bounds response bodies and sanitizes unavailable services", async (t) => {
  const url = await serve(t, (_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({ status: "ok", leak: "DO_NOT_PRINT".repeat(2000) }),
    );
  });
  const rt = runtime(await fixture(t));
  assert.equal(await main(["doctor", "--server-url", url, "--json"], rt), 1);
  assert.doesNotMatch(rt.output.join(""), /DO_NOT_PRINT/);
  assert.equal(
    JSON.parse(rt.output.join("")).checks.find((item) => item.id === "service")
      .status,
    "error",
  );
});

test("doctor diagnoses malformed project config without exposing its content", async (t) => {
  const { writeFile } = await import("node:fs/promises");
  const rt = runtime(await fixture(t));
  await writeFile(
    path.join(rt.cwd, ".unmask.json"),
    '{"profile":"SYNTHETIC_PRIVATE_VALUE"}',
  );
  assert.equal(await main(["doctor", "--offline", "--json"], rt), 1);
  const result = JSON.parse(rt.output.join(""));
  assert.equal(
    result.checks.find((item) => item.id === "config").status,
    "error",
  );
  assert.doesNotMatch(rt.output.join(""), /SYNTHETIC_PRIVATE_VALUE/);
});

test("doctor refuses linked config without reading its target", async (t) => {
  const { writeFile, symlink } = await import("node:fs/promises");
  const rt = runtime(await fixture(t));
  const secret = path.join(rt.cwd, "private.json");
  await writeFile(secret, '{"profile":"strict","private":"DO_NOT_PRINT"}');
  await symlink(secret, path.join(rt.cwd, ".unmask.json"));
  assert.equal(await main(["doctor", "--offline", "--json"], rt), 1);
  assert.equal(
    JSON.parse(rt.output.join("")).checks.find((item) => item.id === "config")
      .status,
    "error",
  );
  assert.doesNotMatch(rt.output.join(""), /DO_NOT_PRINT/);
});

test("doctor aborts an unresponsive service and sanitizes redirect responses", async (t) => {
  for (const fetchImpl of [
    async (_url, { signal }) => {
      assert.ok(signal);
      throw Object.assign(new Error("DO_NOT_PRINT"), { name: "AbortError" });
    },
    async () =>
      new Response("", {
        status: 302,
        headers: { location: "https://user:DO_NOT_PRINT@example.com" },
      }),
  ]) {
    const rt = runtime(await fixture(t));
    rt.fetchImpl = fetchImpl;
    assert.equal(await main(["doctor", "--json"], rt), 1);
    assert.doesNotMatch(rt.output.join(""), /DO_NOT_PRINT/);
  }
});
