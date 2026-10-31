"use client";

import { useRef, useState } from "react";
import { RecordPanel } from "@/components/ui/RecordPanel";
import {
  lookupRelease,
  parseSpec,
  type RegistryRecord,
} from "@/lib/registry.ts";

// The lookup: its headline is the input. With script the record is fetched from
// registry.npmjs.org in the browser; without it the form is a GET to
// /?release=name@version, which the page renders on the server.
export function Lookup({
  initialQuery,
  initialRecord,
  initialLive,
  initialError,
  examples,
}: {
  initialQuery: string;
  initialRecord: RegistryRecord;
  initialLive: boolean;
  initialError: string | null;
  examples: readonly string[];
}) {
  const [query, setQuery] = useState(initialQuery);
  const [record, setRecord] = useState(initialRecord);
  const [live, setLive] = useState(initialLive);
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);
  const latest = useRef(0);

  const shown = `${record.name}@${record.version}`;
  const dirty = query.trim() !== shown;

  async function look(value: string) {
    const spec = parseSpec(value);
    if (!spec.ok) {
      setError(spec.error);
      return;
    }
    const id = ++latest.current;
    setBusy(true);
    setError(null);
    const result = await lookupRelease(spec.name, spec.version);
    if (id !== latest.current) return;
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    const found = `${result.record.name}@${result.record.version}`;
    setRecord(result.record);
    setLive(true);
    setQuery(found);
    const url = new URL(window.location.href);
    url.searchParams.set("release", found);
    window.history.replaceState(
      null,
      "",
      `${url.pathname}${url.search}#lookup`,
    );
  }

  return (
    <div className="lookup-tool" data-ui>
      <form
        className="lookup-form"
        action="/#lookup"
        method="get"
        data-part
        style={{ ["--part" as string]: 1 }}
        onSubmit={(event) => {
          event.preventDefault();
          look(query);
        }}
      >
        <span
          className="lookup-line"
          style={{ ["--chars" as string]: Math.max(10, query.length) }}
        >
          <span className="lookup-field" data-value={query || " "}>
            <input
              id="lookup-release"
              className="lookup-input"
              name="release"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              size={1}
              maxLength={300}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              enterKeyHint="search"
              aria-describedby={
                error ? "lookup-note lookup-error" : "lookup-note"
              }
              aria-invalid={error ? true : undefined}
            />
          </span>
          <span className="lookup-caret" aria-hidden="true" />
        </span>
        <button
          type="submit"
          className="button lookup-submit"
          data-dirty={dirty ? "" : undefined}
        >
          {busy ? "Looking up…" : `Look up ${query.trim() || "a release"}`}
        </button>
        {error ? (
          <p className="lookup-error" id="lookup-error" role="alert">
            {error}
          </p>
        ) : null}
      </form>

      <div
        className="lookup-aside"
        data-part
        style={{ ["--part" as string]: 2 }}
      >
        <p className="lookup-note" id="lookup-note">
          Any public npm release, read live from the registry.
        </p>
        <div className="lookup-examples">
          {examples.map((pick) => (
            <button
              key={pick}
              type="button"
              className="lookup-example"
              data-current={live && shown === pick ? "" : undefined}
              onClick={() => {
                setQuery(pick);
                look(pick);
              }}
            >
              {pick}
            </button>
          ))}
        </div>
      </div>

      <div
        className="lookup-answer"
        aria-live="polite"
        aria-busy={busy}
        data-part
        style={{ ["--part" as string]: 3 }}
      >
        <RecordPanel key={shown} record={record} live={live} />
      </div>
    </div>
  );
}
