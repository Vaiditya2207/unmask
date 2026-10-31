import type { FileRow } from "@/lib/report.ts";
import { formatCount } from "@/lib/report.ts";

// Signal only for files that differ from the source and carry cues; every other state is neutral.
export function StatePill({
  row,
  className = "",
}: {
  row: Pick<FileRow, "stateLabel" | "signal">;
  className?: string;
}) {
  return (
    <span
      className={`state-pill ${row.signal ? "state-pill--signal" : "state-pill--neutral"} ${className}`.trim()}
    >
      {row.stateLabel}
    </span>
  );
}

export function Bytes({ value }: { value: number }) {
  return (
    <>
      {formatCount(value)}
      <span className="byte-unit">B</span>
    </>
  );
}

export function CueMark({ quiet = false }: { quiet?: boolean }) {
  return (
    <span
      className={`cue-mark${quiet ? " cue-mark--quiet" : ""}`}
      aria-hidden="true"
    />
  );
}

export function Arrow({ down = false }: { down?: boolean }) {
  return down ? (
    <svg
      className="install-link__arrow install-link__arrow--down"
      width="10"
      height="20"
      viewBox="0 0 10 20"
    >
      <path d="M5 1v17M1.5 14.5 5 18l3.5-3.5" />
    </svg>
  ) : (
    <svg
      className="install-link__arrow install-link__arrow--across"
      width="40"
      height="10"
      viewBox="0 0 40 10"
    >
      <path d="M1 5h37M34 1.5 38 5l-4 3.5" />
    </svg>
  );
}

// A list of paths: the first few inline, the rest behind a native disclosure that works without script.
export function PathList({
  paths,
  first = 8,
}: {
  paths: string[];
  first?: number;
}) {
  if (paths.length === 0) return null;
  const shown = paths.slice(0, first);
  const rest = paths.slice(first);
  return (
    <div className="path-list">
      <ul className="path-list__items">
        {shown.map((path) => (
          <li key={path}>
            <code>{path}</code>
          </li>
        ))}
      </ul>
      {rest.length ? (
        <details className="path-list__more">
          <summary>and {formatCount(rest.length)} more</summary>
          <ul className="path-list__items">
            {rest.map((path) => (
              <li key={path}>
                <code>{path}</code>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
