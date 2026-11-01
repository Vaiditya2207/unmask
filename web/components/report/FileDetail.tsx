import type { FileRow } from "@/lib/report.ts";
import { formatBytes, formatCount } from "@/lib/report.ts";
import { CueMark } from "@/components/report/parts";

const SYNTAX_NOTE =
  "Syntactic capability references. Execution and binding are not proven.";

// State and size lead on desktop; under the selected row they are already on the line above.
function facts(row: FileRow, inline = false) {
  const parts = inline ? [] : [row.stateLabel, formatBytes(row.size)];
  if (row.runsOnInstall)
    parts.push(inline ? "Runs on install" : "runs on install");
  if (row.spans)
    parts.push(
      `differs at bytes ${row.spans.artifact[0]}–${row.spans.artifact[1]}`,
    );
  if (row.state === "not-compared" && row.reason) parts.push(row.reason);
  return parts.join(" · ");
}

function emptyText(row: FileRow) {
  if (row.state === "byte-identical")
    return row.syntaxNotInspected
      ? `Its bytes match the source. Its syntax was not inspected (${row.syntaxNotInspected}).`
      : row.unchangedCapabilities
        ? `Its bytes match the source, including ${formatCount(row.unchangedCapabilities)} capability references.`
        : "Its bytes match the source, and the syntax check found no capability references.";
  if (row.syntaxNotInspected)
    return `No review cues: its syntax was not inspected (${row.syntaxNotInspected}).`;
  return "No review cues: the syntax check found no capability references.";
}

function footNote(row: FileRow) {
  const cues = row.groups.flatMap((group) => group.cues);
  if (cues.some((cue) => cue.ruleId.startsWith("syntax-"))) return SYNTAX_NOTE;
  return [...new Set(cues.map((cue) => cue.summary))].join(" ") || null;
}

// The selected file's cues, grouped by rule, each with its byte range and a one-line excerpt.
// `inline` is the version that follows the selected row on narrow screens.
export function FileDetail({
  row,
  inline = false,
}: {
  row: FileRow;
  inline?: boolean;
}) {
  const digest = (
    <span className="digest">
      sha256 <code>{row.sha256.slice(0, 8)}…</code>
    </span>
  );
  const note = footNote(row);
  const Heading = inline ? "h3" : "h2";
  const GroupHeading = inline ? "h4" : "h3";
  return (
    <>
      {inline ? (
        <p className="file-detail__meta">
          <span>{facts(row, true)}</span>
          {digest}
        </p>
      ) : (
        <header className="report-card__header detail-card__header">
          <div className="detail-card__title-row">
            <Heading className="detail-card__title">
              <code>{row.path}</code>
            </Heading>
            {digest}
          </div>
          <p className="report-card__sub">{facts(row)}</p>
        </header>
      )}
      {row.groups.length ? (
        <div
          className="cue-groups"
          style={{ "--range-ch": row.rangeChars } as React.CSSProperties}
        >
          {row.groups.map((group) => (
            <section key={group.ruleId} className="cue-group">
              <GroupHeading className="cue-group__head">
                <CueMark quiet={group.kind === "other"} />
                <span className="cue-group__name">{group.label}</span>
                <code className="cue-group__rule">{group.ruleId}</code>
              </GroupHeading>
              <ol className="cue-list">
                {group.cues.map((cue, index) => (
                  <li key={index} className="cue-code">
                    <code className="cue-code__range">
                      {cue.range ? `${cue.range[0]}–${cue.range[1]}` : "–"}
                    </code>
                    <code
                      className="cue-code__excerpt"
                      title={cue.excerpt ?? undefined}
                    >
                      {cue.excerpt ?? "Excerpt not retained"}
                    </code>
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>
      ) : (
        <p className="detail-empty">{emptyText(row)}</p>
      )}
      {note ? <p className="detail-card__foot">{note}</p> : null}
    </>
  );
}
