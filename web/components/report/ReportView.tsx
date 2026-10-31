import type { Report } from "@/lib/report.ts";
import {
  formatBytes,
  formatCount,
  formatUtc,
  repoLabel,
  shortSha,
  tally,
} from "@/lib/report.ts";
import { FileMap } from "@/components/ui/FileMap";
import { EvidencePanel } from "@/components/ui/EvidencePanel";
import { FileTable } from "@/components/report/FileTable";

export function ReportView({ report }: { report: Report }) {
  const t = tally(report);
  const { release, source } = report;
  const spec = `${release.name}@${release.version}`;
  const finding = report.findings[0];
  const scripts = Object.entries(release.installScripts);
  const groups = [
    ...Map.groupBy(report.sourceOnly, (f) => f.reason).entries(),
  ].sort((a, b) => b[1].length - a[1].length);
  return (
    <main className="viewer" id="main">
      <div className="title-row">
        <div>
          <h1>{spec}</h1>
          <p className="subtitle">
            Compared with{" "}
            <a href={`${source.repository}/tree/${source.commit}`}>
              {repoLabel(source.repository)}
            </a>{" "}
            at <code>{shortSha(source.commit)}</code>
            {source.tag ? ` (${source.tag})` : ""}, analysed{" "}
            {formatUtc(report.analyzedAt)}
          </p>
        </div>
        <a
          className="btn"
          href={`/api/reports/${report.id}`}
          download={`unmask-${report.id}.json`}
        >
          Download JSON
        </a>
      </div>

      {report.sample ? <p className="notice">{report.sample.note}</p> : null}

      <p className="finding-line">
        {t.review === 0 ? (
          <>
            Every published file is explained by its source or its build. That
            is evidence, not a verdict of safe.
          </>
        ) : (
          <>
            <strong>
              {formatCount(t.review)} of {formatCount(t.published)} published
              files needs review.
            </strong>{" "}
            {finding ? (
              <>
                <code>{finding.path}</code> carries{" "}
                {formatBytes(finding.extra.end - finding.extra.start)} that no
                build step produces.{" "}
                <a href={`#${finding.id}`}>See the evidence</a>
              </>
            ) : null}
          </>
        )}
      </p>

      <dl className="stats">
        <div className="stat stat-lead">
          <dt>Needs review</dt>
          <dd className="num">{formatCount(t.review)}</dd>
        </div>
        <div className="stat">
          <dt>Built from source</dt>
          <dd className="num">{formatCount(t.built)}</dd>
        </div>
        <div className="stat">
          <dt>Byte-identical</dt>
          <dd className="num">{formatCount(t.identical)}</dd>
        </div>
        <div className="stat">
          <dt>Only in source</dt>
          <dd className="num">{formatCount(t.sourceOnly)}</dd>
        </div>
      </dl>

      <div className="pair">
        <section className="card" aria-labelledby="release-title">
          <div className="card-head">
            <h2 id="release-title">Release</h2>
            <span className="faint">npm registry</span>
          </div>
          <dl className="kv">
            <div>
              <dt>Published</dt>
              <dd>
                {formatUtc(release.publishedAt)} by {release.publisher}
              </dd>
            </div>
            <div>
              <dt>Tarball</dt>
              <dd>
                <a href={release.tarballUrl}>
                  <code>{release.tarballUrl.split("/").pop()}</code>
                </a>
              </dd>
            </div>
            <div>
              <dt>Integrity</dt>
              <dd>
                <code title={release.integrity}>
                  {release.integrity.slice(0, 30)}…
                </code>
              </dd>
            </div>
            <div>
              <dt>Files</dt>
              <dd className="num">
                {formatCount(t.published)} analysed
                <span className="faint">
                  {" "}
                  · registry lists {formatCount(release.registryFileCount)}
                </span>
              </dd>
            </div>
            <div>
              <dt>Unpacked</dt>
              <dd className="num">
                {formatBytes(t.publishedBytes)} analysed
                <span className="faint">
                  {" "}
                  · registry lists {formatBytes(release.registryUnpackedSize)}
                </span>
              </dd>
            </div>
            <div>
              <dt>Runs on install</dt>
              <dd>
                {scripts.length === 0
                  ? "Nothing"
                  : scripts.map(([hook, command]) => (
                      <code key={hook} className="neg">
                        {hook}: {command}
                      </code>
                    ))}
              </dd>
            </div>
            <div>
              <dt>Provenance</dt>
              <dd>
                {release.provenance
                  ? "Signed build statement"
                  : "None published"}
              </dd>
            </div>
            <div>
              <dt>Source</dt>
              <dd>
                Commit <code>{shortSha(source.commit)}</code> from the
                registry&rsquo;s gitHead,{" "}
                <span className="num">{formatCount(source.fileCount)}</span>{" "}
                files
              </dd>
            </div>
          </dl>
        </section>
      </div>

      <div className="pair pair-map">
        <section className="card card-map" aria-labelledby="map-title">
          <div className="card-head">
            <h2 id="map-title">Correspondence</h2>
            <span className="faint">each published file beside its source</span>
          </div>
          <FileMap report={report} />
        </section>
        <section
          className="card card-column"
          aria-labelledby="source-only-title"
        >
          <div className="card-head">
            <h2 id="source-only-title">
              Only in source{" "}
              <span className="faint num">{report.sourceOnly.length}</span>
            </h2>
            <span className="faint">kept out of the tarball</span>
          </div>
          {groups.map(([reason, files]) => (
            <div key={reason} className="source-group">
              <p className="source-reason">
                {reason} <span className="num">{files.length}</span>
              </p>
              <ul className="source-only">
                {files.map((f) => (
                  <li key={f.path}>
                    <code>{f.path}</code>
                    <span className="num faint">{formatBytes(f.bytes)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <p className="card-total">
            <span>Total kept out</span>
            <span className="num">
              {formatBytes(
                report.sourceOnly.reduce((sum, f) => sum + f.bytes, 0),
              )}
            </span>
          </p>
        </section>
      </div>

      {report.findings.map((f) => (
        <section
          key={f.id}
          id={f.id}
          className="card card-finding"
          aria-labelledby={`${f.id}-title`}
        >
          <div className="card-head">
            <h2 id={`${f.id}-title`}>{f.title}</h2>
            <span className="faint">Finding {f.id}</span>
          </div>
          <EvidencePanel finding={f} wide />
        </section>
      ))}

      <FileTable files={report.files} />

      <p className="foot-note">
        UNMASK shows evidence for review and never declares a package safe. The
        tarball is read as files; nothing in it is run.
      </p>
    </main>
  );
}
