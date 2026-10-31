import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  renderHome,
  renderStatus,
  renderError,
  renderCompleted,
} from "../../src/viewer/shell.mjs";

test("home is a registry-only accessible evidence workspace", () => {
  const html = renderHome();
  assert.match(html, /action="\/check" method="post"/);
  assert.match(html, /for="package"/);
  assert.match(html, /name="package"/);
  assert.match(html, /exact version/);
  assert.match(html, /never declares a package safe/);
  assert.match(html, /restart/);
  assert.doesNotMatch(html, /type="file"|(?:src|action)="https?:\/\//);
  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  assert.ok(html.includes(createHash("sha256").update(css).digest("base64")));
  assert.match(css, /focus-visible/);
  assert.match(css, /@media/);
});

test("every shell state escapes target content and gives a next step", () => {
  const attack = '\"><img src=x onerror=alert(1)><script>bad</script>';
  for (const html of [
    renderHome({ value: attack, error: attack }),
    renderStatus({
      id: "a".repeat(32),
      nameAtExactVersion: attack,
      status: "incomplete",
      reason: attack,
      createdAt: 0,
    }),
    renderError({ title: attack, message: attack }),
  ]) {
    assert.doesNotMatch(html, /<img|<script>/);
    assert.match(html, /&lt;img/);
    assert.match(html, /never declares a package safe/);
  }
  for (const status of ["queued", "running", "incomplete", "failed"]) {
    const html = renderStatus({
      id: "a".repeat(32),
      nameAtExactVersion: "example@1.0.0",
      status,
      createdAt: 0,
    });
    assert.match(html, new RegExp(status, "i"));
    assert.match(html, /href="\/"/);
    assert.equal(
      html.includes('http-equiv="refresh"'),
      ["queued", "running"].includes(status),
    );
  }
});

test("every standalone screen permits only its exact style asset and has no scripts or remote assets", () => {
  for (const html of [
    renderHome(),
    renderHome({ error: "Invalid package" }),
    renderError(),
    ...["queued", "running", "incomplete", "failed"].map((status) =>
      renderStatus({
        id: "a".repeat(32),
        nameAtExactVersion: "example@1.0.0",
        status,
        createdAt: 0,
      }),
    ),
  ]) {
    const style = html.match(/<style>([\s\S]*?)<\/style>/)[1];
    const digest = createHash("sha256").update(style).digest("base64");
    assert.ok(html.includes(`style-src &#39;sha256-${digest}&#39;`));
    assert.match(html, /default-src &#39;none&#39;/);
    assert.match(html, /base-uri &#39;none&#39;/);
    assert.match(html, /form-action &#39;self&#39;/);
    assert.doesNotMatch(
      html,
      /<script|(?:src|action)="https?:|<link\b[^>]*href="https?:/,
    );
    assert.deepEqual(
      [...html.matchAll(/href="(https?:[^"]+)"/g)].map((match) => match[1]),
      ["https://github.com/Vaiditya2207/unmask"],
    );
  }
});

test("form validation errors are associated with the labelled input and preserve escaped text", () => {
  const html = renderHome({
    value: '"><img src=x>',
    error: "Invalid <package> & version",
    retryAfter: 30,
  });
  assert.match(html, /value="&quot;&gt;&lt;img src=x&gt;"/);
  assert.match(html, /id="input-error"/);
  assert.match(html, /role="alert"/);
  assert.match(html, /aria-describedby="package-hint input-error"/);
  assert.match(html, /aria-invalid="true"/);
  assert.match(html, /Invalid &lt;package&gt; &amp; version/);
  assert.match(html, /Try again in 30 seconds/);
  assert.match(html, /required maxlength="300"/);
  assert.doesNotMatch(html, /<img/);
});

test("standalone screens expose language, viewport and a working skip target", () => {
  for (const html of [
    renderHome(),
    renderError(),
    renderStatus({
      id: "b".repeat(32),
      nameAtExactVersion: "example@1.0.0",
      status: "queued",
      createdAt: 0,
    }),
  ]) {
    assert.match(html, /<html lang="en">/);
    assert.match(
      html,
      /name="viewport" content="width=device-width,initial-scale=1"/,
    );
    assert.match(html, /href="#content">Skip to content/);
    assert.match(html, /<main id="content">/);
    assert.match(html, /prefers-reduced-motion/);
  }
});

test("only active statuses refresh and terminal statuses provide deliberate retry guidance", () => {
  for (const status of ["queued", "running", "incomplete", "failed"]) {
    const html = renderStatus({
      id: "c".repeat(32),
      nameAtExactVersion: "example@1.0.0",
      status,
      reason: "fixture-reason",
      createdAt: 0,
    });
    assert.match(html, /role="status"/);
    assert.match(html, /1970-01-01T00:00:00.000Z/);
    assert.match(html, /href="\/r\/cccccccccccccccccccccccccccccccc.json"/);
    assert.equal(
      html.includes('http-equiv="refresh" content="3"'),
      ["queued", "running"].includes(status),
    );
    if (["incomplete", "failed"].includes(status))
      assert.match(html, /Return to the form to request a new check/);
  }
  const unknown = renderStatus({
    id: "d".repeat(32),
    status: "unrecognized",
    createdAt: 0,
  });
  assert.match(unknown, />Failed<\/p>/);
  assert.doesNotMatch(unknown, /http-equiv="refresh"/);
});

test("completed action chrome preserves trusted report HTML and escapes supplied job metadata", () => {
  const input =
    "<!doctype html><html><head><title>Trusted fixture</title></head><body><header>Fixture only</header><main>Report integration pending</main></body></html>";
  const job = Object.freeze({ id: '"><img src=x>', finishedAt: 0 });
  const html = renderCompleted(input, job);
  assert.ok(html.startsWith("<!doctype html>"));
  assert.match(html, /<main>Report integration pending<\/main>/);
  assert.match(html, /aria-label="Report actions"/);
  assert.match(html, /download="unmask-report.json"/);
  assert.match(html, /href="\/r\/&quot;&gt;&lt;img src=x&gt;.json"/);
  assert.match(html, /1970-01-01T00:00:00.000Z/);
  assert.match(html, /up to 30 minutes after completion/);
  assert.doesNotMatch(html, /<img/);
  assert.equal(job.id, '"><img src=x>');
});

test("headerless report documents receive escaped actions before the closing body without changing CSP", () => {
  const css = "body{color:#13294b}";
  const hash = createHash("sha256").update(css).digest("base64");
  const head = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Trusted fixture</title><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'sha256-${hash}'"><style>${css}</style></head>`;
  for (const closingBody of ["</body>", "</BODY >"]) {
    const input = `${head}<body><main>Headerless fixture only</main>${closingBody}</html>`;
    const html = renderCompleted(input, {
      id: '\"><img src=x>',
      finishedAt: 0,
    });
    assert.equal(html.slice(0, head.length), head);
    assert.equal([...html.matchAll(/aria-label="Report actions"/g)].length, 1);
    assert.ok(html.indexOf("<nav") > html.indexOf("</main>"));
    assert.ok(html.indexOf("</nav>") < html.indexOf(closingBody));
    assert.match(html, /href="\/r\/&quot;&gt;&lt;img src=x&gt;.json"/);
    assert.match(html, /1970-01-01T00:00:00.000Z/);
    assert.doesNotMatch(html, /<img|<script/);
    assert.equal(
      html.replace(/<nav class="summary"[\s\S]*?<\/nav>/, ""),
      input,
    );
  }
});

test("trusted fragments without header or body markers receive actions at their end", () => {
  for (const input of ["<main>Trusted fragment fixture</main>", ""]) {
    const html = renderCompleted(input, { id: "e".repeat(32), finishedAt: 0 });
    assert.ok(html.startsWith(input + '<nav class="summary"'));
    assert.match(html, /download="unmask-report.json"/);
    assert.equal([...html.matchAll(/aria-label="Report actions"/g)].length, 1);
    assert.ok(html.endsWith("</nav>"));
  }
});

test("completed actions keep their existing placement after the first report header", () => {
  const input =
    "<!doctype html><html><head><title>Fixture</title></head><body><header>First</header><main>Fixture</main><header>Second</header></body></html>";
  const html = renderCompleted(input, { id: "f".repeat(32), finishedAt: 0 });
  assert.match(html, /<header>First<\/header><nav class="summary"/);
  assert.ok(html.indexOf("</nav>") < html.indexOf("<main>"));
  assert.equal([...html.matchAll(/aria-label="Report actions"/g)].length, 1);
  assert.equal(html.replace(/<nav class="summary"[\s\S]*?<\/nav>/, ""), input);
});
