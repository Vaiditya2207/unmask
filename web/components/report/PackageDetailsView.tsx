import type { ReactNode } from "react";
import {
  type DetailList,
  type PackageDetails,
  record,
  text,
  count,
  status,
  preview,
} from "@/lib/package-details.ts";
import { formatBytes } from "@/lib/report.ts";
import { parseVulnerabilityCheck, safeHttps } from "@/lib/vulnerabilities.ts";

const ROWS = 30;
const number = (value: unknown) =>
  count(value)?.toLocaleString("en-US") ?? "Not recorded";
const bytes = (value: unknown) =>
  count(value) === null ? "Not recorded" : formatBytes(value as number);
const rows = (list: DetailList, limit = ROWS) =>
  list.items.slice(0, limit).map(record);

function ListNote({
  list,
  limit = ROWS,
}: {
  list: DetailList;
  limit?: number;
}) {
  return (
    <p className="detail-note">
      Showing {Math.min(list.returned, limit)} of {number(list.total)} recorded
      entries.
      {list.omitted > 0
        ? ` The API omitted ${number(list.omitted)} (${Object.keys(list.omissionReasons).slice(0, 4).map(status).join(", ")}).`
        : ""}
      {list.returned > limit
        ? ` This page limits the view to ${limit}; download details for the returned rows.`
        : ""}
    </p>
  );
}
function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="card" id={id} aria-labelledby={`${id}-title`}>
      <div className="card-head">
        <h2 id={`${id}-title`}>{title}</h2>
      </div>
      <div className="detail-body">{children}</div>
    </section>
  );
}
function Table({
  label,
  headings,
  children,
}: {
  label: string;
  headings: string[];
  children: ReactNode;
}) {
  return (
    <div
      className="details-scroll"
      role="region"
      aria-label={label}
      tabIndex={0}
    >
      <table className="details-table">
        <caption className="visually-hidden">{label}</caption>
        <thead>
          <tr>
            {headings.map((heading) => (
              <th key={heading} scope="col">
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function PackageDetailsView({
  details: d,
  id,
  analyzer,
  anchors,
  rawModel,
}: {
  details: PackageDetails;
  id: string;
  analyzer: string;
  anchors: Map<string, string>;
  rawModel?: unknown;
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
  const nav = [
    ["declarations", "Purpose and declarations"],
    ["scripts", "Install scripts"],
    ["entrypoints", "Entrypoints"],
    ["dependencies", "Dependencies"],
    ["inventory", "Files"],
    ["observations", "Observed behavior"],
    ["source", "Source comparison"],
    ["vulnerabilities", "Known vulnerabilities"],
    ["advisory", "AI advice"],
    ["coverage", "Coverage and limits"],
  ];
  function Refs({ ids }: { ids: unknown }) {
    const values = Array.isArray(ids)
      ? ids
          .slice(0, 6)
          .filter((value): value is string => typeof value === "string")
      : [];
    if (!values.length)
      return <span className="faint">No evidence reference returned</span>;
    return (
      <span className="detail-refs">
        {values.map((value, index) => (
          <a
            key={index}
            href={`${viewer}${anchors.has(value) ? `#${anchors.get(value)}` : ""}`}
            title={text(value, 512)}
          >
            Evidence <code>{text(value, 24)}</code>
          </a>
        ))}
        {Array.isArray(ids) && ids.length > 6 ? (
          <span className="faint">
            More references in <a href={raw}>raw report</a>
          </span>
        ) : null}
      </span>
    );
  }
  function Observations({ list, label }: { list: DetailList; label: string }) {
    return (
      <>
        <ul className="detail-list">
          {rows(list).map((item, index) => (
            <li key={index}>
              <strong>
                {text(item.ruleId ?? item.type ?? item.code, 120)}
              </strong>
              <p>
                {text(
                  item.summary ?? item.message ?? item.reason ?? item.status,
                )}
              </p>
              {item.literalStatus ? (
                <p className="faint">
                  Literal evidence: {status(item.literalStatus)}
                </p>
              ) : null}
              {item.path ? (
                <p>
                  <code>{text(item.path)}</code>
                </p>
              ) : null}
              {item.cueRef || item.annotationRef ? (
                <p className="faint">
                  Raw report pointer:{" "}
                  <code>{text(item.cueRef ?? item.annotationRef, 120)}</code>
                </p>
              ) : null}
              <Refs ids={item.evidenceIds} />
            </li>
          ))}
        </ul>
        {list.total === 0 ? (
          <p>
            No {label} recorded in this bounded result. This does not establish
            package-wide absence.
          </p>
        ) : null}
        <ListNote list={list} />
      </>
    );
  }
  function Files({ list, limit = ROWS }: { list: DetailList; limit?: number }) {
    return (
      <>
        <Table
          label="Accepted artifact files"
          headings={["Path", "Size", "Correspondence", "Evidence"]}
        >
          {rows(list, limit).map((file, index) => (
            <tr key={index}>
              <th scope="row">
                <code>{text(file.path ?? file.originalPath)}</code>
              </th>
              <td>{bytes(file.size)}</td>
              <td>{status(file.state)}</td>
              <td>
                <Refs ids={file.evidenceIds} />
              </td>
            </tr>
          ))}
        </Table>
        <ListNote list={list} limit={limit} />
      </>
    );
  }
  return (
    <main className="viewer package-details" id="main">
      <div className="title-row">
        <div>
          <h1>{spec}</h1>
          <p className="subtitle">
            Package breakdown from the accepted inventory and bounded
            observations.
          </p>
        </div>
        <a className="btn" href={viewer}>
          Open evidence viewer
        </a>
      </div>
      <p className="notice">
        {coverage.complete === false
          ? "Analysis coverage is incomplete. "
          : coverage.complete === true
            ? "Deterministic analysis completed. "
            : "Coverage completion was not recorded. "}
        This is evidence for review, not a safety verdict. Publisher
        declarations and AI advice remain separate from observed facts.
      </p>
      <nav className="detail-nav" aria-label="Package breakdown">
        {nav.map(([target, label]) => (
          <a key={target} href={`#${target}`}>
            {label}
          </a>
        ))}
      </nav>
      <p className="detail-downloads">
        <a href={raw}>Raw report JSON</a>
        <a href={`${raw}/details`}>Package details JSON</a>
        <span>
          Values are shortened for display; JSON downloads preserve returned
          detail. Reports last up to 30 minutes after completion, subject to
          capacity and restart. Reading does not extend expiry.
        </span>
      </p>

      <Section id="declarations" title="Purpose and publisher declarations">
        <p className="detail-note">
          Declared in the package manifest; purpose, license and runtime support
          are unverified. Manifest status: {status(d.declarations.status)}.{" "}
          {count(d.declarations.evidenceIdsOmitted)
            ? `${number(d.declarations.evidenceIdsOmitted)} manifest evidence references omitted by the API.`
            : ""}
        </p>
        <dl className="detail-kv">
          {fields.map((field, index) => (
            <div key={index}>
              <dt>{text(field.field, 80)}</dt>
              <dd>
                {field.status === "declared" ? (
                  <code>{preview(field.value)}</code>
                ) : (
                  status(field.status)
                )}
                <Refs ids={field.evidenceIds} />
              </dd>
            </div>
          ))}
        </dl>
        <ListNote list={d.declarations.fields} />
        <details>
          <summary>Requested identity and artifact digests</summary>
          <dl className="detail-kv">
            <div>
              <dt>Requested</dt>
              <dd>{spec}</dd>
            </div>
            {Object.entries(record(identity.artifactDigests))
              .slice(0, 2)
              .map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>
                    <code>{text(value, 128)}</code>
                  </dd>
                </div>
              ))}
          </dl>
          <ListNote list={d.identity} limit={1} />
        </details>
      </Section>

      <Section id="scripts" title="Install hooks and declared scripts">
        <p className="detail-note">
          Status: {status(d.scripts.status)}. Nothing was executed. Only
          preinstall, install and postinstall are marked as install hooks; other
          script names retain their meaning.
        </p>
        <Table
          label="Declared scripts"
          headings={["Script", "Command", "Install hook", "Evidence"]}
        >
          {rows(d.scripts.entries).map((script, index) => (
            <tr key={index}>
              <th scope="row">
                <code>{text(script.name, 120)}</code>
              </th>
              <td>
                <code>{preview(script.value)}</code>
                {script.status !== "declared" ? (
                  <p>{status(script.status)}</p>
                ) : null}
              </td>
              <td>
                {script.installHook === true
                  ? "Yes, declared hook"
                  : "Other script"}
              </td>
              <td>
                <Refs ids={script.evidenceIds} />
              </td>
            </tr>
          ))}
        </Table>
        <ListNote list={d.scripts.entries} />
        <p>
          Accepted <code>binding.gyp</code> files:{" "}
          {number(d.scripts.bindingGyp.files.total)}. Implicit install behavior
          is not executed or simulated; consult recorded policy findings below.
        </p>
      </Section>

      <Section id="entrypoints" title="Entrypoints and declared targets">
        <p className="detail-note">
          Safe exact relative file matches only. Node conditions, wildcard
          expansion, extension inference and runtime resolution are not
          evaluated. A missing match concerns the accepted inventory only.
        </p>
        {d.entrypoints.traversalOmitted === true ? (
          <p className="notice">
            Entrypoint traversal reached its limit. Counts cover only visited
            targets.
          </p>
        ) : null}
        <Table
          label="Declared entrypoint targets"
          headings={[
            "Declaration",
            "Target",
            "Accepted-file match",
            "Syntax / evidence",
          ]}
        >
          {rows(d.entrypoints.targets).map((target, index) => (
            <tr key={index}>
              <th scope="row">
                <code>{text(target.pointer, 200)}</code>
              </th>
              <td>
                <code>{text(target.target)}</code>
              </td>
              <td>
                {status(target.matchStatus)}
                {target.state ? <p>{status(target.state)}</p> : null}
              </td>
              <td>
                {status(target.syntaxStatus)}
                <Refs ids={target.evidenceIds} />
              </td>
            </tr>
          ))}
        </Table>
        <ListNote list={d.entrypoints.targets} />
      </Section>

      <Section id="dependencies" title="Direct dependency declarations">
        <p className="detail-note">
          Declared ranges are not resolved or installed. Categories can overlap;
          transitive dependencies are not assessed. Counts include invalid and
          API-omitted entries.
        </p>
        {d.dependencies.categories.map((category, index) => (
          <details key={index} open={category.field === "dependencies"}>
            <summary>
              {status(category.field)}:{" "}
              {category.declaredCount === null
                ? "count unresolved"
                : `${number(category.declaredCount)} declared`}{" "}
              ({status(category.status)})
            </summary>
            <Table
              label={`${text(category.field, 80)} declarations`}
              headings={["Name", "Declared value", "Status / evidence"]}
            >
              {rows(category.entries).map((dependency, i) => (
                <tr key={i}>
                  <th scope="row">
                    <code>{preview(dependency.name)}</code>
                  </th>
                  <td>
                    <code>
                      {preview(
                        Object.hasOwn(dependency, "value")
                          ? dependency.value
                          : dependency.name,
                      )}
                    </code>
                  </td>
                  <td>
                    {status(dependency.status)}
                    <Refs ids={dependency.evidenceIds} />
                  </td>
                </tr>
              ))}
            </Table>
            <ListNote list={category.entries} />
          </details>
        ))}
        {d.dependencies.comparisons.map((comparison, index) => (
          <details key={index}>
            <summary>
              Declared values versus {text(comparison.side, 80)}:{" "}
              {status(comparison.status)}
            </summary>
            <p className="detail-note">
              Registry normalization is not assessed. Unassessed fields:{" "}
              {number(comparison.unassessedFields.total)}.
            </p>
            <Table
              label="Dependency declaration differences"
              headings={[
                "Field / name",
                "Artifact",
                "Other side",
                "Change / evidence",
              ]}
            >
              {rows(comparison.differences).map((difference, i) => (
                <tr key={i}>
                  <th scope="row">
                    <code>
                      {text(difference.field, 80)}/{text(difference.name, 214)}
                    </code>
                  </th>
                  <td>{preview(difference.artifactValue)}</td>
                  <td>{preview(difference.otherValue)}</td>
                  <td>
                    {status(difference.change)}
                    <Refs ids={difference.evidenceIds} />
                    <Refs ids={difference.otherEvidenceIds} />
                  </td>
                </tr>
              ))}
            </Table>
            <ListNote list={comparison.differences} />
          </details>
        ))}
      </Section>

      <Section id="inventory" title="File composition and largest files">
        <p>
          {number(d.inventory.counts.files)} accepted regular files,{" "}
          {bytes(d.inventory.counts.bytes)}.{" "}
          {d.inventory.counts.lowerBound === true
            ? "Counts are lower bounds because inventory is incomplete."
            : d.inventory.complete === true
              ? "Accepted inventory is complete within the recorded limits."
              : "Inventory completeness is not established."}
        </p>
        <p className="detail-note">
          Extensions are lexical groups, not proof of language or behavior.
          Links are inert inventory, never followed.
        </p>
        <Table
          label="File composition by extension"
          headings={["Extension", "Files", "Bytes"]}
        >
          {rows(d.inventory.typeGroups).map((group, index) => (
            <tr key={index}>
              <th scope="row">
                <code>{text(group.extension, 80)}</code>
              </th>
              <td>{number(group.files)}</td>
              <td>{bytes(group.bytes)}</td>
            </tr>
          ))}
        </Table>
        <ListNote list={d.inventory.typeGroups} />
        <details>
          <summary>Top-level directories</summary>
          <Table
            label="Top-level directories"
            headings={["Directory", "Files", "Bytes"]}
          >
            {rows(d.inventory.topDirectories).map((group, index) => (
              <tr key={index}>
                <th scope="row">
                  <code>{text(group.directory)}</code>
                </th>
                <td>{number(group.files)}</td>
                <td>{bytes(group.bytes)}</td>
              </tr>
            ))}
          </Table>
          <ListNote list={d.inventory.topDirectories} />
        </details>
        <h3>Largest accepted files</h3>
        <Files list={d.inventory.largestFiles} limit={20} />
        <details>
          <summary>Accepted file list</summary>
          <Files list={d.inventory.files} limit={50} />
        </details>
        <details>
          <summary>
            Only in the selected source (
            {number(d.inventory.sourceOnlyPaths.total)})
          </summary>
          <ul className="detail-list">
            {d.inventory.sourceOnlyPaths.items
              .slice(0, ROWS)
              .map((path, index) => (
                <li key={index}>
                  <code>{text(path)}</code>
                </li>
              ))}
          </ul>
          <ListNote list={d.inventory.sourceOnlyPaths} />
        </details>
      </Section>

      <Section id="observations" title="Observed behavior references">
        <p className="detail-note">
          Syntax references suggest review; they do not prove execution,
          resolved bindings or runtime behavior. No observation is a
          package-wide absence claim.
        </p>
        <Observations
          list={d.capabilities.observations}
          label="syntax observations"
        />
      </Section>

      <Section id="source" title="Source comparison and recorded provenance">
        <dl className="detail-kv">
          {[
            ["Source selection", source.status],
            ["Selection method", source.method],
            ["Commit claim", source.commit],
            ["Source available", coverage.sourceAvailable],
            ["Source complete", coverage.sourceComplete],
          ].map(([label, value], index) => (
            <div key={index}>
              <dt>{String(label)}</dt>
              <dd>
                <code>{preview(value)}</code>
              </dd>
            </div>
          ))}
        </dl>
        <Table
          label="Artifact file correspondence"
          headings={["State", "Files", "Bytes"]}
        >
          {["byte-identical", "changed", "artifact-only", "not-compared"].map(
            (state) => (
              <tr key={state}>
                <th scope="row">{status(state)}</th>
                <td>{number(record(coverage.states[state]).files)}</td>
                <td>{bytes(record(coverage.states[state]).bytes)}</td>
              </tr>
            ),
          )}
        </Table>
        <p className="detail-note">
          Byte correspondence is not build equivalence or package safety.
          Publisher source/provenance claims retain their recorded status; this
          page performs no new cryptographic verification.
        </p>
        <details>
          <summary>Recorded artifact and source facts</summary>
          {rows(d.provenance.facts).map((fact, index) => (
            <div key={index}>
              <h3>{text(fact.field, 80)}</h3>
              <p>
                <code>{preview(fact.value)}</code>
              </p>
            </div>
          ))}
          <ListNote list={d.provenance.facts} />
        </details>
      </Section>

      <Section id="vulnerabilities" title="Known vulnerabilities from OSV">
        <p className="notice">
          {vulnerability.status === "not-assessed"
            ? "No vulnerability lookup was recorded for this check."
            : vulnerability.status === "none-reported"
              ? "OSV reported no advisories for this exact package/version at the recorded time. This is not a safety verdict or proof that vulnerabilities do not exist."
              : vulnerability.status === "found"
                ? "OSV returned known advisory records for this exact package/version."
                : vulnerability.status === "incomplete"
                  ? "The OSV lookup is incomplete. Returned advisory records are partial; no complete result is available."
                  : "The OSV lookup is unavailable. No conclusion about known vulnerabilities is available."}
        </p>
        <dl className="detail-kv">
          <div>
            <dt>Source</dt>
            <dd>
              <a href="https://osv.dev" rel="noreferrer noopener">
                OSV
              </a>
            </dd>
          </div>
          <div>
            <dt>Lookup status</dt>
            <dd>{status(vulnerability.status)}</dd>
          </div>
          <div>
            <dt>Queried package</dt>
            <dd>
              {vulnerability.package ? (
                <code>
                  {vulnerability.package.name}@{vulnerability.package.version}
                </code>
              ) : (
                "Not recorded"
              )}
            </dd>
          </div>
          <div>
            <dt>Query time</dt>
            <dd>
              {vulnerability.queriedAt ? (
                <time dateTime={vulnerability.queriedAt}>
                  {vulnerability.queriedAt}
                </time>
              ) : (
                "Not recorded"
              )}
            </dd>
          </div>
          <div>
            <dt>Pages fetched</dt>
            <dd>{number(vulnerability.pagesFetched)}</dd>
          </div>
        </dl>
        <p className="detail-note">
          Only the directly submitted exact npm package/version is queried.
          Dependency ranges and transitive packages are not resolved or scanned.
          This stored result is reused with the report; reading this page does
          not query OSV again.
        </p>
        {vulnerability.reasons.length ? (
          <p>
            Lookup limits or failures:{" "}
            {vulnerability.reasons.map(status).join(", ")}. See details JSON for
            the recorded result.
          </p>
        ) : null}
        <ul className="detail-list">
          {vulnerability.advisories.slice(0, 20).map((advisory, index) => (
            <li key={index}>
              <h3>
                <a
                  href={`https://osv.dev/vulnerability/${encodeURIComponent(String(advisory.id))}`}
                  rel="noreferrer noopener"
                >
                  {text(advisory.id, 256)}
                </a>
              </h3>
              <p>{text(advisory.summary)}</p>
              {Array.isArray(advisory.aliases) ? (
                <p>
                  Aliases:{" "}
                  {advisory.aliases
                    .slice(0, 16)
                    .map((alias) => text(alias, 256))
                    .join(", ")}
                </p>
              ) : null}
              {advisory.databaseSeverity ? (
                <p>
                  OSV-declared severity: {text(advisory.databaseSeverity, 64)}
                </p>
              ) : null}
              {Array.isArray(advisory.severity)
                ? advisory.severity.slice(0, 8).map((item, i) => {
                    const severity = record(item);
                    return (
                      <p key={i}>
                        OSV-declared {text(severity.type, 32)}:{" "}
                        <code>{text(severity.score, 512)}</code>
                      </p>
                    );
                  })
                : null}
              <p className="faint">
                Published: {text(advisory.published, 64)}. Modified:{" "}
                {text(advisory.modified, 64)}.
              </p>
              {advisory.truncated === true ? (
                <p className="notice">
                  This advisory record was bounded by the adapter. Consult the
                  linked source for its full contents.
                </p>
              ) : null}
              {Array.isArray(advisory.references) ? (
                <ul className="detail-refs">
                  {advisory.references.slice(0, 4).map((item, i) => {
                    const reference = record(item);
                    const href = safeHttps(reference.url);
                    return href ? (
                      <li key={i}>
                        <a href={href} rel="noreferrer noopener">
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
        {vulnerability.advisories.length > 0 ? (
          <p className="detail-note">
            Showing {Math.min(vulnerability.advisories.length, 20)} of{" "}
            {vulnerability.advisories.length} returned advisory records. Other
            returned records and references remain in the{" "}
            <a href={`${raw}/details`}>details JSON</a>. Severity and affected
            ranges are OSV declarations, not a new rating or local exploit test.
          </p>
        ) : null}
      </Section>

      <Section id="advisory" title="AI advisory explanation">
        <p>
          Status: {status(model.status)}. Model:{" "}
          <code>{text(model.modelId, 100)}</code>. Advice cannot change
          deterministic findings.
        </p>
        <p className="detail-note">
          Prompt-selected groups: {number(d.ai.selection.selectedGroups)};
          omitted groups: {number(d.ai.selection.omittedGroups)}; omitted
          evidence items: {number(d.ai.selection.omittedEvidenceItems)}. These
          counts do not mean full-file review or prove model attention.
        </p>
        {d.ai.metadata.returned === 0 && rawModel ? (
          <p className="detail-note">
            Model identity and status are shown from the raw report because the
            details projection omitted its metadata.
          </p>
        ) : null}
        <ListNote list={d.ai.metadata} limit={1} />
        <ol className="detail-list">
          {rows(d.ai.hypotheses, 6).map((hypothesis, index) => (
            <li key={index}>
              <h3>
                Hypothesis {index + 1}: {status(hypothesis.category)}
              </h3>
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
                      <blockquote key={i}>
                        <p>
                          <code>{text(c.quote, 512)}</code>
                        </p>
                        <Refs ids={[c.evidenceId]} />
                      </blockquote>
                    );
                  })
                : null}
            </li>
          ))}
        </ol>
        <ListNote list={d.ai.hypotheses} limit={6} />
        <p className="detail-note">
          Quotation validation establishes the supplied location, not the
          correctness or usefulness of the reasoning. Text is clipped for this
          page; the details download retains returned hypotheses and citations.
        </p>
        <details>
          <summary>Recorded model configuration</summary>
          <dl className="detail-kv">
            {[
              "status",
              "reason",
              "modelId",
              "promptHash",
              "configHash",
              "attempts",
            ].map((key) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>
                  <code>{preview(model[key])}</code>
                </dd>
              </div>
            ))}
          </dl>
        </details>
      </Section>

      <Section id="coverage" title="Coverage, skipped work and review findings">
        <Table label="Recorded coverage" headings={["Stage", "Files", "Bytes"]}>
          {[
            "inventory",
            "compared",
            "unresolved",
            "syntaxInspected",
            "modelReviewed",
          ].map((key) => (
            <tr key={key}>
              <th scope="row">{key}</th>
              <td>{number(record(coverage[key]).files)}</td>
              <td>{bytes(record(coverage[key]).bytes)}</td>
            </tr>
          ))}
        </Table>
        <p className="detail-note">
          These are the original report counters. The model-reviewed counter
          does not establish full-file reading. Unsupported syntax, limits and
          unresolved source remain visible below.
        </p>
        <h3>Skipped work and inspection scope</h3>
        <Observations
          list={d.coverage.observations}
          label="inspection-scope annotations"
        />
        <h3>Analysis failures and limits</h3>
        <Observations list={d.coverage.failures} label="analysis failures" />
        <h3>Deterministic review findings</h3>
        <Observations
          list={d.coverage.policyFindings}
          label="policy findings"
        />
      </Section>

      <Section
        id="not-assessed"
        title="Limits and checks outside this overview"
      >
        <ul className="detail-list">
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
        <p className="detail-note">
          An omitted declaration is not an absent declaration. Partial
          inspection cannot establish absence across the package.{" "}
          <a href={viewer}>Inspect the evidence</a> or{" "}
          <a href={raw}>download the raw report</a> before drawing conclusions.
        </p>
      </Section>
    </main>
  );
}
