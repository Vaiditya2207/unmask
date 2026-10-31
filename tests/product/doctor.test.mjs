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
        get(_target, key) {
          if (key === "UNMASK_SERVER_URL") return undefined;
          throw new Error("Other environment access forbidden");
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

test("doctor sanitizes aborted requests and redirect responses", async (t) => {
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

test("doctor uses an available guard inspector without exposing settings or messages", async (t) => {
  const rt = runtime(await fixture(t));
  rt.configInspector = async (project) => {
    assert.equal(project, rt.cwd);
    return {
      status: "ok",
      settings: { profile: "strict", sensitive: "DO_NOT_PRINT" },
      message: "DO_NOT_PRINT",
    };
  };
  assert.equal(await main(["doctor", "--offline", "--json"], rt), 0);
  const result = JSON.parse(rt.output.join(""));
  assert.equal(result.checks.find((item) => item.id === "config").status, "ok");
  assert.equal(result.node.version, "24.22.2");
  assert.doesNotMatch(rt.output.join(""), /DO_NOT_PRINT/);
});

for (const status of ["invalid", "default"]) {
  test(`doctor maps guard inspector ${status} to actionable diagnostic status`, async (t) => {
    const rt = runtime(await fixture(t));
    rt.configInspector = async () => ({ status, message: "DO_NOT_PRINT" });
    assert.equal(
      await main(["doctor", "--offline", "--json"], rt),
      status === "invalid" ? 1 : 0,
    );
    const result = JSON.parse(rt.output.join(""));
    assert.equal(
      result.checks.find((item) => item.id === "config").status,
      status === "invalid" ? "error" : "warning",
    );
    assert.doesNotMatch(rt.output.join(""), /DO_NOT_PRINT/);
  });
}

test("doctor text output includes observed Node and service versions", async (t) => {
  const rt = runtime(await fixture(t));
  rt.fetchImpl = async () =>
    new Response(
      JSON.stringify({
        version: "0.1.2",
        commit: "a".repeat(40),
        tarballSha256: "b".repeat(64),
      }),
      { headers: { "content-type": "application/json" } },
    );
  assert.equal(await main(["doctor"], rt), 0);
  assert.match(rt.output.join(""), /Node 24\.22\.2/);
  assert.match(rt.output.join(""), /Service 0\.1\.2/);
  assert.match(rt.output.join(""), /type npm/);
});

test("standalone doctor labels recognized fallback config as only partially validated", async (t) => {
  const { writeFile } = await import("node:fs/promises");
  const rt = runtime(await fixture(t));
  rt.configInspector = null;
  await writeFile(
    path.join(rt.cwd, ".unmask.json"),
    '{"schemaVersion":1,"profile":"strict"}',
  );
  assert.equal(await main(["doctor", "--offline", "--json"], rt), 0);
  assert.equal(
    JSON.parse(rt.output.join("")).checks.find((item) => item.id === "config")
      .status,
    "unknown",
  );
});

test("doctor uses only the authorized service environment key unless a flag overrides it", async (t) => {
  const rt = runtime(await fixture(t));
  const reads = [],
    urls = [];
  rt.env = new Proxy(
    {},
    {
      get(_target, key) {
        reads.push(key);
        assert.equal(key, "UNMASK_SERVER_URL");
        return "https://configured.example";
      },
      ownKeys() {
        assert.fail("Environment enumeration forbidden");
      },
    },
  );
  rt.fetchImpl = async (url) => {
    urls.push(url);
    return Response.json({
      version: "0.1.2",
      commit: "a".repeat(40),
      tarballSha256: "b".repeat(64),
    });
  };
  assert.equal(await main(["doctor", "--json"], rt), 0);
  assert.deepEqual(reads, ["UNMASK_SERVER_URL"]);
  assert.deepEqual(urls, ["https://configured.example/version"]);
  assert.equal(
    JSON.parse(rt.output.join("")).service.origin,
    "https://configured.example",
  );
  reads.length = 0;
  rt.output.length = 0;
  assert.equal(
    await main(
      ["doctor", "--server-url", "https://explicit.example", "--json"],
      rt,
    ),
    0,
  );
  assert.deepEqual(reads, []);
  assert.equal(
    JSON.parse(rt.output.join("")).service.origin,
    "https://explicit.example",
  );
});

test("normal CLI doctor diagnoses the environment origin used by check", async (t) => {
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { once } = await import("node:events");
  const requests = [];
  const origin = await serve(t, (req, res) => {
    requests.push(req.url);
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        version: "0.1.2",
        commit: "a".repeat(40),
        tarballSha256: "b".repeat(64),
      }),
    );
  });
  const cwd = await fixture(t);
  const { writeFile } = await import("node:fs/promises");
  const guard = path.join(cwd, "network-guard.mjs");
  await writeFile(
    guard,
    `const fetch = globalThis.fetch; globalThis.fetch = (input, options) => { const url = new URL(input); if(url.hostname !== '127.0.0.1') throw new Error('Nonloopback network forbidden'); return fetch(input, options); };`,
  );
  const child = spawn(
    process.execPath,
    [
      "--import",
      guard,
      fileURLToPath(new URL("../../src/cli/main.mjs", import.meta.url)),
      "doctor",
      "--json",
    ],
    {
      cwd,
      env: { UNMASK_SERVER_URL: origin },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  t.after(() => child.kill());
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  assert.equal((await once(child, "close"))[0], 0, stderr);
  assert.deepEqual(requests, ["/version"]);
  assert.equal(JSON.parse(stdout).service.origin, origin);
});

test("doctor missing project fails instead of appearing to use defaults", async (t) => {
  const rt = runtime(await fixture(t));
  rt.configInspector = null;
  assert.equal(
    await main(
      [
        "doctor",
        "--project",
        path.join(rt.cwd, "missing"),
        "--offline",
        "--json",
      ],
      rt,
    ),
    1,
  );
  assert.equal(
    JSON.parse(rt.output.join("")).checks.find((item) => item.id === "config")
      .status,
    "error",
  );
});

test("doctor warns for a different valid Node version than the exact package engine pin", async (t) => {
  const rt = runtime(await fixture(t));
  rt.nodeVersion = "v25.0.0";
  assert.equal(await main(["doctor", "--offline", "--json"], rt), 0);
  assert.equal(
    JSON.parse(rt.output.join("")).checks.find((item) => item.id === "node")
      .status,
    "warning",
  );
});

test("doctor rejects credential or query-bearing environment origins without displaying values", async (t) => {
  for (const origin of [
    "https://user:DO_NOT_PRINT@example.com",
    "https://example.com?token=DO_NOT_PRINT",
  ]) {
    const rt = runtime(await fixture(t));
    rt.env = { UNMASK_SERVER_URL: origin };
    rt.fetchImpl = () => assert.fail("Invalid origin must not be contacted");
    assert.equal(await main(["doctor", "--json"], rt), 2);
    assert.doesNotMatch(rt.output.join(""), /DO_NOT_PRINT/);
  }
});
