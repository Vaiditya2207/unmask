"use client";

import { useMemo, useState } from "react";
import type { PackageFile } from "@/lib/report.ts";
import { formatBytes, statusLabel } from "@/lib/report.ts";

function explain(file: PackageFile) {
  const e = file.explanation;
  if (e.kind === "identical")
    return <span className="faint">Same bytes at the same path</span>;
  if (e.kind === "build")
    return (
      <>
        From <code>{e.from}</code> by <code>{e.step}</code>
        <span className="faint">. {e.detail}</span>
      </>
    );
  return (
    <a className="row-link" href={`#${e.findingId}`}>
      See the evidence
    </a>
  );
}

export function FileTable({ files }: { files: PackageFile[] }) {
  const [query, setQuery] = useState("");
  const shown = useMemo(
    () =>
      files.filter((f) =>
        f.path.toLowerCase().includes(query.trim().toLowerCase()),
      ),
    [files, query],
  );
  return (
    <section className="card" aria-labelledby="files-title">
      <div className="card-head">
        <h2 id="files-title">
          Published files{" "}
          <span className="faint num">
            {shown.length === files.length
              ? files.length
              : `${shown.length} of ${files.length}`}
          </span>
        </h2>
        <label className="search">
          <span className="visually-hidden">Filter by path</span>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <circle
              cx="7"
              cy="7"
              r="5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <path d="m11 11 3.5 3.5" stroke="currentColor" strokeWidth="1.5" />
          </svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by path"
          />
        </label>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Path</th>
            <th scope="col">Status</th>
            <th scope="col">Explanation</th>
            <th scope="col" className="num">
              Published
            </th>
            <th scope="col" className="num">
              In source
            </th>
          </tr>
        </thead>
        <tbody>
          {shown.map((file) => (
            <tr
              key={file.path}
              data-review={
                file.explanation.kind === "unexplained" ? "" : undefined
              }
            >
              <th scope="row">
                <code>{file.path}</code>
              </th>
              <td>
                {file.explanation.kind === "unexplained" ? (
                  <span className="pill pill-negative">
                    {statusLabel.unexplained}
                  </span>
                ) : (
                  <span className="status-text">
                    {statusLabel[file.explanation.kind]}
                  </span>
                )}
              </td>
              <td className="explain">{explain(file)}</td>
              <td className="num">{formatBytes(file.bytes)}</td>
              <td className="num">
                {file.sourceBytes === null ? (
                  <span className="faint">–</span>
                ) : (
                  formatBytes(file.sourceBytes)
                )}
              </td>
            </tr>
          ))}
          {shown.length === 0 ? (
            <tr>
              <td colSpan={5} className="empty">
                No published file matches “{query}”.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </section>
  );
}
