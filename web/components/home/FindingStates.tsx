"use client";

import { useState } from "react";
import type { Finding } from "@/lib/report.ts";
import { formatBytes } from "@/lib/report.ts";
import { CopyButton } from "@/components/home/CopyButton";
import { Mark } from "@/components/ui/Mark";

type State = "found" | "open" | "checked";

function Row({
  finding,
  state,
  onCheck,
}: {
  finding: Finding;
  state: State;
  onCheck?: () => void;
}) {
  const extra = finding.extra.end - finding.extra.start;
  const hypothesis = finding.hypothesis;
  return (
    <div
      className={`ui ui-row${state === "open" ? " is-hover" : ""}`}
      data-ui
      role="group"
      aria-label={`${finding.path}, ${state}`}
    >
      <div className="ui-row-main">
        <span className="ui-row-path">
          <code>{finding.path}</code>
          <span>
            Only in the package, {formatBytes(extra)} no build step produces
          </span>
        </span>
        <span className="ui-row-bytes num">
          {formatBytes(finding.published.bytes)}
        </span>
        <span className="pill pill-negative">Needs review</span>
      </div>
      {state === "open" ? (
        <div className="ui-row-actions">
          <a className="ui-btn" href={`/r/sample#${finding.id}`}>
            Show diff
          </a>
          <button
            type="button"
            className="ui-btn ui-btn-primary"
            onClick={onCheck}
          >
            Check the hypothesis
          </button>
          <CopyButton
            text={JSON.stringify(finding, null, 2)}
            label="Copy evidence"
          />
        </div>
      ) : null}
      {state === "checked" && hypothesis ? (
        <div className="ui-row-result">
          <p>{hypothesis.text}</p>
          <p className="ui-row-checks">
            <span>
              <Mark ok /> Cited bytes {hypothesis.citedBytes[0]}–
              {hypothesis.citedBytes[1]} exist
            </span>
            <span>
              <Mark ok /> Parser finds require(&quot;https&quot;)
            </span>
            <span>
              <Mark ok /> Parser finds process.env
            </span>
          </p>
          <p className="ui-meta">
            Still needs review. UNMASK never marks a release safe.
          </p>
        </div>
      ) : null}
    </div>
  );
}

export function FindingStates({ finding }: { finding: Finding }) {
  const [checked, setChecked] = useState(false);
  const states: { word: string; state: State; live?: boolean }[] = [
    { word: "Found", state: "found" },
    { word: "Opened", state: checked ? "checked" : "open", live: true },
    { word: "Checked", state: "checked" },
  ];
  return (
    <ol className="states">
      {states.map((s, i) => (
        <li
          key={s.word}
          className="state"
          data-part
          style={{ ["--part" as string]: i + 1 }}
        >
          <p className="state-word">{s.live && checked ? "Checked" : s.word}</p>
          <div className="state-row">
            <Row
              finding={finding}
              state={s.state}
              onCheck={s.live ? () => setChecked(true) : undefined}
            />
            {s.live && checked ? (
              <button
                type="button"
                className="state-reset"
                onClick={() => setChecked(false)}
              >
                Back to opened
              </button>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
