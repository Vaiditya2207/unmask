import type { CueKind, InstallPath, ReportView as View } from "@/lib/report.ts";
import {
  formatBytes,
  formatCount,
  formatUtc,
  kindLabel,
  shortSha,
} from "@/lib/report.ts";
import { FileExplorer } from "@/components/report/FileExplorer";
import {
  Arrow,
  Bytes,
  CueMark,
  PathList,
  StatePill,
} from "@/components/report/parts";
import type { Download } from "@/components/report/ViewerBar";

const plural = (n: number, one: string, many = `${one}s`) =>
  `${formatCount(n)} ${n === 1 ? one : many}`;

// `line` separators sit between the meta's lines; a phone stacks the lines and drops them.
function Sep({ line = false }: { line?: boolean }) {
  return (
    <span
      className={`meta-sep${line ? " meta-sep--line" : ""}`}
      aria-hidden="true"
    >
      ·
    </span>
  );
}

function DownloadButton({ download }: { download: Download }) {
  return (
    <a
      className="button button--secondary"
      href={download.href}
      download={download.filename}
    >
      <svg
        className="button__icon"
        width="14"
        height="14"
        viewBox="0 0 14 14"
        aria-hidden="true"
      >
        <path d="M7 1.75v7M4 6l3 3 3-3M2.25 11.75h9.5" />
      </svg>
      Download JSON
    </a>
  );
}

function Header({ view, download }: { view: View; download: Download }) {
  const { source } = view;
  const status = source.available
    ? source.complete
      ? "Source complete"
      : "Source incomplete"
    : "No source found";
  return (
    <header className="report-header">
      <div className="report-header__text">
        <h1 className="report-title">{view.spec}</h1>
        <p className="report-meta">
          {source.available && source.repositoryLabel ? (
            <>
              <span className="report-meta__line">
                Compared with{" "}
                {source.href ? (
                  <a className="report-meta__link" href={source.href}>
                    {source.repositoryLabel}
                  </a>
                ) : (
                  source.repositoryLabel
                )}
              </span>
              <Sep line />
            </>
          ) : null}
          {source.available ? (
            <>
              <span className="report-meta__line">
                {source.directory ? (
                  <>
                    <code>{source.directory}</code> at{" "}
                  </>
                ) : (
                  "At "
                )}
                {source.commit ? (
                  <code>{shortSha(source.commit)}</code>
                ) : (
                  "an unnamed commit"
                )}{" "}
                ({source.method})
              </span>
              <Sep line />
            </>
          ) : null}
          <span className="report-meta__line">
            {status}
            {view.checkedAt ? (
              <>
                <Sep />
                Checked {formatUtc(view.checkedAt)}
              </>
            ) : null}
          </span>
        </p>
      </div>
      <div className="report-header__actions">
        <DownloadButton download={download} />
      </div>
    </header>
  );
}

// Advisory records from the package details' OSV lookup for this exact release, when it returned any.
export interface Advisories {
  count: number;
  complete: boolean;
}

function Finding({
  view,
  advisories,
}: {
  view: View;
  advisories?: Advisories | null;
}) {
  return (
    <p className="report-finding">
      {view.finding.map((segment, i) =>
        segment.code ? <code key={i}>{segment.text}</code> : segment.text,
      )}
      {advisories && advisories.count > 0 ? (
        <>
          {" "}
          {advisories.complete
            ? "OSV lists "
            : "An incomplete OSV lookup returned "}
          <a className="report-finding__link" href="#vulnerabilities">
            {plural(advisories.count, "known advisory", "known advisories")}
          </a>{" "}
          for this exact version.
        </>
      ) : null}
    </p>
  );
}

function StatusCells({ view }: { view: View }) {
  return (
    <dl className="status-grid">
      {view.status.map((cell) => (
        <div key={cell.label} className="status-cell">
          <dt className="status-cell__label">{cell.label}</dt>
          <dd
            className={`status-cell__value${cell.signal ? " status-cell__value--signal" : ""}`}
          >
            {cell.value}
            {cell.aside ? (
              <>
                {" "}
                <span className="status-cell__aside">{cell.aside}</span>
              </>
            ) : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Stats({ view }: { view: View }) {
  const artifactOnly = view.counts["artifact-only"];
  const leadLabel =
    view.unresolved.files === artifactOnly.files
      ? "Not in source"
      : "Unresolved";
  const identical = view.counts["byte-identical"];
  const exit = view.policy.exitCode;
  return (
    <section className="stat-row" aria-label="Summary">
      <div
        className={`report-card stat-card${view.unresolved.files ? " stat-card--lead" : ""}`}
      >
        <p className="stat-card__label">{leadLabel}</p>
        <p className="stat-card__figure">
          <span className="stat-card__value">
            {formatCount(view.unresolved.files)}
          </span>
          <span className="byte-unit">
            {view.unresolved.files === 1 ? "file" : "files"}
          </span>
        </p>
        <p className="stat-card__sub">
          <strong>{formatBytes(view.unresolved.bytes)}</strong> of{" "}
          {formatBytes(view.inventory.bytes)}
        </p>
      </div>
      <div className="report-card stat-card">
        <p className="stat-card__label">Byte-identical</p>
        <p className="stat-card__figure">
          <span className="stat-card__value">
            {formatCount(identical.files)}
          </span>
          <span className="byte-unit">
            {identical.files === 1 ? "file" : "files"}
          </span>
        </p>
        <p className="stat-card__sub">{formatBytes(identical.bytes)}</p>
      </div>
      <div className="report-card stat-card">
        <p className="stat-card__label">Review cues</p>
        <p className="stat-card__figure">
          <span className="stat-card__value">{formatCount(view.cueCount)}</span>
        </p>
        <p className="stat-card__sub">
          {view.cueCount ? `in ${plural(view.cueFiles, "file")}` : "None found"}
        </p>
      </div>
      <div className="report-card stat-card">
        <p className="stat-card__label">Policy</p>
        <p className="stat-card__figure">
          <span className="stat-card__value">Exit {exit}</span>
        </p>
        <p className="stat-card__sub">
          {exit === 0
            ? "Not a safety verdict"
            : exit === 3
              ? plural(view.policy.findings.length, "finding")
              : "Incomplete check"}
        </p>
      </div>
    </section>
  );
}

// Policy findings and deterministic failures, when there are any. No run so far has produced one.
function Notices({ view }: { view: View }) {
  if (!view.policy.findings.length && !view.failures.length) return null;
  return (
    <section className="report-card notice-card" aria-labelledby="notice-title">
      <h2 className="report-card__title" id="notice-title">
        {view.policy.findings.length ? "Policy findings" : "Check incomplete"}
      </h2>
      <ul className="notice-list">
        {view.policy.findings.map((text) => (
          <li key={text}>{text}</li>
        ))}
        {view.failures.map((failure, i) => (
          <li key={`${failure.code}-${i}`}>
            <code className="reason-code">{failure.code}</code>{" "}
            {failure.message}
          </li>
        ))}
      </ul>
    </section>
  );
}

function CueFigures({ path }: { path: InstallPath }) {
  const { file } = path;
  if (file.cueCount === 0)
    return (
      <p className="install-node__empty">
        {file.syntaxNotInspected
          ? `Syntax not inspected (${file.syntaxNotInspected})`
          : "No review cues found"}
      </p>
    );
  // The order the approved install path reads in; "other" only when it has cues.
  const kinds: CueKind[] = ["network", "process", "environment"];
  if (file.kindCounts.other) kinds.push("other");
  return (
    <dl
      className="cue-figures"
      style={{ "--figures": kinds.length } as React.CSSProperties}
    >
      {kinds.map((kind) => (
        <div key={kind} className="cue-figure">
          <dt className="cue-figure__label">
            <CueMark quiet={file.kindCounts[kind] === 0} />
            {kindLabel[kind]}
          </dt>
          <dd className="cue-figure__value">
            {formatCount(file.kindCounts[kind])}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function InstallPaths({ paths }: { paths: InstallPath[] }) {
  if (!paths.length) return null;
  return (
    <section
      className="report-card install-path"
      aria-labelledby="install-path-title"
    >
      <header className="report-card__header install-path__header">
        <h2 className="report-card__title" id="install-path-title">
          Install path
        </h2>
        <p className="install-path__aside">
          What <code>npm install</code> runs for this release
        </p>
      </header>
      {paths.map((path) => (
        <div key={path.hook} className="install-path__item">
          <ol className="install-flow">
            <li className="install-node install-node--script">
              <p className="install-node__label">
                <code>package.json</code>
                <span aria-hidden="true">→</span>
                <code>scripts.{path.hook}</code>
              </p>
              <p className="install-node__value">
                <code title={path.command}>{path.command}</code>
              </p>
            </li>
            <li className="install-link" aria-hidden="true">
              <span className="install-link__label">runs</span>
              <Arrow />
              <Arrow down />
            </li>
            <li className="install-node install-node--file">
              <p className="install-node__label">File it runs</p>
              <p className="install-node__value">
                <code>{path.file.path}</code>
                <span className="install-node__size">
                  <Bytes value={path.file.size} />
                </span>
                <StatePill row={path.file} />
              </p>
            </li>
            <li className="install-link" aria-hidden="true">
              <span className="install-link__label">contains</span>
              <Arrow />
              <Arrow down />
            </li>
            <li className="install-node install-node--cues">
              <CueFigures path={path} />
            </li>
          </ol>
          <p className="install-path__note">{path.note}</p>
        </div>
      ))}
    </section>
  );
}

function NotInspected({ view }: { view: View }) {
  const { artifact, sourceCount, reasons } = view.notInspected;
  const { paths, scope } = view.sourceOnly;
  const counted = [
    artifact.length ? plural(artifact.length, "published file") : null,
    sourceCount ? plural(sourceCount, "source file") : null,
  ].filter(Boolean);
  return (
    <section className="report-card scope-card" aria-labelledby="scope-title">
      <div className="scope-card__grid">
        <div className="scope-card__cell">
          <h2 className="report-card__title" id="scope-title">
            Not inspected
          </h2>
          {reasons.length ? (
            <p className="report-card__sub">
              {reasons.length === 1 ? "Reason" : "Reasons"}:{" "}
              {reasons.join(", ")}
            </p>
          ) : null}
        </div>
        <div className="scope-card__cell">
          <p className="scope-card__label">Not syntax-checked</p>
          <p className="scope-card__value">
            {counted.length ? counted.join(" and ") : "None"}
          </p>
          <PathList paths={artifact} />
        </div>
        <div className="scope-card__cell">
          <p className="scope-card__label">Only in source</p>
          <p className="scope-card__value">
            {paths.length ? plural(paths.length, "path") : "None"}
            {scope ? (
              <>
                {" "}
                within <code>{scope}</code>
              </>
            ) : null}
          </p>
          <PathList paths={paths} first={6} />
        </div>
      </div>
    </section>
  );
}

function NotCompared({ view }: { view: View }) {
  const rows = view.notCompared;
  const shown = rows.slice(0, 8);
  const reason = rows[0]?.reason ?? "source unavailable";
  return (
    <div className="not-compared">
      <div className="not-compared__head">
        <p className="not-compared__label">Not compared</p>
        <p className="not-compared__value">
          {reason[0].toUpperCase() + reason.slice(1)}
        </p>
      </div>
      <div className="not-compared__body">
        <ul className="not-compared__files">
          {shown.map((row) => (
            <li key={row.key} className="not-compared__file">
              <code>{row.path}</code>
              <span className="not-compared__size">
                <Bytes value={row.size} />
              </span>
            </li>
          ))}
          {rows.length > shown.length ? (
            <li className="not-compared__file">
              and {formatCount(rows.length - shown.length)} more
            </li>
          ) : null}
        </ul>
        <p className="not-compared__total">
          {plural(rows.length, "file")} ·{" "}
          <strong>{formatCount(view.counts["not-compared"].bytes)}</strong>
          <span className="byte-unit">B</span>
        </p>
      </div>
    </div>
  );
}

function Foot({ view }: { view: View }) {
  return (
    <footer className="report-foot">
      <p className="report-foot__note">
        UNMASK shows evidence for review and never declares a package safe. The
        tarball is read as data; nothing in it is run.
      </p>
      <p className="report-foot__meta">
        Schema {view.foot.schema} · policy {view.foot.policyVersion}
        {view.foot.parser ? ` · parser ${view.foot.parser}` : ""}
      </p>
    </footer>
  );
}

// Whether Published files is on the page. A report with no source lists its few files in the status
// card instead, unless it has syntax cues or more files than that card shows.
export function showsExplorer(view: View) {
  return (
    view.mode === "compared" ||
    view.syntaxCueCount > 0 ||
    view.notCompared.length > 8
  );
}

// `children` follow the comparison on the same sheet, above the foot: a live report's package details,
// or the one note that says they are unavailable.
export function ReportView({
  view,
  download,
  initialKey,
  initialTab,
  advisories,
  children,
}: {
  view: View;
  download: Download;
  initialKey?: string;
  initialTab?: string;
  advisories?: Advisories | null;
  children?: React.ReactNode;
}) {
  const explorer = (
    <FileExplorer
      rows={view.rows}
      tabs={view.tabs}
      defaultKey={view.defaultKey}
      initialKey={initialKey}
      initialTab={initialTab}
    />
  );
  if (view.mode === "no-source")
    return (
      <>
        <Header view={view} download={download} />
        <Finding view={view} advisories={advisories} />
        <section className="report-card state-card" aria-label="Check status">
          <StatusCells view={view} />
          <NotCompared view={view} />
        </section>
        {showsExplorer(view) ? explorer : null}
        {children}
        <Foot view={view} />
      </>
    );
  return (
    <>
      <Header view={view} download={download} />
      <Finding view={view} advisories={advisories} />
      <section className="report-card status-strip" aria-label="Check status">
        <StatusCells view={view} />
      </section>
      <Stats view={view} />
      <Notices view={view} />
      <InstallPaths paths={view.installPaths} />
      {explorer}
      <NotInspected view={view} />
      {children}
      <Foot view={view} />
    </>
  );
}
