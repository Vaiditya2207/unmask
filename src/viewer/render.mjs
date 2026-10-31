import { createHash } from "node:crypto";

const css = `
:root{color-scheme:light;font-family:"Avenir Next","Segoe UI",sans-serif;color:#13294b;background:#edf4fa;font-size:16px;line-height:1.55}
*{box-sizing:border-box}body{margin:0}a{color:#156b85}a:focus-visible,input:focus-visible,summary:focus-visible{outline:3px solid #a65a12;outline-offset:3px}
header{padding:24px 5vw;background:#13294b;color:white;display:flex;justify-content:space-between;gap:24px;align-items:baseline}header strong{font-size:24px;letter-spacing:-1px}header p{margin:0;font-size:14px}
main{max-width:1440px;margin:0 auto;padding:42px 5vw;display:grid;grid-template-columns:240px minmax(0,1fr);gap:40px}aside{font-size:14px}aside dl{margin:20px 0}dt{font-weight:600;margin-top:16px}dd{margin:4px 0;overflow-wrap:anywhere}h1{font-size:clamp(24px,3vw,38px);line-height:1.15;font-weight:600;letter-spacing:-1px;margin:0 0 18px}h2{font-size:21px;margin:0 0 16px}h3{font-size:16px;margin:0 0 8px}p{max-width:75ch}
section{margin-bottom:30px}.status{display:inline-block;padding:4px 12px;background:#dceaf3;color:#13294b;border-radius:5px}.status.attention{background:#fff0da;color:#854300}.summary{background:white;padding:24px;border-radius:12px}.coverage{display:flex;gap:24px;flex-wrap:wrap;margin-top:20px}.coverage div{min-width:120px}.coverage strong{display:block;font-size:25px;line-height:1.2}.coverage span{font-size:13px}.note{font-size:14px;color:#405876}.finding{padding:12px 16px;border-left:4px solid #a65a12;background:#fff9ee;margin:8px 0}.finding code{overflow-wrap:anywhere}
label{font-size:14px;font-weight:600}input{display:block;margin:6px 0 18px;padding:11px 13px;width:100%;border:1px solid #9cb5ca;border-radius:6px;font:inherit;background:white;color:inherit}.files{background:white;border-radius:12px;overflow:hidden}.file{padding:14px 18px;border-bottom:1px solid #dce6ed}.file:last-child{border-bottom:0}.file[hidden]{display:none}.file summary{cursor:pointer;display:flex;gap:12px;align-items:baseline;flex-wrap:wrap}.path{flex:1;min-width:150px;font-weight:600;overflow-wrap:anywhere}.state{font-size:12px;padding:3px 7px;border-radius:4px;background:#e9e4f1;color:#55427a}.bytes{font-size:13px}.file dl{font-size:13px;display:grid;grid-template-columns:110px minmax(0,1fr);gap:6px 12px}.file dt,.file dd{margin:0}.file dd{overflow-wrap:anywhere}.evidence{padding:18px;background:white;border-radius:8px;margin:12px 0}.evidence h3{overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.6 Menlo,Consolas,monospace;background:#eef3f8;padding:14px;border-radius:5px;max-height:500px;overflow:auto}code{font-family:Menlo,Consolas,monospace;font-size:0.9em}.model{background:#e9e4f1;padding:22px;border-radius:12px}.model p{margin-bottom:0}footer{padding:0 5vw 28px;text-align:center;font-size:13px;color:#405876}.empty{padding:18px;background:white;border-radius:8px}
.skip{position:absolute;left:16px;top:-100px;background:white;padding:10px}.skip:focus{top:10px}.evidence summary{cursor:pointer;font-weight:600;overflow-wrap:anywhere}.evidence:target{outline:3px solid #a65a12;outline-offset:3px}.evidence dl{font-size:13px}.citations{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:8px 20px;padding-left:20px;font-size:13px}.citations li{overflow-wrap:anywhere}.cue{background:#e8f2f6;border-left:4px solid #156b85;padding:16px 18px;margin:10px 0}.cue p{margin:8px 0}.scope{background:white;padding:18px;border-radius:8px}.inventory-row{padding:12px 0;border-bottom:1px solid #dce6ed;overflow-wrap:anywhere}.display-limit{padding:14px;border-left:4px solid #695290;background:#eee9f4;color:#493967}.file summary::after{content:"Open file details";font-size:12px;color:#405876}.file[open] summary::after{content:"Close file details"}
@media(max-width:800px){main{grid-template-columns:1fr;gap:22px;padding-top:26px}aside{border-bottom:1px solid #9cb5ca;padding-bottom:20px}aside dl{display:grid;grid-template-columns:100px minmax(0,1fr);gap:7px 12px}aside dt,aside dd{margin:0}header{align-items:flex-start;flex-direction:column;gap:4px}.file dl{grid-template-columns:1fr}.coverage{gap:16px}}
`;

const script = `
const input=document.getElementById("file-filter");
const rows=[...document.querySelectorAll(".file")];
document.addEventListener("click",event=>{
  const link=event.target.closest("a[data-evidence]");
  if(!link)return;
  const target=document.getElementById(link.getAttribute("href").slice(1));
  if(target?.tagName==="DETAILS")target.open=true;
});
input.addEventListener("input",()=>{
  const query=input.value.toLocaleLowerCase();
  let count=0;
  for(const row of rows){row.hidden=!row.textContent.toLocaleLowerCase().includes(query);if(!row.hidden)count++;}
  document.getElementById("visible-count").textContent=count+" files shown";
});
`;

function escape(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
}

function bytes(value) {
  return `${Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString("en-US") : "unknown"} bytes`;
}

function assetHash(value) {
  return createHash("sha256").update(value).digest("base64");
}

const MiB = 1024 * 1024;
const maxFieldChars = 4096;

function text(value, limit = maxFieldChars) {
  const string = String(value ?? "");
  return (
    escape(string.slice(0, limit)) +
    (string.length > limit ? "… [text truncated; see full JSON report]" : "")
  );
}

function range(value) {
  return Array.isArray(value) &&
    value.length === 2 &&
    value.every((number) => Number.isSafeInteger(number) && number >= 0)
    ? `[${value[0]}, ${value[1]})`
    : "Unavailable";
}

function collection(items, render, maxBytes, maxItems = 20000) {
  const chunks = [];
  let used = 0;
  for (let i = 0; i < Math.min(items.length, maxItems); i++) {
    const html = render(items[i], i);
    const size = Buffer.byteLength(html);
    if (used + size > maxBytes) break;
    used += size;
    chunks.push(html);
  }
  const shown = chunks.length;
  const body = chunks.join("");
  const notice =
    shown < items.length
      ? `<p class="display-limit">HTML display limit: ${shown} of ${items.length} entries shown in this section. Remaining entries are preserved in the full JSON report.</p>`
      : "";
  return { shown, body, notice, html: body + notice };
}

function excerptView(evidence) {
  if (typeof evidence.excerpt !== "string")
    return '<p class="note">Text excerpt unavailable. Content may be unretained or not valid UTF-8; inspect the original digest-bound input.</p>';
  let shown = "",
    size = 0;
  for (const character of evidence.excerpt) {
    const length = Buffer.byteLength(character);
    if (size + length > 512) break;
    shown += character;
    size += length;
  }
  const start = evidence.excerptRange?.[0];
  const shownRange =
    Number.isSafeInteger(start) && start >= 0 ? [start, start + size] : null;
  const partial =
    shown.length < evidence.excerpt.length ||
    (shownRange && shownRange[1] < evidence.range?.[1]);
  return `<p class="note">Shown excerpt byte range ${range(shownRange)} (${size} bytes).${partial ? " Remaining evidence bytes are not displayed; inspect the original digest-bound input." : ""}</p><pre>${escape(shown)}</pre>`;
}

function evidenceView(entry) {
  const evidence = entry.value;
  return `<details class="evidence" id="${entry.target}"><summary>${text(evidence.side === "artifact" ? "Artifact" : evidence.side === "source" ? "Source" : evidence.side)}: ${text(evidence.path ?? evidence.originalPath)}</summary><p class="note">Evidence ${text(evidence.id)}. Evidence byte range ${range(evidence.range)}</p>${excerptView(evidence)}<dl><dt>Original path</dt><dd>${text(evidence.originalPath)}</dd><dt>Input blob SHA-256</dt><dd><code>${text(evidence.blobDigest || "Unavailable")}</code></dd><dt>File SHA-256</dt><dd><code>${text(evidence.fileSha256 || "Unavailable")}</code></dd></dl></details>`;
}

function citations(ids, index) {
  if (!Array.isArray(ids) || ids.length === 0)
    return '<p class="note">No bound citations recorded.</p>';
  const references = [...new Set(ids.slice(0, 8))]
    .map((id) => {
      const entry = index.get(id);
      if (!entry?.shown)
        return `<li>Evidence ${text(id)} is not shown here; see the full JSON report.</li>`;
      const evidence = entry.value;
      const side =
        evidence.side === "artifact"
          ? "Artifact"
          : evidence.side === "source"
            ? "Source"
            : "Evidence";
      return `<li><a data-evidence href="#${entry.target}">${side}: ${text(evidence.path ?? evidence.originalPath)}; bytes ${range(evidence.range)}</a> <code>${text(id)}</code></li>`;
    })
    .join("");
  return `<ul class="citations">${references}</ul>${ids.length > 8 ? '<p class="display-limit">HTML display limit: first eight citation references shown. See the full JSON report for all references.</p>' : ""}`;
}

function cueView(cue, index) {
  const labels = {
    "found-in-inspected-source": "Literal found in inspected source",
    "not-found-in-inspected-source": "Literal not found in inspected source",
    "source-unavailable": "Source unavailable for this observation",
    "no-static-literal": "No static literal was available",
  };
  return `<article class="cue"><h3><code>${text(cue.ruleId)}</code></h3><p>${text(cue.summary || cue.message, 1024)}</p>${cue.literalStatus !== undefined ? `<p class="note">${text(labels[cue.literalStatus] || "Source literal status unavailable")} <code>${text(cue.literalStatus)}</code></p>` : ""}${citations(cue.evidenceIds, index)}</article>`;
}

function annotationView(item, index) {
  const kind = item.type || item.code || item.ruleId || "Inspection annotation";
  const path = item.path ?? item.originalPath;
  const description =
    item.summary ||
    item.message ||
    item.limitation ||
    item.reason ||
    item.scope;
  const scope =
    kind === "syntax-scope"
      ? `<dl><dt>Parser</dt><dd>${text(item.parser || "Unavailable")}</dd><dt>Source syntax inspected</dt><dd>${bytes(item.sourceCoverage?.bytes)} across ${text(item.sourceCoverage?.files ?? "unknown")} files.</dd><dt>Source literals observed</dt><dd>${text(item.sourceLiteralCount ?? "unknown")}</dd></dl>${item.sourceLiteralTruncated ? '<p class="note">Source literal inventory was truncated; missing literals refer only to the inspected subset.</p>' : ""}`
      : "";
  return `<article class="inventory-row"><h3><code>${text(kind)}</code></h3>${path ? `<p>${item.side ? `${text(item.side)}: ` : ""}${text(path)}</p>` : ""}<p>${text(description)}</p>${item.reason && (item.summary || item.message || item.limitation) ? `<p class="note">${text(item.reason)}</p>` : ""}${scope}${Array.isArray(item.evidenceIds) && item.evidenceIds.length ? citations(item.evidenceIds, index) : ""}</article>`;
}

export function renderReport(report) {
  const claim = report.inputs?.claim || report.manifests?.artifact?.value || {};
  const identity = claim.name
    ? `${String(claim.name).slice(0, maxFieldChars)}${claim.version ? `@${String(claim.version).slice(0, 300)}` : ""}`
    : "local artifact";
  const code = report.policy?.exitCode;
  const status =
    code === 2
      ? "Incomplete analysis"
      : code === 3
        ? "Review required"
        : "Completed report";
  const inventory = report.coverage?.inventory || {};
  const findings = report.policy?.findings || [];
  const files = report.files || [];
  const evidence = report.evidence || [];
  const index = new Map();
  const indexed = [];
  for (let i = 0; i < Math.min(evidence.length, 50000); i++) {
    const item = evidence[i];
    if (index.has(item.id)) continue;
    const entry = { value: item, target: `evidence-${i}`, shown: false };
    index.set(item.id, entry);
    indexed.push(entry);
  }
  const catalog = collection(indexed, evidenceView, 6 * MiB, 50000);
  for (let i = 0; i < catalog.shown; i++) indexed[i].shown = true;
  if (evidence.length > 50000)
    catalog.html +=
      '<p class="display-limit">HTML display limit: at most 50,000 evidence records are indexed. See the full JSON report.</p>';
  const fileRows = collection(
    files,
    (file) =>
      `<details class="file"><summary><span class="path">${text(file.path ?? file.originalPath)}</span><span class="state">${text(file.state)}</span><span class="bytes">${bytes(file.size)}</span></summary><dl><dt>Original path</dt><dd>${text(file.originalPath)}</dd><dt>Reason</dt><dd>${text(file.reason || "Observed byte correspondence only")}</dd><dt>Artifact SHA-256</dt><dd><code>${text(file.artifactSha256)}</code></dd><dt>Source SHA-256</dt><dd><code>${text(file.sourceSha256 || "Unavailable")}</code></dd><dt>Localization</dt><dd>${text(typeof file.localization === "string" ? file.localization : "See bound evidence ranges")}</dd></dl>${citations(file.evidenceIds, index)}</details>`,
    6 * MiB,
  );
  const findingRows = collection(
    findings,
    (finding) =>
      `<div class="finding"><code>${text(finding.ruleId || finding.id)}</code><p class="note">${text(finding.message || "Review the bound artifact and source evidence.", 1024)}</p>${citations(finding.evidenceIds, index)}</div>`,
    MiB / 2,
  );
  const failures = collection(
    report.failures || [],
    (failure) =>
      `<div class="finding"><code>${text(failure.code)}</code><p>${text(failure.message, 1024)}</p></div>`,
    MiB / 4,
  );
  const cues = collection(
    report.cues || [],
    (cue) => cueView(cue, index),
    MiB,
    10000,
  );
  const annotations = collection(
    report.annotations || [],
    (item) => annotationView(item, index),
    MiB / 2,
  );
  const links = collection(
    report.coverage?.linkEntries || [],
    (link) =>
      `<article class="inventory-row"><h3>${text(link.side)}: ${text(link.path ?? link.originalPath)}</h3><p>${text(link.type)}. Inert target: <code>${text(link.linkTarget)}</code></p><p class="note">Original path: ${text(link.originalPath)}. Link content is not followed or compared.</p></article>`,
    MiB / 2,
  );
  const sourceOnly = collection(
    report.coverage?.sourceOnly || [],
    (path) => `<li>${text(path)}</li>`,
    MiB / 2,
  );
  const model = report.model || { status: "disabled" };
  const hypotheses = collection(
    model.hypotheses || [],
    (hypothesis) =>
      `<article><p>${text(hypothesis.explanation, 4096)}</p>${citations(hypothesis.evidenceIds, index)}</article>`,
    MiB / 4,
    1000,
  );
  const modelText =
    model.status === "disabled"
      ? "Model is disabled"
      : `Model status: ${model.status}`;
  const csp = `default-src 'none'; script-src 'sha256-${assetHash(script)}'; style-src 'sha256-${assetHash(css)}'; connect-src 'none'; base-uri 'none'; form-action 'none'`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${escape(csp)}"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex"><title>UNMASK · ${text(identity)}</title><style>${css}</style></head><body>
<a class="skip" href="#content">Skip to evidence</a><header><strong>UNMASK</strong><p>Published bytes. Source claims. Evidence to review.</p></header>
<main id="content"><aside><h2>Release identity</h2><dl><dt>Artifact SHA-256</dt><dd><code>${text(report.inputs?.artifact?.sha256)}</code></dd><dt>Source selection</dt><dd>${text(report.source?.status || "unresolved")}</dd><dt>Source method</dt><dd>${text(report.source?.method || "unresolved")}</dd><dt>Commit claim</dt><dd><code>${text(report.source?.commit || "Unavailable")}</code></dd></dl><p>Matching bytes establish correspondence to a selected source. They do not establish benign behavior.</p></aside>
<div><section class="summary"><h1>Review evidence for ${text(identity)}</h1><span class="status ${code === 2 || code === 3 ? "attention" : ""}">${status}</span><p>A completed report is not a safety verdict. Unknown and uninspected content stays visible.</p><div class="coverage"><div><strong>${bytes(inventory.bytes)}</strong><span>${inventory.complete === false || inventory.lowerBound ? "known lower bound" : "artifact inventory"}</span></div><div><strong>${bytes(report.coverage?.compared?.bytes)}</strong><span>compared with selected source</span></div><div><strong>${text(inventory.files ?? 0)}</strong><span>regular files inventoried</span></div></div></section>
<section><h2>${findings.length ? "Review required" : "Policy findings"}</h2>${findings.length ? findingRows.html : '<p class="empty">No default policy findings. This does not mean no review is needed.</p>'}${failures.html}</section>
<section><h2>${(report.cues || []).length ? "Review suggested" : "Review observations"}</h2><p class="note">Observations support review. They do not establish execution or maliciousness. Syntax literal status applies only to inspected JavaScript.</p>${(report.cues || []).length ? cues.html : '<p class="empty">No review suggestions recorded. Uninspected content remains unknown.</p>'}</section>
<section><h2>File correspondence</h2><label for="file-filter">Find a path, state or digest</label><input id="file-filter" type="search" autocomplete="off" placeholder="Filter files"><p id="visible-count" class="note" aria-live="polite">${fileRows.shown} files shown</p><div class="files">${files.length ? fileRows.html : '<p class="empty">No regular files were accepted. Check the analysis limitations above.</p>'}</div></section>
<section><h2>Inspection scope and limits</h2><div class="scope"><p>Syntax inspected: ${bytes(report.coverage?.syntaxInspected?.bytes)} across ${text(report.coverage?.syntaxInspected?.files ?? "unknown")} files.</p><p>Model reviewed: ${bytes(report.coverage?.modelReviewed?.bytes)} across ${text(report.coverage?.modelReviewed?.files ?? "unknown")} files.</p><p>Inspection coverage is separate from byte correspondence. Unsupported syntax, missing content and skipped maps remain uninspected.</p>${annotations.html || '<p class="note">No inspection annotations recorded.</p>'}</div></section>
<section><h2>Inert links</h2><p class="note">Artifact links: ${text(report.coverage?.links?.artifact ?? "unknown")}. Source links: ${text(report.coverage?.links?.source ?? "unknown")}.</p>${links.html || '<p class="empty">No inert link entries recorded.</p>'}</section>
<section><h2>Source-only paths</h2>${sourceOnly.html ? `<ul>${sourceOnly.body}</ul>${sourceOnly.notice}` : '<p class="empty">No source-only paths recorded. Source availability and completeness still apply.</p>'}</section>
<section><h2>Bound evidence</h2><p class="note">Excerpts show original text data. Excerpt display limit: 512 bytes per evidence item. Byte ranges are half-open: start included, end excluded. Open a citation to inspect its digest-bound evidence.</p>${catalog.html || '<p class="empty">No bound evidence recorded.</p>'}</section>
<section class="model"><h2>Model explanations</h2><p>${text(modelText)}</p><p class="note">Hypotheses are separate from deterministic evidence. A valid citation proves its location, not the reasoning.</p>${hypotheses.html}</section>
</div></main><footer>UNMASK presents evidence for review. It never declares a package safe. HTML display limits do not change the full JSON report.</footer><script>${script}</script></body></html>`;
}
