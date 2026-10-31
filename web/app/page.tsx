import "./ui.css";
import "./home.css";
import { HeroReel } from "@/components/home/HeroReel";
import { HowItWorks } from "@/components/home/HowItWorks";
import { FindingStates } from "@/components/home/FindingStates";
import { Questions } from "@/components/home/Questions";
import { Entrances } from "@/components/home/Entrances";
import { RecordPanel } from "@/components/ui/RecordPanel";
import { FileMap } from "@/components/ui/FileMap";
import { EvidencePanel } from "@/components/ui/EvidencePanel";
import { ReviewPanel } from "@/components/ui/ReviewPanel";
import { sampleReport } from "@/lib/sample-report.ts";
import {
  clsxRecord,
  lookupRelease,
  parseSpec,
  type RegistryRecord,
} from "@/lib/registry.ts";
import { analyzerUrl, checkErrors } from "@/lib/analyzer.ts";
import { incidents, questions, repositoryHref, team } from "@/lib/content.ts";

type Search = Promise<Record<string, string | string[] | undefined>>;

const first = (value: string | string[] | undefined) =>
  (Array.isArray(value) ? value[0] : value) ?? "";

async function initialLookup(
  release: string,
): Promise<{ record: RegistryRecord | null; error: string | null }> {
  if (!release) return { record: clsxRecord, error: null };
  const spec = parseSpec(release);
  if (!spec.ok) return { record: clsxRecord, error: spec.error };
  const result = await lookupRelease(spec.name, spec.version, {
    next: { revalidate: 300 },
  } as RequestInit);
  return result.ok
    ? { record: result.record, error: null }
    : { record: clsxRecord, error: result.error };
}

export default async function Home({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const release = first(params.release).slice(0, 300);
  const checkValue = first(params.check).slice(0, 300);
  const checkError = first(params.error);
  const lookup = await initialLookup(release);
  const connected = analyzerUrl() !== null;
  const finding = sampleReport.findings[0];
  const invalidMessage =
    checkError === "invalid" ? parseSpec(checkValue, { exact: true }) : null;
  const checkMessage =
    invalidMessage && !invalidMessage.ok
      ? invalidMessage.error
      : checkError
        ? checkErrors[checkError]
        : null;

  const nav = (
    <header className="nav">
      <a className="wordmark" href="/" aria-label="UNMASK home">
        UNMASK
      </a>
      <nav aria-label="Main" className="nav-links">
        <a href="#how">How it works</a>
        <a href="/r/sample">Sample report</a>
        <a href="#questions">Questions</a>
        <a className="button nav-action" href="#check">
          Check a release
        </a>
      </nav>
    </header>
  );

  const lead = (
    <div className="hero-lead">
      <p>
        UNMASK compares a published npm release with the source commit it
        claims, file by file, and shows the evidence for every difference.
      </p>
      <a className="button hero-action" href="#check">
        Check a release
      </a>
    </div>
  );

  return (
    <>
      <a className="skip" href="#how">
        Skip to content
      </a>
      <Entrances />
      <HeroReel
        nav={nav}
        lead={lead}
        frames={[
          {
            label: "Release",
            node: (
              <RecordPanel
                record={clsxRecord}
                compareCount={sampleReport.source.fileCount}
                files={sampleReport.files.map((f) => f.path)}
              />
            ),
          },
          { label: "Files", node: <FileMap report={sampleReport} /> },
          { label: "Evidence", node: <EvidencePanel finding={finding} /> },
          { label: "Review", node: <ReviewPanel report={sampleReport} /> },
        ]}
      />

      <main id="main">
        <section className="proof" aria-labelledby="proof-title" data-enter>
          <h2 id="proof-title" className="proof-title" data-part>
            Shipped, never committed:
          </h2>
          <ul className="proof-list">
            {incidents.map((incident, i) => (
              <li
                key={incident.name}
                data-part
                style={{ ["--part" as string]: i + 1 }}
              >
                <a href={incident.href} rel="noreferrer">
                  <span className="proof-name">{incident.name}</span>
                  <span className="proof-what">
                    {incident.year}. {incident.what}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </section>

        <section
          id="how"
          className="how on-light"
          aria-labelledby="how-title"
          data-enter
        >
          <h2 id="how-title" className="section-title" data-part>
            How a check works
          </h2>
          <HowItWorks
            initialQuery={
              lookup.record
                ? `${lookup.record.name}@${lookup.record.version}`
                : release
            }
            initialRecord={lookup.record}
            initialError={lookup.error}
            sourceCount={sampleReport.source.fileCount}
            map={<FileMap report={sampleReport} compact />}
            evidence={<EvidencePanel finding={finding} wide />}
          />
        </section>

        <section
          className="showcase on-light"
          aria-labelledby="showcase-title"
          data-enter
        >
          <h2 id="showcase-title" className="section-title" data-part>
            One finding, three states
          </h2>
          <FindingStates finding={finding} />
        </section>

        <section
          id="questions"
          className="faq on-light"
          aria-labelledby="questions-title"
          data-enter
        >
          <Questions items={questions} />
        </section>

        <section
          id="check"
          className="check"
          aria-labelledby="check-title"
          data-enter
        >
          <div className="check-main">
            <form
              className="check-form"
              action="/check"
              method="post"
              data-part
              style={{ ["--part" as string]: 1 }}
            >
              <h2 id="check-title" className="check-sentence">
                <span className="check-words">Before you install</span>{" "}
                <label className="visually-hidden" htmlFor="check-package">
                  Package name and exact version
                </label>
                <input
                  id="check-package"
                  className="check-input"
                  name="package"
                  defaultValue={checkValue}
                  placeholder="clsx@2.1.1"
                  required
                  maxLength={300}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  aria-describedby={
                    checkMessage ? "check-note check-error" : "check-note"
                  }
                  aria-invalid={checkMessage ? true : undefined}
                />
                <span className="check-comma">, </span>
                <button type="submit" className="check-submit">
                  check it.
                </button>
              </h2>
            </form>
            {checkMessage ? (
              <p
                className="check-error"
                id="check-error"
                role="alert"
                data-part
                style={{ ["--part" as string]: 2 }}
              >
                {checkMessage}
              </p>
            ) : null}
            <p
              className="check-note"
              id="check-note"
              data-part
              style={{ ["--part" as string]: 3 }}
            >
              {connected ? (
                "You get a report link at once. A check of the same release reuses its report for 24 hours."
              ) : (
                <>
                  The analyzer is not connected to this site yet. Until it is,
                  the{" "}
                  <a className="text-link" href="/r/sample">
                    sample report
                  </a>{" "}
                  shows what a check returns.
                </>
              )}
            </p>
          </div>
          <figure
            className="check-side"
            data-part
            style={{ ["--part" as string]: 2 }}
          >
            <ReviewPanel report={sampleReport} compact />
            <figcaption>
              What a check returns, shown for the sample release.
            </figcaption>
          </figure>
        </section>
      </main>

      <footer className="footer" data-enter>
        <div className="tile tile-statement" data-part>
          <p>
            UNMASK shows evidence for review and never declares a package safe.
          </p>
          <p className="tile-small">MIT licence. Open source on GitHub.</p>
        </div>
        <nav
          className="tile tile-nav"
          aria-label="Footer"
          data-part
          style={{ ["--part" as string]: 1 }}
        >
          <ul>
            <li>
              <a href="#how">How it works</a>
            </li>
            <li>
              <a href="/r/sample">Sample report</a>
            </li>
            <li>
              <a href="#questions">Questions</a>
            </li>
            <li>
              <a href={repositoryHref} rel="noreferrer">
                Source code
              </a>
            </li>
          </ul>
        </nav>
        <div
          className="tile tile-place"
          data-part
          style={{ ["--part" as string]: 2 }}
        >
          <p>
            Built at Hack Day Sonipat, Newton School of Technology, Rishihood
            University.
          </p>
          <p className="tile-small">31 October – 1 November 2026</p>
        </div>
        <div
          className="tile tile-team"
          data-part
          style={{ ["--part" as string]: 3 }}
        >
          <p className="tile-small">Team Cappybara</p>
          <ul>
            {team.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </div>
        <p
          className="tile tile-word"
          aria-hidden="true"
          data-part
          style={{ ["--part" as string]: 4 }}
        >
          UNMASK
        </p>
        <a
          className="tile tile-go"
          href="#check"
          data-part
          style={{ ["--part" as string]: 5 }}
        >
          <span>Check a release</span>
          <svg viewBox="0 0 48 48" width="48" height="48" aria-hidden="true">
            <path
              d="M8 40 40 8M16 8h24v24"
              fill="none"
              stroke="currentColor"
              strokeWidth="4"
            />
          </svg>
        </a>
      </footer>
    </>
  );
}
