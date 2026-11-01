import type { RegistryRecord } from "@/lib/registry.ts";

const count = new Intl.NumberFormat("en-GB");
const repoLabel = (url: string) =>
  url.replace(/^https?:\/\//, "").replace(/\.git$/, "");

// The registry's answer for one release, as the lookup shows it. Styles live in
// app/home.css under .record.
export function RecordPanel({
  record,
  live,
}: {
  record: RegistryRecord;
  live: boolean;
}) {
  const spec = `${record.name}@${record.version}`;
  const source = `${live ? "live from" : "from"} registry.npmjs.org`;
  const runs = [
    ...record.installScripts.map((s) => `${s.hook}: ${s.command}`),
    ...(record.native ? ["node-gyp rebuild"] : []),
  ];

  return (
    <article className="record" data-ui aria-label={`${spec}, ${source}`}>
      <div className="record-head">
        <span className="record-title">{spec}</span>
        <span className="record-source">· {source}</span>
      </div>
      <dl className="record-rows">
        <div className="record-row">
          <dt className="record-key">Publisher</dt>
          <dd className="record-value">{record.publisher ?? "Not recorded"}</dd>
        </div>
        <div className="record-row">
          <dt className="record-key">Files in tarball</dt>
          <dd className="record-value num">
            {record.fileCount === null
              ? "Not recorded"
              : count.format(record.fileCount)}
          </dd>
        </div>
        <div className="record-row">
          <dt className="record-key">Unpacked</dt>
          <dd className="record-value num">
            {record.unpackedSize === null
              ? "Not recorded"
              : `${count.format(record.unpackedSize)} B`}
          </dd>
        </div>
        <div className="record-row">
          <dt className="record-key">Integrity</dt>
          <dd className="record-value">
            {record.integrity ? (
              <code title={record.integrity}>
                {record.integrity.slice(0, 22)}…
              </code>
            ) : (
              "Not recorded"
            )}
          </dd>
        </div>
        <div className="record-row">
          <dt className="record-key">Runs on install</dt>
          <dd className="record-value">
            {runs.length === 0 ? (
              "Nothing"
            ) : (
              <span className="record-flag">
                {runs.map((line) => (
                  <code key={line}>{line}</code>
                ))}
              </span>
            )}
          </dd>
        </div>
        <div className="record-row">
          <dt className="record-key">Provenance</dt>
          <dd className="record-value">
            {record.provenance ? "Signed build statement" : "None published"}
          </dd>
        </div>
        <div className="record-row">
          <dt className="record-key">Claims to be built from</dt>
          <dd className="record-value">
            {record.repository && record.gitHead ? (
              <a
                className="record-link"
                href={`${record.repository}/tree/${record.gitHead}`}
                rel="noreferrer"
              >
                <code>{repoLabel(record.repository)}</code> at{" "}
                <code>{record.gitHead.slice(0, 7)}</code>
              </a>
            ) : record.repository ? (
              <>
                <code>{repoLabel(record.repository)}</code>, with no commit
                recorded
              </>
            ) : (
              "No repository listed"
            )}
          </dd>
        </div>
      </dl>
    </article>
  );
}
