import type { RegistryRecord } from "@/lib/registry.ts";
import { formatBytes, formatCount, repoLabel, shortSha } from "@/lib/report.ts";

export function RecordPanel({
  record,
  label = "npm registry",
  compareCount,
  files,
}: {
  record: RegistryRecord;
  label?: string;
  compareCount?: number;
  files?: string[];
}) {
  const spec = `${record.name}@${record.version}`;
  return (
    <div
      className="ui ui-record"
      data-ui
      aria-label={`Registry record for ${spec}`}
      role="group"
    >
      <div className="ui-head">
        <span className="ui-title">
          <code>{spec}</code>
        </span>
        <span className="ui-meta">{label}</span>
      </div>
      <dl className="ui-kv">
        <div>
          <dt>Publisher</dt>
          <dd>{record.publisher ?? <span className="ui-dash">–</span>}</dd>
        </div>
        <div>
          <dt>Files in tarball</dt>
          <dd className="num">
            {record.fileCount === null ? "–" : formatCount(record.fileCount)}
          </dd>
        </div>
        <div>
          <dt>Unpacked</dt>
          <dd className="num">
            {record.unpackedSize === null
              ? "–"
              : formatBytes(record.unpackedSize)}
          </dd>
        </div>
        <div>
          <dt>Integrity</dt>
          <dd>
            {record.integrity ? (
              <code title={record.integrity}>
                {record.integrity.slice(0, 22)}…
              </code>
            ) : (
              <span className="ui-dash">–</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Runs on install</dt>
          <dd>
            {record.installScripts.length === 0 && !record.native ? (
              "Nothing"
            ) : (
              <span className="ui-flag">
                {record.installScripts.map((s) => (
                  <code key={s.hook}>
                    {s.hook}: {s.command}
                  </code>
                ))}
                {record.native ? <code>node-gyp rebuild</code> : null}
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt>Provenance</dt>
          <dd>
            {record.provenance ? "Signed build statement" : "None published"}
          </dd>
        </div>
      </dl>
      <div className="ui-claim">
        <p className="ui-claim-label">Claims to be built from</p>
        {record.repository && record.gitHead ? (
          <p className="ui-claim-value">
            <a
              href={`${record.repository}/tree/${record.gitHead}`}
              rel="noreferrer"
            >
              <code>{repoLabel(record.repository)}</code>
              <span className="ui-at">at</span>
              <code>{shortSha(record.gitHead)}</code>
            </a>
          </p>
        ) : record.repository ? (
          <p className="ui-claim-value ui-warn">
            <code>{repoLabel(record.repository)}</code>, no commit recorded. A
            comparison would have to guess the revision and is marked uncertain.
          </p>
        ) : (
          <p className="ui-claim-value ui-warn">
            No repository listed. There is no source to compare against.
          </p>
        )}
        {compareCount !== undefined && record.gitHead ? (
          <p className="ui-claim-note">
            {formatCount(record.fileCount ?? 0)} published files against{" "}
            {formatCount(compareCount)} files at {shortSha(record.gitHead)}
          </p>
        ) : null}
      </div>
      {files ? (
        <div className="ui-files">
          <p className="ui-claim-label">Tarball contents</p>
          <ul>
            {files.map((path) => (
              <li key={path}>
                <code>
                  <span className="ui-at">package/</span>
                  {path}
                </code>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
