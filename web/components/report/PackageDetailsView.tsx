import type { ReactNode } from "react";
import {
  type DetailList,
  type DetailRecord,
  type PackageDetails,
  record,
  text,
  count,
  status,
  preview,
} from "@/lib/package-details.ts";
import {
  formatCount,
  formatUtc,
  ruleLabel,
  stateLabel,
  type FileState,
} from "@/lib/report.ts";
import {
  parseVulnerabilityCheck,
  safeHttps,
  type VulnerabilityCheck,
} from "@/lib/vulnerabilities.ts";

// The analyzer's package-details projection (GET /r/<id>.details.json), set on the report sheet under the
// comparison. Every value comes from the projection or the stored OSV lookup; lists keep their own limits and
// omission counts, and anything clipped for display stays in the JSON download. This module imports only
// from lib/ so its test can render it on its own.

const ROWS = 30;
const number = (value: unknown) => {
  const n = count(value);
  return n === null ? "Not recorded" : formatCount(n);
};
const rows = (list: DetailList, limit = ROWS) =>
  list.items.slice(0, limit).map(record);
const ids = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
const isState = (value: unknown): value is FileState =>
  typeof value === "string" && Object.hasOwn(stateLabel, value);
const when = (value: unknown) =>
  typeof value === "string" ? formatUtc(value) || text(value, 64) : text(value);

// The evidence IDs every row shares (manifest fields and scripts all cite the manifest), so they can be
// listed once under the table instead of on every row. Null when the rows differ.
function shared(items: DetailRecord[], key = "evidenceIds"): string[] | null {
  if (!items.length) return null;
  const first = JSON.stringify(ids(items[0][key]));
  return items.every((item) => JSON.stringify(ids(item[key])) === first)
    ? ids(items[0][key])
    : null;
}

function Size({ value }: { value: unknown }) {
  const n = count(value);
  if (n === null) return <>Not recorded</>;
  return (
    <>
      {formatCount(n)}
      <span className="byte-unit">B</span>
    </>
  );
}

// A declared list of strings (keywords, os, cpu, files) reads as a list, not as numbered keys.
const declaredValue = (value: unknown) =>
  Array.isArray(value) && value.every((item) => typeof item === "string")
    ? text(value.join(", "), 600)
    : preview(value);

// A value as recorded, in code; a missing one in words.
function Value({ value, className }: { value: unknown; className?: string }) {
  if (value === undefined || value === null)
    return <span className="pkg-faint">{preview(value)}</span>;
  return <code className={className}>{preview(value)}</code>;
}

// Says how much of a bounded list is on the page. A list with nothing withheld and at most one entry
// needs no note; anything the API omitted or this page cut is always said.
function ListNote({
  list,
  limit = ROWS,
}: {
  list: DetailList;
  limit?: number;
}) {
  if (list.omitted === 0 && list.returned <= limit && list.total <= 1)
    return null;
  return (
    <p className="pkg-limit">
      Showing {formatCount(Math.min(list.returned, limit))} of{" "}
      {number(list.total)} recorded entries.
      {list.omitted > 0
        ? ` The API omitted ${number(list.omitted)} (${Object.keys(
            list.omissionReasons,
          )
            .slice(0, 4)
            .map(status)
            .join(", ")}).`
        : ""}
      {list.returned > limit
        ? ` This page limits the view to ${limit}; download details for the returned rows.`
        : ""}
    </p>
  );
}

function Card({
  id,
  title,
  sub,
  aside,
  children,
}: {
  id: string;
  title: string;
  sub?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      className="report-card pkg-card"
      id={id}
      aria-labelledby={`${id}-title`}
    >
      <header className="report-card__header pkg-card__header">
        <div className="pkg-card__heading">
          <h3 className="report-card__title" id={`${id}-title`}>
            {title}
          </h3>
          {sub ? <p className="report-card__sub">{sub}</p> : null}
        </div>
        {aside}
      </header>
      <div className="pkg-card__body">{children}</div>
    </section>
  );
}

// Fixed layout: `widths` sets each column (CSS lengths, "" for the column that takes the rest), so paths
// wrap in their own column instead of squeezing their neighbours. Compact tables keep their columns on a
// phone; the others become one block per row there.
function Table({
  label,
  headings,
  widths,
  numeric = [],
  compact = false,
  children,
}: {
  label: string;
  headings: string[];
  widths: string[];
  numeric?: number[];
  compact?: boolean;
  children: ReactNode;
}) {
  return (
    <table className={`pkg-table${compact ? " pkg-table--compact" : ""}`}>
      <caption className="visually-hidden">{label}</caption>
      <colgroup>
        {headings.map((heading, i) => (
          <col
            key={heading}
            style={widths[i] ? { width: widths[i] } : undefined}
          />
        ))}
      </colgroup>
      <thead>
        <tr>
          {headings.map((heading, i) => (
            <th
              key={heading}
              scope="col"
              className={numeric.includes(i) ? "pkg-num" : undefined}
            >
              {heading}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

function Fact({
  label,
  wide = false,
  children,
}: {
  label: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`pkg-fact${wide ? " pkg-fact--wide" : ""}`}>
      <dt className="pkg-fact__label">{label}</dt>
      <dd className="pkg-fact__value">{children}</dd>
    </div>
  );
}

function More({
  summary,
  aside,
  open = false,
  children,
}: {
  summary: ReactNode;
  aside?: ReactNode;
  open?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="pkg-more" open={open}>
      <summary className="pkg-more__summary">
        <svg
          className="pkg-more__chevron"
          width="12"
          height="12"
          viewBox="0 0 12 12"
          aria-hidden="true"
        >
          <path d="M3 4.5 6 7.5l3-3" />
        </svg>
        <span className="pkg-more__label">{summary}</span>
        {aside ? <span className="pkg-more__aside">{aside}</span> : null}
      </summary>
      <div className="pkg-more__body">{children}</div>
    </details>
  );
}

function Pill({ state, signal }: { state: unknown; signal: boolean }) {
  if (!isState(state)) return <>{status(state)}</>;
  return (
    <span
      className={`state-pill ${signal ? "state-pill--signal" : "state-pill--neutral"}`}
    >
      {stateLabel[state]}
    </span>
  );
}

const VULNERABILITY: Record<
  VulnerabilityCheck["status"],
  { lead: string; pill: string; cell: string }
> = {
  "not-assessed": {
    lead: "No vulnerability lookup was recorded for this check.",
    pill: "Not looked up",
    cell: "Not looked up",
  },
  "none-reported": {
    lead: "OSV reported no advisories for this exact package/version at the recorded time. This is not a safety verdict or proof that vulnerabilities do not exist.",
    pill: "None reported",
    cell: "None reported",
  },
  found: {
    lead: "OSV returned known advisory records for this exact package/version.",
    pill: "Advisories found",
    cell: "Found",
  },
  incomplete: {
    lead: "The OSV lookup is incomplete. Returned advisory records are partial; no complete result is available.",
    pill: "Incomplete",
    cell: "Lookup incomplete",
  },
  unavailable: {
    lead: "The OSV lookup is unavailable. No conclusion about known vulnerabilities is available.",
    pill: "Unavailable",
    cell: "Lookup unavailable",
  },
};

const STAGES: [string, string][] = [
  ["inventory", "Inventory"],
  ["compared", "Compared"],
  ["unresolved", "Unresolved"],
  ["syntaxInspected", "Syntax inspected"],
  ["modelReviewed", "Model reviewed"],
];

const NAV: [string, string][] = [
  ["vulnerabilities", "Vulnerabilities"],
  ["declarations", "Declarations"],
  ["scripts", "Scripts"],
  ["entrypoints", "Entry points"],
  ["dependencies", "Dependencies"],
  ["inventory", "Files"],
  ["observations", "Behavior"],
  ["source", "Provenance"],
  ["advisory", "AI advice"],
  ["coverage", "Coverage"],
  ["not-assessed", "Limits"],
];

// Fields whose declared string reads as prose rather than as an identifier or a path.
const PROSE = new Set(["description", "homepage", "license"]);

export function PackageDetailsView({
  details: d,
  id,
  analyzer,
  anchors,
  rawModel,
  evidencePaths,
}: {
  details: PackageDetails;
  id: string;
  analyzer: string;
  // Evidence ID → its positional anchor in the analyzer's evidence viewer.
  anchors: Map<string, string>;
  rawModel?: unknown;
  // Evidence ID → the published file it points into, when that file is in Published files on this page.
  evidencePaths?: Map<string, string>;
}) {
  const viewer = `${analyzer}/r/${id}`;
  const raw = `/api/reports/${id}`;
  const identity = record(d.identity.items[0]);
  const requested = record(identity.requested);
  const spec =
    typeof requested.name === "string" && typeof requested.version === "string"
      ? `${text(requested.name, 214)}@${text(requested.version, 100)}`
      : `Check ${id.slice(0, 8)}`;
  const vulnerability = parseVulnerabilityCheck(
    d.vulnerabilityCheck,
    requested,
  );
  const fields = rows(d.declarations.fields);
  const source = record(
    rows(d.provenance.facts).find((item) => item.field === "source")?.value,
  );
  const model = record(d.ai.metadata.items[0] ?? rawModel);
  const coverage = d.coverage.counters;

  // A published file carries the review signal on this sheet when it differs from the source and the
  // syntax check recorded capability references in it, as in Published files above.
  const cued = new Set<string>();
  for (const item of rows(d.capabilities.observations, 20000))
    for (const location of Array.isArray(item.locations) ? item.locations : [])
      if (record(location).side === "artifact")
        cued.add(String(record(location).path));
  const signal = (state: unknown, path: unknown) =>
    (state === "artifact-only" || state === "changed") &&
    typeof path === "string" &&
    cued.has(path);

  // `bare` drops the word "Evidence" where a column heading or the sentence already says it.
  function Refs({
    ids: value,
    bare = false,
  }: {
    ids: unknown;
    bare?: boolean;
  }) {
    const values = ids(value).slice(0, 6);
    if (!values.length)
      return <span className="pkg-faint">No evidence reference returned</span>;
    return (
      <span className="pkg-refs">
        {values.map((evidence, index) => {
          const path = evidencePaths?.get(evidence);
          const href = path
            ? `?${new URLSearchParams({ file: path })}#files`
            : `${viewer}${anchors.has(evidence) ? `#${anchors.get(evidence)}` : ""}`;
          return (
            <a
              key={index}
              className="pkg-ref"
              href={href}
              title={
                path
                  ? `${text(evidence, 512)} in ${text(path, 512)}`
                  : text(evidence, 512)
              }
            >
              {bare ? null : "Evidence "}
              <code>{text(evidence, 11)}</code>
            </a>
          );
        })}
        {Array.isArray(value) && value.length > 6 ? (
          <span className="pkg-faint">
            More references in{" "}
            <a className="pkg-link" href={raw}>
              raw report
            </a>
          </span>
        ) : null}
      </span>
    );
  }

  function SharedRefs({ items }: { items: DetailRecord[] }) {
    const common = shared(items);
    if (!common) return null;
    return (
      <p className="pkg-note pkg-pad">
        Every row cites the same evidence: <Refs ids={common} bare />
      </p>
    );
  }

  // Cues, annotations, failures and policy findings share one table: what it is, where, what was recorded.
  function Observations({ list, label }: { list: DetailList; label: string }) {
    const items = rows(list);
    if (list.total === 0)
      return (
        <p className="pkg-empty pkg-pad">
          No {label} recorded in this bounded result. This does not establish
          package-wide absence.
        </p>
      );
    const detail = (item: DetailRecord) =>
      text(item.summary ?? item.message ?? item.reason ?? item.status);
    // A sentence every row repeats is said once under the table; each row keeps its own facts.
    const sameDetail =
      items.length > 1 &&
      items.every((item) => detail(item) === detail(items[0]));
    const sameRefs = shared(items);
    return (
      <>
        {items.length ? (
          <Table
            label={label}
            headings={[
              "Reference",
              "Where",
              "Recorded",
              ...(sameRefs ? [] : ["Evidence"]),
            ]}
            widths={["24%", "28%", "", ...(sameRefs ? [] : ["22%"])]}
          >
            {items.map((item, index) => {
              const name = text(item.ruleId ?? item.type ?? item.code, 120);
              const kind =
                typeof item.ruleId === "string" ? ruleLabel(item.ruleId) : null;
              const places = Array.isArray(item.locations)
                ? item.locations.map(record)
                : [];
              const location =
                places.find((place) => place.side === "artifact") ??
                places[0] ??
                {};
              const path = item.path ?? location.path;
              const side = item.side ?? location.side;
              const range =
                Array.isArray(location.range) &&
                location.range.every((n) => count(n) !== null)
                  ? location.range
                  : null;
              return (
                <tr key={index}>
                  <th scope="row">
                    {kind && kind !== name ? (
                      <>
                        <span className="pkg-rule">
                          <span
                            className={`cue-mark${typeof item.ruleId === "string" && item.ruleId.startsWith("syntax-") ? "" : " cue-mark--quiet"}`}
                            aria-hidden="true"
                          />
                          {kind}
                        </span>
                        <code className="pkg-sub">{name}</code>
                      </>
                    ) : (
                      <code>{name}</code>
                    )}
                  </th>
                  <td data-label="Where">
                    {path ? (
                      <>
                        <code>{text(path)}</code>
                        {range ? (
                          <span className="pkg-range">
                            {" "}
                            {String(range[0])}–{String(range[1])}
                          </span>
                        ) : null}
                        {side === "source" ? (
                          <span className="pkg-range"> in the source</span>
                        ) : null}
                      </>
                    ) : (
                      <span className="pkg-faint">No path recorded</span>
                    )}
                  </td>
                  <td data-label="Recorded">
                    {sameDetail ? null : detail(item)}
                    {item.literalStatus ? (
                      <span className="pkg-sub">
                        Literal evidence: {status(item.literalStatus)}
                      </span>
                    ) : null}
                    {item.cueRef || item.annotationRef ? (
                      <span className="pkg-sub">
                        Raw report pointer{" "}
                        <code>
                          {text(item.cueRef ?? item.annotationRef, 120)}
                        </code>
                      </span>
                    ) : null}
                  </td>
                  {sameRefs ? null : (
                    <td data-label="Evidence">
                      <Refs ids={item.evidenceIds} bare />
                    </td>
                  )}
                </tr>
              );
            })}
          </Table>
        ) : null}
        {sameDetail || sameRefs ? (
          <p className="pkg-note pkg-pad">
            {sameDetail ? `Every row records: ${detail(items[0])} ` : null}
            {sameRefs ? (
              sameRefs.length ? (
                <>
                  Every row cites the same evidence:{" "}
                  <Refs ids={sameRefs} bare />
                </>
              ) : (
                "No evidence reference was returned for these rows."
              )
            ) : null}
          </p>
        ) : null}
        <ListNote list={list} />
      </>
    );
  }

  function Files({
    list,
    limit = ROWS,
    label,
  }: {
    list: DetailList;
    limit?: number;
    label: string;
  }) {
    return (
      <>
        <Table
          label={label}
          headings={["Path", "Size", "Correspondence", "Evidence"]}
          widths={["", "112px", "150px", "34%"]}
          numeric={[1]}
        >
          {rows(list, limit).map((file, index) => (
            <tr key={index}>
              <th scope="row">
                <code>{text(file.path ?? file.originalPath)}</code>
              </th>
              <td className="pkg-num" data-label="Size">
                <Size value={file.size} />
              </td>
              <td data-label="State">
                <Pill
                  state={file.state}
                  signal={signal(file.state, file.path)}
                />
              </td>
              <td data-label="Evidence">
                <Refs ids={file.evidenceIds} bare />
              </td>
            </tr>
          ))}
        </Table>
        <ListNote list={list} limit={limit} />
      </>
    );
  }

  function Groups({
    list,
    label,
    keyName,
  }: {
    list: DetailList;
    label: string;
    keyName: "extension" | "directory";
  }) {
    return (
      <div className="pkg-group">
        <h4 className="pkg-subtitle pkg-pad">{label}</h4>
        <Table
          label={label}
          headings={[
            keyName === "extension" ? "Extension" : "Directory",
            "Files",
            "Bytes",
          ]}
          widths={["", "88px", "128px"]}
          numeric={[1, 2]}
          compact
        >
          {rows(list).map((group, index) => (
            <tr key={index}>
              <th scope="row">
                <code>
                  {text(group[keyName], keyName === "extension" ? 80 : 600)}
                </code>
              </th>
              <td className="pkg-num">{number(group.files)}</td>
              <td className="pkg-num">
                <Size value={group.bytes} />
              </td>
            </tr>
          ))}
        </Table>
        <ListNote list={list} />
      </div>
    );
  }

  // ---------- Summary figures for the strip ----------

  const declared = (name: string) =>
    fields.find((field) => field.field === name);
  const license = declared("license");
  const targets = rows(d.entrypoints.targets, 20000);
  const matched = targets.filter(
    (target) => target.matchStatus === "exact-file-match",
  ).length;
  const category = (name: string) =>
    d.dependencies.categories.find((item) => item.field === name);
  const runtime = count(category("dependencies")?.declaredCount);
  const otherDeps = (
    [
      ["optionalDependencies", "optional"],
      ["peerDependencies", "peer"],
      ["devDependencies", "dev"],
    ] as const
  )
    .map(([name, word]) => {
      const n = count(category(name)?.declaredCount);
      return n ? `${formatCount(n)} ${word}` : null;
    })
    .filter(Boolean)
    .join(", ");
  const advisoryCount = vulnerability.advisories.length;
  const vulnerabilitySignal =
    vulnerability.status === "found" ||
    (vulnerability.status === "incomplete" && advisoryCount > 0);

  const strip = [
    {
      label: "License",
      value:
        license?.status === "declared"
          ? text(preview(license.value), 80)
          : license
            ? status(license.status)
            : "Not recorded",
      aside: null as string | null,
      signal: false,
    },
    {
      label: "Entry points",
      value: d.entrypoints.targets.total
        ? `${number(d.entrypoints.targets.total)} declared`
        : "None declared",
      aside: d.entrypoints.targets.total
        ? `${formatCount(matched)} matched`
        : null,
      signal: false,
    },
    {
      label: "Dependencies",
      value:
        runtime === null
          ? "Not resolved"
          : runtime === 0
            ? "None at runtime"
            : `${formatCount(runtime)} at runtime`,
      aside: otherDeps || null,
      signal: false,
    },
    {
      label: "Known advisories",
      value:
        vulnerability.status === "found"
          ? `${formatCount(advisoryCount)} from OSV`
          : VULNERABILITY[vulnerability.status].cell,
      aside:
        vulnerability.status === "incomplete" && advisoryCount
          ? `${formatCount(advisoryCount)} returned`
          : null,
      signal: vulnerabilitySignal,
    },
  ];

  const notDeclared = fields.filter(
    (field) => field.status === "not-declared-in-manifest",
  );
  // The description reads first, across the card; the other fields keep the projection's order.
  const listed = fields
    .filter((field) => field.status !== "not-declared-in-manifest")
    .sort(
      (a, b) =>
        Number(b.field === "description") - Number(a.field === "description"),
    );
  const fieldRefs = shared(fields);
  const scripts = rows(d.scripts.entries);
  const scriptRefs = shared(scripts);

  return (
    <section className="pkg" id="details" aria-labelledby="details-title">
      <header className="pkg-head">
        <div className="pkg-head__text">
          <h2 className="pkg-title" id="details-title">
            Package details
          </h2>
          <p className="pkg-lede">
            {coverage.complete === false
              ? "Analysis coverage is incomplete. "
              : coverage.complete === true
                ? "Deterministic analysis completed. "
                : "Coverage completion was not recorded. "}
            This is evidence for review, not a safety verdict. Publisher
            declarations and AI advice remain separate from observed facts.
          </p>
          <p className="pkg-meta">
            Values are shortened for display; JSON downloads preserve returned
            detail. Reports last up to 30 minutes after completion, subject to
            capacity and restart. Reading does not extend expiry.{" "}
            <a className="pkg-link" href={raw}>
              Raw report JSON
            </a>
            <span className="meta-sep" aria-hidden="true">
              {" · "}
            </span>
            <a className="pkg-link" href={viewer}>
              Analyzer evidence viewer
            </a>
          </p>
        </div>
        <div className="pkg-head__actions">
          <a
            className="button button--secondary"
            href={`${raw}/details`}
            download={`unmask-${spec.replace(/[^\w.@-]+/g, "_")}-details.json`}
          >
            <svg
              className="button__icon"
              width="14"
              height="14"
              viewBox="0 0 14 14"
              aria-hidden="true"
            >
              <path d="M7 1.75v7M4 6l3 3 3-3M2.25 11.75h9.5" />
            </svg>
            Package details JSON
          </a>
        </div>
      </header>

      <div className="report-card status-strip pkg-strip">
        <dl className="status-grid">
          {strip.map((cell) => (
            <div key={cell.label} className="status-cell">
              <dt className="status-cell__label">{cell.label}</dt>
              <dd
                className={`status-cell__value${cell.signal ? " status-cell__value--signal" : ""}`}
              >
                {cell.value}
                {cell.aside ? (
                  <>
                    {" "}
                    <span className="status-cell__aside">{cell.aside}</span>
                  </>
                ) : null}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      <nav className="pkg-nav" aria-label="Package details">
        <ul className="pkg-nav__list">
          {NAV.map(([target, label]) => (
            <li key={target}>
              <a className="pkg-nav__link" href={`#${target}`}>
                {label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <Card
        id="vulnerabilities"
        title="Known vulnerabilities from OSV"
        sub={
          vulnerability.package && vulnerability.queriedAt ? (
            <>
              <code>
                {vulnerability.package.name}@{vulnerability.package.version}
              </code>
              , looked up{" "}
              <time dateTime={vulnerability.queriedAt}>
                {when(vulnerability.queriedAt)}
              </time>
            </>
          ) : (
            "Scoped to the exact package and version checked"
          )
        }
        aside={
          <span
            className={`state-pill ${vulnerabilitySignal ? "state-pill--signal" : "state-pill--neutral"}`}
          >
            {vulnerability.status === "found"
              ? `${formatCount(advisoryCount)} ${advisoryCount === 1 ? "advisory" : "advisories"}`
              : VULNERABILITY[vulnerability.status].pill}
          </span>
        }
      >
        <p className="pkg-lead pkg-pad">
          {VULNERABILITY[vulnerability.status].lead}
        </p>
        <dl className="pkg-facts pkg-facts--five pkg-pad">
          <Fact label="Source">
            <a
              className="pkg-link"
              href="https://osv.dev"
              rel="noreferrer noopener"
            >
              OSV
            </a>
          </Fact>
          <Fact label="Lookup status">{status(vulnerability.status)}</Fact>
          <Fact label="Queried package">
            {vulnerability.package ? (
              <code>
                {vulnerability.package.name}@{vulnerability.package.version}
              </code>
            ) : (
              "Not recorded"
            )}
          </Fact>
          <Fact label="Query time">
            {vulnerability.queriedAt ? (
              <time dateTime={vulnerability.queriedAt}>
                {when(vulnerability.queriedAt)}
              </time>
            ) : (
              "Not recorded"
            )}
          </Fact>
          <Fact label="Pages fetched">
            <span className="pkg-tabular">
              {number(vulnerability.pagesFetched)}
            </span>
          </Fact>
        </dl>
        {vulnerability.reasons.length ? (
          <p className="pkg-note pkg-pad">
            Lookup limits or failures:{" "}
            {vulnerability.reasons.map(status).join(", ")}. See details JSON for
            the recorded result.
          </p>
        ) : null}
        {advisoryCount ? (
          <ul className="pkg-advisories">
            {vulnerability.advisories.slice(0, 20).map((advisory, index) => (
              <li key={index} className="pkg-advisory">
                <div className="pkg-advisory__head">
                  <span className="cue-mark" aria-hidden="true" />
                  <h4 className="pkg-advisory__id">
                    <a
                      className="pkg-link"
                      href={`https://osv.dev/vulnerability/${encodeURIComponent(String(advisory.id))}`}
                      rel="noreferrer noopener"
                    >
                      {text(advisory.id, 256)}
                    </a>
                  </h4>
                  {advisory.databaseSeverity ? (
                    <span className="state-pill state-pill--neutral">
                      OSV-declared severity:{" "}
                      {text(advisory.databaseSeverity, 64)}
                    </span>
                  ) : null}
                </div>
                <p className="pkg-advisory__summary">
                  {text(advisory.summary)}
                </p>
                <p className="pkg-advisory__meta">
                  {Array.isArray(advisory.aliases) ? (
                    <>
                      Aliases:{" "}
                      {advisory.aliases
                        .slice(0, 16)
                        .map((alias) => text(alias, 256))
                        .join(", ")}
                      <span className="meta-sep" aria-hidden="true">
                        {" · "}
                      </span>
                    </>
                  ) : null}
                  Published: {when(advisory.published)}. Modified:{" "}
                  {when(advisory.modified)}.
                </p>
                {Array.isArray(advisory.severity)
                  ? advisory.severity.slice(0, 8).map((item, i) => {
                      const severity = record(item);
                      return (
                        <p key={i} className="pkg-advisory__meta">
                          OSV-declared {text(severity.type, 32)}:{" "}
                          <code>{text(severity.score, 512)}</code>
                        </p>
                      );
                    })
                  : null}
                {advisory.truncated === true ? (
                  <p className="pkg-advisory__meta">
                    This advisory record was bounded by the adapter. Consult the
                    linked source for its full contents.
                  </p>
                ) : null}
                {Array.isArray(advisory.references) ? (
                  <ul className="pkg-advisory__refs">
                    {advisory.references.slice(0, 4).map((item, i) => {
                      const reference = record(item);
                      const href = safeHttps(reference.url);
                      return href ? (
                        <li key={i}>
                          <a
                            className="pkg-link"
                            href={href}
                            rel="noreferrer noopener"
                          >
                            {text(reference.type, 32)}: {text(href, 160)}
                          </a>
                        </li>
                      ) : null;
                    })}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        <p className="pkg-foot">
          Only the directly submitted exact npm package/version is queried.
          Dependency ranges and transitive packages are not resolved or scanned.
          This stored result is reused with the report; reading this page does
          not query OSV again.
          {advisoryCount ? (
            <>
              {" "}
              Showing {formatCount(Math.min(advisoryCount, 20))} of{" "}
              {formatCount(advisoryCount)} returned advisory records. Other
              returned records and references remain in the{" "}
              <a className="pkg-link" href={`${raw}/details`}>
                details JSON
              </a>
              . Severity and affected ranges are OSV declarations, not a new
              rating or local exploit test.
            </>
          ) : null}
        </p>
      </Card>

      <Card
        id="declarations"
        title="Purpose and publisher declarations"
        sub="Declared in the package manifest; purpose, license and runtime support are unverified"
      >
        {listed.length ? (
          <dl className="pkg-facts pkg-pad">
            {listed.map((field, index) => (
              <Fact
                key={index}
                label={text(field.field, 80)}
                wide={field.field === "description"}
              >
                {field.status === "declared" ? (
                  typeof field.value === "string" &&
                  PROSE.has(String(field.field)) ? (
                    preview(field.value)
                  ) : (
                    <code>{declaredValue(field.value)}</code>
                  )
                ) : (
                  <span className="pkg-faint">{status(field.status)}</span>
                )}
                {fieldRefs ? null : <Refs ids={field.evidenceIds} />}
              </Fact>
            ))}
            {notDeclared.length ? (
              <Fact label="Not declared in the manifest" wide>
                <span className="pkg-codes">
                  {notDeclared.map((field) => (
                    <code key={String(field.field)}>
                      {text(field.field, 80)}
                    </code>
                  ))}
                </span>
              </Fact>
            ) : null}
          </dl>
        ) : null}
        <p className="pkg-note pkg-pad">
          Manifest status: {status(d.declarations.status)}.
          {count(d.declarations.evidenceIdsOmitted)
            ? ` ${number(d.declarations.evidenceIdsOmitted)} manifest evidence references omitted by the API.`
            : ""}
          {fieldRefs ? (
            <>
              {" "}
              Every field cites the same evidence: <Refs ids={fieldRefs} bare />
            </>
          ) : null}
        </p>
        <ListNote list={d.declarations.fields} />
        <More summary="Requested identity and artifact digests">
          <dl className="pkg-facts pkg-facts--stack pkg-pad">
            <Fact label="Requested">
              <code>{spec}</code>
            </Fact>
            {Object.entries(record(identity.artifactDigests))
              .slice(0, 2)
              .map(([key, value]) => (
                <Fact key={key} label={key}>
                  <code className="pkg-digest">{text(value, 128)}</code>
                </Fact>
              ))}
          </dl>
          <ListNote list={d.identity} limit={1} />
        </More>
      </Card>

      <Card
        id="scripts"
        title="Install hooks and declared scripts"
        sub={`Status: ${status(d.scripts.status)}. Nothing was executed`}
      >
        <p className="pkg-note pkg-pad">
          Only preinstall, install and postinstall are marked as install hooks;
          other script names retain their meaning.
        </p>
        {d.scripts.entries.total ? (
          <Table
            label="Declared scripts"
            headings={[
              "Script",
              "Command",
              "Install hook",
              ...(scriptRefs ? [] : ["Evidence"]),
            ]}
            widths={["24%", "", "20%", ...(scriptRefs ? [] : ["22%"])]}
          >
            {scripts.map((script, index) => (
              <tr key={index}>
                <th scope="row">
                  <code>{text(script.name, 120)}</code>
                </th>
                <td data-label="Command">
                  <code>{preview(script.value)}</code>
                  {script.status !== "declared" ? (
                    <span className="pkg-sub">{status(script.status)}</span>
                  ) : null}
                </td>
                <td data-label="Install hook">
                  {script.installHook === true
                    ? "Yes, declared hook"
                    : "Other script"}
                </td>
                {scriptRefs ? null : (
                  <td data-label="Evidence">
                    <Refs ids={script.evidenceIds} bare />
                  </td>
                )}
              </tr>
            ))}
          </Table>
        ) : (
          <p className="pkg-empty pkg-pad">No script entries recorded.</p>
        )}
        <SharedRefs items={scripts} />
        <ListNote list={d.scripts.entries} />
        <p className="pkg-note pkg-pad">
          Accepted <code>binding.gyp</code> files:{" "}
          {number(d.scripts.bindingGyp.files.total)}. Implicit install behavior
          is not executed or simulated; consult recorded policy findings below.
        </p>
      </Card>

      <Card
        id="entrypoints"
        title="Entrypoints and declared targets"
        sub="Safe exact relative file matches only"
      >
        <p className="pkg-note pkg-pad">
          Node conditions, wildcard expansion, extension inference and runtime
          resolution are not evaluated. A missing match concerns the accepted
          inventory only.
        </p>
        {d.entrypoints.traversalOmitted === true ? (
          <p className="pkg-lead pkg-pad">
            Entrypoint traversal reached its limit. Counts cover only visited
            targets.
          </p>
        ) : null}
        {d.entrypoints.targets.total ? (
          <Table
            label="Declared entrypoint targets"
            headings={[
              "Declaration",
              "Target",
              "Accepted-file match",
              "Syntax / evidence",
            ]}
            widths={["20%", "24%", "22%", ""]}
          >
            {rows(d.entrypoints.targets).map((target, index) => (
              <tr key={index}>
                <th scope="row">
                  <code>{text(target.pointer, 200)}</code>
                </th>
                <td data-label="Target">
                  <code>{text(target.target)}</code>
                </td>
                <td data-label="Match">
                  {status(target.matchStatus)}
                  {target.state ? (
                    <span className="pkg-sub">
                      <Pill
                        state={target.state}
                        signal={signal(target.state, target.path)}
                      />
                    </span>
                  ) : null}
                </td>
                <td data-label="Syntax">
                  {status(target.syntaxStatus)}
                  <Refs ids={target.evidenceIds} bare />
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <p className="pkg-empty pkg-pad">
            No entrypoint targets were declared or recorded.
          </p>
        )}
        <ListNote list={d.entrypoints.targets} />
      </Card>

      <Card
        id="dependencies"
        title="Direct dependency declarations"
        sub="Declared ranges are not resolved or installed"
      >
        <p className="pkg-note pkg-pad">
          Categories can overlap; transitive dependencies are not assessed.
          Counts include invalid and API-omitted entries.
        </p>
        <div className="pkg-rows">
          {d.dependencies.categories.map((group, index) => {
            const summary = <code>{text(group.field, 80)}</code>;
            const aside = (
              <>
                {group.declaredCount === null
                  ? "count unresolved"
                  : `${number(group.declaredCount)} declared`}
                <span className="pkg-more__status">{status(group.status)}</span>
              </>
            );
            if (!group.entries.total)
              return (
                <div key={index} className="pkg-row">
                  <span className="pkg-more__label">{summary}</span>
                  <span className="pkg-more__aside">{aside}</span>
                </div>
              );
            const entries = rows(group.entries);
            const entryRefs = shared(entries);
            return (
              <More
                key={index}
                summary={summary}
                aside={aside}
                open={group.field === "dependencies"}
              >
                <Table
                  label={`${text(group.field, 80)} declarations`}
                  headings={[
                    "Name",
                    "Declared value",
                    entryRefs ? "Status" : "Status / evidence",
                  ]}
                  widths={["34%", "", "30%"]}
                >
                  {entries.map((dependency, i) => (
                    <tr key={i}>
                      <th scope="row">
                        <code>{preview(dependency.name)}</code>
                      </th>
                      <td data-label="Declared">
                        <code>
                          {preview(
                            Object.hasOwn(dependency, "value")
                              ? dependency.value
                              : dependency.name,
                          )}
                        </code>
                      </td>
                      <td data-label="Status">
                        {status(dependency.status)}
                        {entryRefs ? null : (
                          <Refs ids={dependency.evidenceIds} bare />
                        )}
                      </td>
                    </tr>
                  ))}
                </Table>
                <SharedRefs items={entries} />
                <ListNote list={group.entries} />
              </More>
            );
          })}
          {d.dependencies.comparisons.map((comparison, index) => {
            const summary = (
              <>Declared values versus {text(comparison.side, 80)}</>
            );
            const aside = (
              <>
                {number(comparison.differences.total)}{" "}
                {comparison.differences.total === 1
                  ? "difference"
                  : "differences"}
                <span className="pkg-more__status">
                  {status(comparison.status)}
                </span>
              </>
            );
            const note = (
              <p className="pkg-note pkg-pad">
                Registry normalization is not assessed. Unassessed fields:{" "}
                {number(comparison.unassessedFields.total)}.
              </p>
            );
            if (!comparison.differences.total)
              return (
                <div key={`c${index}`} className="pkg-row pkg-row--stack">
                  <div className="pkg-row__line">
                    <span className="pkg-more__label">{summary}</span>
                    <span className="pkg-more__aside">{aside}</span>
                  </div>
                  <p className="pkg-row__note">
                    Registry normalization is not assessed. Unassessed fields:{" "}
                    {number(comparison.unassessedFields.total)}.
                  </p>
                </div>
              );
            return (
              <More key={`c${index}`} summary={summary} aside={aside}>
                {note}
                <Table
                  label="Dependency declaration differences"
                  headings={[
                    "Field / name",
                    "Artifact",
                    "Other side",
                    "Change / evidence",
                  ]}
                  widths={["26%", "20%", "20%", ""]}
                >
                  {rows(comparison.differences).map((difference, i) => (
                    <tr key={i}>
                      <th scope="row">
                        <code>
                          {text(difference.field, 80)}/
                          {text(difference.name, 214)}
                        </code>
                      </th>
                      <td data-label="Artifact">
                        {preview(difference.artifactValue)}
                      </td>
                      <td data-label="Other side">
                        {preview(difference.otherValue)}
                      </td>
                      <td data-label="Change">
                        {status(difference.change)}
                        <Refs ids={difference.evidenceIds} bare />
                        <Refs ids={difference.otherEvidenceIds} bare />
                      </td>
                    </tr>
                  ))}
                </Table>
                <ListNote list={comparison.differences} />
              </More>
            );
          })}
        </div>
      </Card>

      <Card
        id="inventory"
        title="File composition and largest files"
        sub={
          <>
            {number(d.inventory.counts.files)} accepted regular files,{" "}
            <Size value={d.inventory.counts.bytes} />.{" "}
            {d.inventory.counts.lowerBound === true
              ? "Counts are lower bounds because inventory is incomplete."
              : d.inventory.complete === true
                ? "Accepted inventory is complete within the recorded limits."
                : "Inventory completeness is not established."}
          </>
        }
      >
        <p className="pkg-note pkg-pad">
          Extensions are lexical groups, not proof of language or behavior.
          Links are inert inventory, never followed.
        </p>
        <div className="pkg-pair">
          <Groups
            list={d.inventory.typeGroups}
            label="File composition by extension"
            keyName="extension"
          />
          <Groups
            list={d.inventory.topDirectories}
            label="Top-level directories"
            keyName="directory"
          />
        </div>
        <h4 className="pkg-subtitle pkg-pad">Largest accepted files</h4>
        <Files
          list={d.inventory.largestFiles}
          limit={20}
          label="Largest accepted files"
        />
        <More
          summary="Accepted file list"
          aside={`${number(d.inventory.files.total)} files`}
        >
          <Files
            list={d.inventory.files}
            limit={50}
            label="Accepted artifact files"
          />
        </More>
        {d.inventory.sourceOnlyPaths.total ? (
          <More
            summary="Only in the selected source"
            aside={`${number(d.inventory.sourceOnlyPaths.total)} paths`}
          >
            {d.inventory.sourceOnlyPaths.items.length ? (
              <ul className="pkg-paths pkg-pad">
                {d.inventory.sourceOnlyPaths.items
                  .slice(0, ROWS)
                  .map((path, index) => (
                    <li key={index}>
                      <code>{text(path)}</code>
                    </li>
                  ))}
              </ul>
            ) : null}
            <ListNote list={d.inventory.sourceOnlyPaths} />
          </More>
        ) : (
          <div className="pkg-row">
            <span className="pkg-more__label">Only in the selected source</span>
            <span className="pkg-more__aside">0 paths</span>
          </div>
        )}
      </Card>

      <Card
        id="observations"
        title="Observed behavior references"
        sub="Syntax references suggest review; they do not prove execution, resolved bindings or runtime behavior"
      >
        <p className="pkg-note pkg-pad">
          No observation is a package-wide absence claim.
          {evidencePaths
            ? " Each file's cues, with their excerpts, are in Published files above."
            : ""}
        </p>
        <Observations
          list={d.capabilities.observations}
          label="syntax observations"
        />
      </Card>

      <Card
        id="source"
        title="Source comparison and recorded provenance"
        sub="Byte correspondence is not build equivalence or package safety"
      >
        <dl className="pkg-facts pkg-facts--five pkg-pad">
          {(
            [
              ["Source selection", source.status],
              ["Selection method", source.method],
              ["Commit claim", source.commit],
              ["Source available", coverage.sourceAvailable],
              ["Source complete", coverage.sourceComplete],
            ] as const
          ).map(([label, value]) => (
            <Fact key={label} label={label}>
              <Value value={value} className="pkg-digest" />
            </Fact>
          ))}
        </dl>
        <Table
          label="Artifact file correspondence"
          headings={["State", "Files", "Bytes"]}
          widths={["", "88px", "128px"]}
          numeric={[1, 2]}
          compact
        >
          {(
            [
              "byte-identical",
              "changed",
              "artifact-only",
              "not-compared",
            ] as const
          ).map((state) => (
            <tr key={state}>
              <th scope="row">{stateLabel[state]}</th>
              <td className="pkg-num">
                {number(record(coverage.states[state]).files)}
              </td>
              <td className="pkg-num">
                <Size value={record(coverage.states[state]).bytes} />
              </td>
            </tr>
          ))}
        </Table>
        <p className="pkg-note pkg-pad">
          Publisher source/provenance claims retain their recorded status; this
          page performs no new cryptographic verification.
        </p>
        <More
          summary="Recorded artifact and source facts"
          aside={`${number(d.provenance.facts.total)} facts`}
        >
          <dl className="pkg-facts pkg-facts--stack pkg-pad">
            {rows(d.provenance.facts).map((fact, index) => (
              <Fact key={index} label={text(fact.field, 80)}>
                <Value value={fact.value} className="pkg-code" />
              </Fact>
            ))}
          </dl>
          <ListNote list={d.provenance.facts} />
        </More>
      </Card>

      <Card
        id="advisory"
        title="AI advisory explanation"
        sub="Advice cannot change deterministic findings"
      >
        <dl className="pkg-facts pkg-facts--five pkg-pad">
          <Fact label="Status">{status(model.status)}</Fact>
          <Fact label="Model">
            {typeof model.modelId === "string" ? (
              <code>{text(model.modelId, 100)}</code>
            ) : (
              <span className="pkg-faint">Not recorded</span>
            )}
          </Fact>
          <Fact label="Prompt-selected groups">
            <span className="pkg-tabular">
              {number(d.ai.selection.selectedGroups)}
            </span>
          </Fact>
          <Fact label="Omitted groups">
            <span className="pkg-tabular">
              {number(d.ai.selection.omittedGroups)}
            </span>
          </Fact>
          <Fact label="Omitted evidence items">
            <span className="pkg-tabular">
              {number(d.ai.selection.omittedEvidenceItems)}
            </span>
          </Fact>
        </dl>
        <p className="pkg-note pkg-pad">
          These counts do not mean full-file review or prove model attention.
          {d.ai.metadata.returned === 0 && rawModel
            ? " Model identity and status are shown from the raw report because the details projection omitted its metadata."
            : ""}
        </p>
        <ListNote list={d.ai.metadata} limit={1} />
        {d.ai.hypotheses.total ? (
          <ol className="pkg-hypotheses">
            {rows(d.ai.hypotheses, 6).map((hypothesis, index) => (
              <li key={index} className="pkg-hypothesis">
                <h4 className="pkg-subtitle">
                  Hypothesis {index + 1}: {status(hypothesis.category)}
                </h4>
                <p>{text(hypothesis.explanation)}</p>
                <p>
                  <strong>Uncertainty:</strong> {text(hypothesis.uncertainty)}
                </p>
                <p>
                  <strong>Alternative:</strong> {text(hypothesis.alternative)}
                </p>
                {Array.isArray(hypothesis.citations)
                  ? hypothesis.citations.slice(0, 4).map((citation, i) => {
                      const c = record(citation);
                      return (
                        <blockquote key={i} className="pkg-quote">
                          <code>{text(c.quote, 512)}</code>
                          <Refs ids={[c.evidenceId]} />
                        </blockquote>
                      );
                    })
                  : null}
              </li>
            ))}
          </ol>
        ) : (
          <p className="pkg-empty pkg-pad">
            No model hypotheses were recorded for this check.
          </p>
        )}
        <ListNote list={d.ai.hypotheses} limit={6} />
        <p className="pkg-note pkg-pad">
          Quotation validation establishes the supplied location, not the
          correctness or usefulness of the reasoning. Text is clipped for this
          page; the details download retains returned hypotheses and citations.
        </p>
        <More summary="Recorded model configuration">
          <dl className="pkg-facts pkg-pad">
            {[
              "status",
              "reason",
              "modelId",
              "promptHash",
              "configHash",
              "attempts",
            ].map((key) => (
              <Fact key={key} label={key}>
                <Value value={model[key]} className="pkg-digest" />
              </Fact>
            ))}
          </dl>
        </More>
      </Card>

      <Card
        id="coverage"
        title="Coverage, skipped work and review findings"
        sub="The original report counters"
      >
        <Table
          label="Recorded coverage"
          headings={["Stage", "Files", "Bytes"]}
          widths={["", "88px", "128px"]}
          numeric={[1, 2]}
          compact
        >
          {STAGES.map(([key, label]) => (
            <tr key={key}>
              <th scope="row">{label}</th>
              <td className="pkg-num">{number(record(coverage[key]).files)}</td>
              <td className="pkg-num">
                <Size value={record(coverage[key]).bytes} />
              </td>
            </tr>
          ))}
        </Table>
        <p className="pkg-note pkg-pad">
          The model-reviewed counter does not establish full-file reading.
          Unsupported syntax, limits and unresolved source remain visible below.
        </p>
        <h4 className="pkg-subtitle pkg-pad">
          Skipped work and inspection scope
        </h4>
        <Observations
          list={d.coverage.observations}
          label="inspection-scope annotations"
        />
        <h4 className="pkg-subtitle pkg-pad">Analysis failures and limits</h4>
        <Observations list={d.coverage.failures} label="analysis failures" />
        <h4 className="pkg-subtitle pkg-pad">Deterministic review findings</h4>
        <Observations
          list={d.coverage.policyFindings}
          label="policy findings"
        />
      </Card>

      <Card
        id="not-assessed"
        title="Limits and checks outside this overview"
        sub="An omitted declaration is not an absent declaration"
      >
        <ul className="pkg-limits pkg-pad">
          <li>
            All code read: no. Observations cover accepted inventory and bounded
            inspected evidence.
          </li>
          <li>
            Known vulnerability lookup is scoped to the exact package and
            recorded time. A missing or partial lookup is not a
            zero-vulnerability result. License compliance is not assessed.
          </li>
          <li>
            Target execution, install simulation and transitive dependency
            analysis: not performed.
          </li>
          <li>
            General build equivalence and package-wide safety: not established.
          </li>
          <li>
            Cryptographic provenance: no new check in this projection; consult
            the recorded source and artifact status.
          </li>
        </ul>
        <p className="pkg-foot">
          Partial inspection cannot establish absence across the package.{" "}
          <a className="pkg-link" href={evidencePaths ? "#files" : viewer}>
            Inspect the evidence
          </a>{" "}
          or{" "}
          <a className="pkg-link" href={raw}>
            download the raw report
          </a>{" "}
          before drawing conclusions.
        </p>
      </Card>
    </section>
  );
}
