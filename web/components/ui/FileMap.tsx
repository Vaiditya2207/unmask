import type { Report } from "@/lib/report.ts";
import { formatCount, shortSha, tally } from "@/lib/report.ts";

type Kind = "identical" | "build" | "unexplained";

interface Placed {
  path: string;
  kind: Kind;
  row: number;
  target: number;
}

// Published files sit level with the source file they come from, so a straight
// line means byte-identical and a fan means one source file built several.
export function layoutMap(report: Report) {
  const sourcePaths = [
    ...report.files
      .filter((f) => f.explanation.kind === "identical")
      .map((f) => f.path),
    ...report.sourceOnly.map((f) => f.path),
  ].sort();
  const sourceRow = new Map(sourcePaths.map((p, i) => [p, i]));
  const targetOf = (file: Report["files"][number]) => {
    const e = file.explanation;
    if (e.kind === "identical") return sourceRow.get(file.path) ?? 0;
    if (e.kind === "build") return sourceRow.get(e.from) ?? 0;
    const finding = report.findings.find((f) => f.id === e.findingId);
    return sourceRow.get(finding?.expected.from ?? "") ?? sourcePaths.length;
  };
  const ordered = report.files
    .map((f) => ({
      path: f.path,
      kind: f.explanation.kind,
      target: targetOf(f),
    }))
    .sort((a, b) => a.target - b.target || a.path.localeCompare(b.path));
  let last = -1;
  const left: Placed[] = ordered.map((f) => {
    const row = Math.max(f.target, last + 1);
    last = row;
    return { ...f, row };
  });
  const shared = new Set(
    left.filter((f) => f.kind === "identical").map((f) => f.path),
  );
  const built = new Set(
    left
      .filter((f) => f.kind !== "identical")
      .map((f) => sourcePaths[f.target]),
  );
  const right = sourcePaths.map((path) => ({
    path,
    kind: shared.has(path) ? "shared" : built.has(path) ? "input" : "only",
  }));
  const rows = Math.max(right.length, last + 1);
  const firstLeft = left.length ? left[0].row : rows;
  return { left, right, rows, firstLeft };
}

const PITCH = 24;
const WIDTH = 80;

export function FileMap({
  report,
  compact = false,
}: {
  report: Report;
  compact?: boolean;
}) {
  const { left, right, rows, firstLeft } = layoutMap(report);
  const t = tally(report);
  const legendInside = firstLeft >= 6;
  const legend = (
    <ul className="map-legend" aria-label="Key">
      <li>
        <svg width="28" height="8" aria-hidden="true">
          <line x1="0" y1="4" x2="28" y2="4" className="map-line identical" />
        </svg>
        <span className="num">{formatCount(t.identical)}</span> byte-identical
      </li>
      <li>
        <svg width="28" height="8" aria-hidden="true">
          <line x1="0" y1="4" x2="28" y2="4" className="map-line build" />
        </svg>
        <span className="num">{formatCount(t.built)}</span> built from source
      </li>
      <li>
        <svg width="28" height="8" aria-hidden="true">
          <line x1="0" y1="4" x2="28" y2="4" className="map-line unexplained" />
        </svg>
        <span className="num">{formatCount(t.review)}</span> needs review
      </li>
      <li>
        <svg width="28" height="8" aria-hidden="true">
          <circle cx="24" cy="4" r="3" className="map-dot" />
        </svg>
        <span className="num">{formatCount(t.sourceOnly)}</span> only in source
      </li>
    </ul>
  );
  return (
    <div
      className={`ui ui-map${compact ? " compact" : ""}`}
      data-ui
      role="group"
      aria-label="File correspondence"
    >
      <div className="ui-head">
        <span className="ui-title">Published</span>
        <span className="ui-title ui-title-right">
          Source at <code>{shortSha(report.source.commit)}</code>
        </span>
      </div>
      {legendInside ? null : <div className="map-legend-row">{legend}</div>}
      <div
        className="map-grid"
        style={{
          ["--rows" as string]: rows,
          ["--pitch" as string]: `${PITCH}px`,
        }}
      >
        {legendInside ? (
          <div
            className="map-legend-slot"
            style={{ gridRow: `1 / span ${Math.min(firstLeft, 6)}` }}
          >
            {legend}
          </div>
        ) : null}
        <ol
          className="map-col map-left"
          aria-label={`${left.length} published files`}
        >
          {left.map((f) => (
            <li
              key={f.path}
              className={`map-path ${f.kind}`}
              style={{ gridRow: f.row + 1 }}
            >
              <code>{f.path}</code>
              {f.kind === "unexplained" ? (
                <span className="map-mark">+</span>
              ) : null}
            </li>
          ))}
        </ol>
        <svg
          className="map-links"
          viewBox={`0 0 ${WIDTH} ${rows * PITCH}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {left.map((f) => {
            const y1 = f.row * PITCH + PITCH / 2;
            const y2 = f.target * PITCH + PITCH / 2;
            return (
              <path
                key={f.path}
                className={`map-line ${f.kind}`}
                d={`M0 ${y1} C ${WIDTH / 2} ${y1}, ${WIDTH / 2} ${y2}, ${WIDTH} ${y2}`}
              />
            );
          })}
        </svg>
        <ol
          className="map-col map-right"
          aria-label={`${right.length} files in source`}
        >
          {right.map((f, i) => (
            <li
              key={f.path}
              className={`map-path ${f.kind}`}
              style={{ gridRow: i + 1 }}
            >
              <code>{f.path}</code>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
