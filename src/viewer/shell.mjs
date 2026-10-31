import { createHash } from "node:crypto";

const css = `
:root{font-family:"Avenir Next","Segoe UI",sans-serif;color:#13294b;background:#edf4fa;font-size:16px;line-height:1.6;color-scheme:light}*{box-sizing:border-box}body{margin:0}a{color:#156b85;text-underline-offset:3px}a:focus-visible,input:focus-visible,button:focus-visible{outline:3px solid #a65a12;outline-offset:4px}.skip{position:absolute;left:16px;top:-100px;background:white;padding:10px}.skip:focus{top:10px}header{background:#13294b;color:white;padding:24px max(5vw,24px);display:flex;align-items:baseline;justify-content:space-between;gap:24px}header a{color:inherit;text-decoration:none;font-size:24px;font-weight:750;letter-spacing:-1px}header p{margin:0;font-size:14px}main{max-width:1220px;margin:auto;padding:64px max(5vw,24px);display:grid;grid-template-columns:220px minmax(0,1fr);gap:48px}aside{border-top:3px solid #156b85;padding-top:20px;font-size:14px}aside p{margin:0 0 18px}aside strong{font-weight:650}h1{font-size:clamp(32px,4vw,52px);font-weight:600;line-height:1.13;letter-spacing:-1.5px;margin:0 0 24px;max-width:18ch}h2{font-size:19px;font-weight:650;line-height:1.3;margin:0 0 12px}p{max-width:64ch}form{background:#fff;padding:28px;margin:32px 0 26px;border-radius:12px;border:1px solid #cfdfeb}label{display:block;font-weight:650;margin-bottom:10px}.entry{display:flex;gap:12px;align-items:stretch}input{font:inherit;min-width:0;flex:1;border:1px solid #7895ad;background:white;padding:13px 14px;color:inherit;border-radius:6px}button{font:inherit;font-weight:650;cursor:pointer;color:white;background:#156b85;border:1px solid #156b85;border-radius:6px;padding:13px 22px}button:hover{background:#10576d}.hint{font-size:14px;color:#405876;margin:10px 0 0}.error{color:#854300;background:#fff0da;border-left:4px solid #a65a12;padding:14px 18px;overflow-wrap:anywhere}.ledger{background:white;border-top:3px solid #156b85;border-radius:0 0 8px 8px;margin-top:32px;padding:0 24px}.row{display:grid;grid-template-columns:160px minmax(0,1fr);gap:24px;border-bottom:1px solid #dce6ed;padding:18px 0}.row:last-child{border-bottom:0}.row strong{font-weight:650}.row span{font-size:14px;color:#405876}.status{display:inline-block;padding:5px 14px;background:#dceaf3;color:#13294b;border-radius:5px;font-weight:650}.status.incomplete,.status.failed{background:#fff0da;color:#854300}.identity{font-size:21px;overflow-wrap:anywhere}.meta{font-size:14px;color:#405876}time,code{overflow-wrap:anywhere}code{font-family:Menlo,monospace;font-size:.9em}footer{max-width:1220px;margin:auto;padding:0 max(5vw,24px) 32px;font-size:13px;color:#405876}footer p{max-width:95ch}.links{display:flex;flex-wrap:wrap;gap:24px;margin-top:24px}@media(max-width:760px){header{align-items:flex-start;flex-direction:column;gap:4px}main{grid-template-columns:1fr;gap:24px;padding-top:32px}aside{display:flex;gap:24px}aside p{flex:1}.entry{flex-direction:column}form{padding:20px}h1{max-width:22ch}.row{grid-template-columns:1fr;gap:4px}.ledger{padding:0 18px}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto}}
`;
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        ch
      ],
  );
function layout(title, body, { refresh = false } = {}) {
  const hash = createHash("sha256").update(css).digest("base64");
  const csp = `default-src 'none'; style-src 'sha256-${hash}'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex"><meta http-equiv="Content-Security-Policy" content="${escape(csp)}">${refresh ? '<meta http-equiv="refresh" content="3">' : ""}<title>UNMASK · ${escape(title)}</title><style>${css}</style></head><body><a class="skip" href="#content">Skip to content</a><header><a href="/" aria-label="UNMASK home">UNMASK</a><p>Published bytes. Source claims. Evidence to review.</p></header><main id="content"><aside><p><strong>Release evidence</strong><br>Inspect a published package before accepting an update.</p><p>Matching source bytes do not establish benign behavior.</p></aside><div>${body}</div></main><footer><p>UNMASK shows evidence for review and never declares a package safe.</p><p>Reports are temporary: stored for up to 24 hours, subject to capacity eviction. A restart loses them. Save the JSON report to keep the evidence.</p></footer></body></html>`;
}
export function renderHome({ value = "", error = "", retryAfter } = {}) {
  return layout(
    "Check a release",
    `<h1>What shipped beyond the source?</h1><p>Check an exact npm release. Review published files, source correspondence and the evidence behind each finding.</p>${error ? `<p class="error" role="alert" id="input-error">${escape(error)}${retryAfter ? ` Try again in ${escape(retryAfter)} seconds.` : ""}</p>` : ""}<form action="/check" method="post"><label for="package">Package name and exact version</label><div class="entry"><input id="package" name="package" value="${escape(value)}" placeholder="@scope/package@1.2.3" required maxlength="300" autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="package-hint${error ? " input-error" : ""}"${error ? ' aria-invalid="true"' : ""}><button type="submit">Check release</button></div><p class="hint" id="package-hint">Use an exact version, such as chalk@6.0.1. Tags, version ranges, URLs and uploads are not accepted.</p></form><p class="hint">Checks share a global limit of six new analyses per ten minutes. Existing reports and identical checks reuse the same work.</p><div class="ledger" aria-label="What the report contains"><div class="row"><strong>Release identity</strong><span>Original artifact digests and the source claim selected for comparison.</span></div><div class="row"><strong>File correspondence</strong><span>Changed, artifact-only, byte-identical and not-compared files, with byte counts and inspection limits.</span></div><div class="row"><strong>Review evidence</strong><span>Deterministic findings first. Model explanations, when available, remain separate hypotheses.</span></div></div>`,
  );
}
export function renderStatus(job) {
  const messages = {
    queued:
      "Your check is waiting for the active analysis to finish. This page refreshes automatically.",
    running:
      "The release is being inspected. This page refreshes automatically; reloading does not start another check.",
    incomplete:
      "The check could not finish within its limits. No automatic retry will run. Return to the form to request a new check.",
    failed:
      "The analysis could not produce a report. Return to the form to request a new check.",
  };
  const status = ["queued", "running", "incomplete", "failed"].includes(
    job.status,
  )
    ? job.status
    : "failed";
  const time = Number.isFinite(job.createdAt)
    ? new Date(job.createdAt).toISOString()
    : "";
  return layout(
    `${status} check`,
    `<h1>Release check</h1><p class="identity">${escape(job.nameAtExactVersion)}</p><p class="status ${status}" role="status">${status[0].toUpperCase() + status.slice(1)}</p><p>${messages[status]}</p>${job.reason ? `<p class="meta">Reason: <code>${escape(job.reason)}</code></p>` : ""}<p class="meta">Requested <time datetime="${time}">${time}</time></p><div class="links"><a href="/">Check another release</a><a href="/r/${escape(job.id)}.json">View job JSON</a></div>`,
    { refresh: ["queued", "running"].includes(status) },
  );
}
export function renderError({
  title = "Request unavailable",
  message = "Return to the form and try again.",
} = {}) {
  return layout(
    title,
    `<h1>${escape(title)}</h1><p class="error" role="alert">${escape(message)}</p><a href="/">Return to the release form</a>`,
  );
}
export function renderCompleted(reportHtml, job) {
  const time = new Date(job.finishedAt).toISOString();
  return reportHtml.replace(
    "</header>",
    `</header><nav class="summary" aria-label="Report actions"><a href="/">Check another release</a> | <a href="/r/${escape(job.id)}.json" download="unmask-report.json">Download report JSON</a><p>Cached analysis: <time datetime="${time}">${time}</time>. Repeated checks reuse this report when available. Reports expire within 24 hours; capacity eviction or restart may remove them.</p></nav>`,
  );
}
