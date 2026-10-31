"use client";

import { useState } from "react";
import { RecordPanel } from "@/components/ui/RecordPanel";
import { CopyButton } from "@/components/home/CopyButton";
import {
  lookupRelease,
  parseSpec,
  type RegistryRecord,
} from "@/lib/registry.ts";
import { repoLabel, shortSha } from "@/lib/report.ts";

const picks = ["esbuild@0.28.2", "@sigstore/core@4.0.1", "left-pad@1.3.0"];

function commands(record: RegistryRecord) {
  const spec = `${record.name}@${record.version}`;
  const lines = [`npm pack ${spec} --ignore-scripts`];
  if (record.repository && record.gitHead) {
    const dir = repoLabel(record.repository).split("/").pop() ?? "source";
    lines.push(`git clone ${record.repository}.git`);
    lines.push(`git -C ${dir} checkout ${shortSha(record.gitHead, 12)}`);
  } else {
    lines.push("# no commit recorded: the source revision is a guess");
  }
  return lines.join("\n");
}

export function HowItWorks({
  initialQuery,
  initialRecord,
  initialError,
  sourceCount,
  map,
  evidence,
}: {
  initialQuery: string;
  initialRecord: RegistryRecord | null;
  initialError: string | null;
  sourceCount: number;
  map: React.ReactNode;
  evidence: React.ReactNode;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [record, setRecord] = useState(initialRecord);
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);

  async function look(value: string) {
    const spec = parseSpec(value);
    if (!spec.ok) {
      setError(spec.error);
      return;
    }
    setBusy(true);
    setError(null);
    const result = await lookupRelease(spec.name, spec.version);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setRecord(result.record);
    setQuery(`${result.record.name}@${result.record.version}`);
    const url = new URL(window.location.href);
    url.searchParams.set(
      "release",
      `${result.record.name}@${result.record.version}`,
    );
    window.history.replaceState(null, "", `${url.pathname}${url.search}#how`);
  }

  const isSample = record?.name === "clsx" && record.version === "2.1.1";
  const shown = record ? `${record.name}@${record.version}` : query;

  return (
    <ol className="exchanges">
      <li className="exchange" data-part style={{ ["--part" as string]: 1 }}>
        <p className="exchange-say">First, name an exact release.</p>
        <p className="exchange-text">
          UNMASK starts from the registry&rsquo;s own record of a release: what
          the tarball holds, what runs when it installs, and the commit it says
          it was built from. Look one up here; the record comes live from
          registry.npmjs.org.
        </p>
        <form
          className="call call-form"
          action="/"
          method="get"
          onSubmit={(event) => {
            event.preventDefault();
            look(query);
          }}
        >
          <label htmlFor="release">Package and version</label>
          <div className="call-row">
            <input
              id="release"
              name="release"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={300}
              aria-describedby={error ? "release-error" : undefined}
              aria-invalid={error ? true : undefined}
            />
            <button type="submit" className="call-submit" disabled={busy}>
              {busy ? "Looking…" : "Look up"}
            </button>
          </div>
          <p className="call-picks">
            Or try{" "}
            {picks.map((pick, i) => (
              <span key={pick}>
                <button type="button" onClick={() => look(pick)}>
                  <code>{pick}</code>
                </button>
                {i < picks.length - 1 ? ", " : null}
              </span>
            ))}
          </p>
        </form>
        <div className="response" aria-live="polite" aria-busy={busy}>
          {error ? (
            <p className="response-error" id="release-error" role="alert">
              {error}
            </p>
          ) : null}
          {record ? (
            <div className={busy ? "is-busy" : undefined}>
              <RecordPanel
                record={record}
                label="Live from registry.npmjs.org"
                compareCount={isSample ? sourceCount : undefined}
              />
            </div>
          ) : null}
        </div>
      </li>

      <li className="exchange" data-part style={{ ["--part" as string]: 2 }}>
        <p className="exchange-say">
          Then UNMASK fetches both sides, and runs neither.
        </p>
        <p className="exchange-text">
          The tarball is unpacked as data and the repository is checked out at
          that commit. No install script, build script or test is executed. Each
          published file is then set beside the source file it came from.
        </p>
        <div className="call call-code">
          <pre>
            <code>
              {record ? commands(record) : `npm pack ${shown} --ignore-scripts`}
            </code>
          </pre>
          <CopyButton
            text={
              record ? commands(record) : `npm pack ${shown} --ignore-scripts`
            }
          />
        </div>
        <div className="response">
          {map}
          <p className="response-note">
            {isSample ? "Map" : "Map shown for clsx@2.1.1"}: every published
            file set level with the source file it came from.
          </p>
        </div>
      </li>

      <li
        className="exchange exchange-final"
        data-part
        style={{ ["--part" as string]: 3 }}
      >
        <p className="exchange-say">
          Last, every difference gets its evidence.
        </p>
        <p className="exchange-text">
          A file that matches byte for byte needs no argument. Every other file
          is evidence to review: its bytes, the checks run on them and a
          model&rsquo;s hypothesis, kept apart from the facts.
        </p>
        <form className="call call-form" action="/check" method="post">
          <label htmlFor="check-from-how">Check this release</label>
          <div className="call-row">
            <input
              id="check-from-how"
              name="package"
              value={shown}
              readOnly
              aria-readonly="true"
            />
            <button type="submit" className="call-submit">
              Check release
            </button>
          </div>
        </form>
        <div className="response response-wide">
          {evidence}
          <p className="response-note">
            From the <a href="/r/sample">sample report</a>: the real clsx@2.1.1
            with 152 bytes added to one file.
          </p>
        </div>
      </li>
    </ol>
  );
}
