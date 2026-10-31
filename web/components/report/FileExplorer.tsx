"use client";

import { Fragment, useState } from "react";
import type { FileRow, Tab } from "@/lib/report.ts";
import { formatCount } from "@/lib/report.ts";
import { Bytes, StatePill } from "@/components/report/parts";
import { FileDetail } from "@/components/report/FileDetail";

type TabId = Tab["id"];

const inTab = (rows: FileRow[], tab: TabId) =>
  tab === "all" ? rows : rows.filter((row) => row.state === tab);

// Keep the selection when it is in view; otherwise take the filtered file with the most cues
// (rows arrive sorted, so that is the first with the highest count).
function choose(rows: FileRow[], tab: TabId, key: string | null) {
  const shown = inTab(rows, tab);
  if (shown.some((row) => row.key === key)) return key;
  if (shown.length === 0) return key;
  const most = Math.max(...shown.map((row) => row.cueCount));
  return shown.find((row) => row.cueCount === most)?.key ?? key;
}

function href(tab: TabId, key: string | null) {
  const query = new URLSearchParams();
  if (key) query.set("file", key);
  if (tab !== "all") query.set("show", tab);
  return `?${query}#files`;
}

export function FileExplorer({
  rows,
  tabs,
  defaultKey,
  initialKey,
  initialTab,
}: {
  rows: FileRow[];
  tabs: Tab[];
  defaultKey: string | null;
  initialKey?: string;
  initialTab?: string;
}) {
  const startTab = tabs.find((t) => t.id === initialTab)?.id ?? "all";
  const startKey = rows.some((row) => row.key === initialKey)
    ? (initialKey ?? null)
    : defaultKey;
  const [tab, setTab] = useState<TabId>(startTab);
  const [key, setKey] = useState<string | null>(() =>
    choose(rows, startTab, startKey),
  );

  const shown = inTab(rows, tab);
  const selected = rows.find((row) => row.key === key) ?? null;
  const index = shown.findIndex((row) => row.key === key);
  const shownBytes = shown.reduce((sum, row) => sum + row.size, 0);

  function go(event: React.MouseEvent, nextTab: TabId, nextKey: string | null) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    const chosen = choose(rows, nextTab, nextKey);
    setTab(nextTab);
    setKey(chosen);
    window.history.replaceState(null, "", href(nextTab, chosen));
  }

  return (
    <div className="evidence-row" id="files">
      <section className="report-card files-card" aria-labelledby="files-title">
        <header className="report-card__header">
          <h2 className="report-card__title" id="files-title">
            Published files
          </h2>
          <p className="report-card__sub">
            Every file in the npm tarball, unexplained first
          </p>
        </header>
        <nav className="files-tabs" aria-label="Filter files">
          <ul className="files-tabs__list">
            {tabs.map((t) => (
              <li key={t.id}>
                <a
                  className={`files-tab${t.id === tab ? " files-tab--active" : ""}`}
                  href={href(t.id, key)}
                  aria-current={t.id === tab ? "true" : undefined}
                  onClick={(event) => go(event, t.id, key)}
                >
                  {t.label}{" "}
                  <span className="files-tab__count">
                    {formatCount(t.count)}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <table className="files-table">
          <caption className="visually-hidden">
            Published files
            {tab === "all"
              ? ""
              : `, ${tabs.find((t) => t.id === tab)?.label.toLowerCase()}`}
            . Choose a path to see its evidence.
          </caption>
          <thead>
            <tr>
              <th scope="col" className="col-path">
                Path
              </th>
              <th scope="col" className="col-state">
                State
              </th>
              <th scope="col" className="col-size col-num">
                Size
              </th>
              <th scope="col" className="col-cues col-num">
                Cues
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => {
              const isSelected = row.key === key;
              return (
                <Fragment key={row.key}>
                  <tr
                    className={`file-row${isSelected ? " file-row--selected" : ""}`}
                    onClick={(event) => {
                      if ((event.target as HTMLElement).closest("a")) return;
                      go(event, tab, row.key);
                    }}
                  >
                    <th scope="row" className="file-row__cell">
                      <div className="file-row__line">
                        <a
                          className="file-row__link"
                          href={href(tab, row.key)}
                          aria-current={isSelected ? "true" : undefined}
                          aria-controls="file-detail"
                          onClick={(event) => go(event, tab, row.key)}
                        >
                          <code>{row.path}</code>
                        </a>
                        {row.note ? (
                          <span className="file-row__note">{row.note}</span>
                        ) : null}
                        <StatePill row={row} className="file-row__pill" />
                      </div>
                      <p className="file-row__facts">
                        <span className="file-row__size">
                          <Bytes value={row.size} />
                        </span>
                        <span className="file-row__sep" aria-hidden="true">
                          ·
                        </span>
                        <span>
                          Cues{" "}
                          {row.cueCount ? (
                            <strong>{formatCount(row.cueCount)}</strong>
                          ) : (
                            "–"
                          )}
                        </span>
                        {row.note ? (
                          <>
                            <span className="file-row__sep" aria-hidden="true">
                              ·
                            </span>
                            <span>{row.note}</span>
                          </>
                        ) : null}
                      </p>
                    </th>
                    <td className="col-state">
                      <StatePill row={row} />
                    </td>
                    <td className="col-size col-num">
                      <Bytes value={row.size} />
                    </td>
                    <td
                      className={`col-cues col-num${row.cueCount ? "" : " file-row__none"}`}
                    >
                      {row.cueCount ? formatCount(row.cueCount) : "–"}
                    </td>
                  </tr>
                  {isSelected ? (
                    <tr className="detail-row">
                      <td colSpan={4}>
                        <div className="file-detail">
                          <FileDetail row={row} inline />
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
            {shown.length === 0 ? (
              <tr>
                <td colSpan={4} className="files-empty">
                  No published file is in this group.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <footer className="files-total">
          <span className="files-total__label">
            {shown.length === rows.length
              ? `${formatCount(rows.length)} files`
              : `${formatCount(shown.length)} of ${formatCount(rows.length)} files`}
          </span>
          <span className="files-total__size">
            <Bytes value={shownBytes} />
          </span>
          <span className="files-total__cues" />
        </footer>
      </section>
      {selected ? (
        <aside
          className="report-card detail-card"
          id="file-detail"
          aria-label={`Selected file: ${selected.path}`}
          style={{ "--row": index } as React.CSSProperties}
        >
          {index >= 0 ? (
            <span className="detail-card__pointer" aria-hidden="true" />
          ) : null}
          <FileDetail row={selected} />
        </aside>
      ) : null}
    </div>
  );
}
