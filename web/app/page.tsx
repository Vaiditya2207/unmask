import "./home.css";
import { Entrances } from "@/components/home/Entrances";
import { Hero } from "@/components/home/Hero";
import { Lookup } from "@/components/home/Lookup";
import { Pipeline } from "@/components/home/Pipeline";
import { ProofNames } from "@/components/home/ProofNames";
import { Wordmark } from "@/components/home/Wordmark";
import {
  clsxRecord,
  lookupRelease,
  parseSpec,
  type RegistryRecord,
} from "@/lib/registry.ts";
import { analyzerUrl, checkErrors } from "@/lib/analyzer.ts";
import {
  examples,
  heroExample,
  incidents,
  legal,
  links,
  pipeline,
  questions,
} from "@/lib/content.ts";

type Search = Promise<Record<string, string | string[] | undefined>>;

const first = (value: string | string[] | undefined) =>
  (Array.isArray(value) ? value[0] : value) ?? "";

const support =
  "UNMASK compares a published npm release with the source it claims, byte by byte, and shows the evidence for every difference.";

// The release the lookup opens on. Without ?release it is clsx@2.1.1, read live
// when the registry answers in time and otherwise taken from the bundled record.
async function initialLookup(release: string): Promise<{
  record: RegistryRecord;
  live: boolean;
  error: string | null;
}> {
  const fallback = { record: clsxRecord, live: false };
  const spec = parseSpec(release || `${clsxRecord.name}@${clsxRecord.version}`);
  if (!spec.ok) return { ...fallback, error: spec.error };
  const result = await lookupRelease(spec.name, spec.version, {
    next: { revalidate: release ? 300 : 3600 },
    signal: AbortSignal.timeout(2500),
  } as RequestInit);
  if (result.ok) return { record: result.record, live: true, error: null };
  return { ...fallback, error: release ? result.error : null };
}

export default async function Home({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const release = first(params.release).trim().slice(0, 300);
  const checkValue = first(params.check).slice(0, 300);
  const checkError = first(params.error);
  const lookup = await initialLookup(release);
  const connected = analyzerUrl() !== null;
  const invalidMessage =
    checkError === "invalid" ? parseSpec(checkValue, { exact: true }) : null;
  const checkMessage =
    invalidMessage && !invalidMessage.ok
      ? invalidMessage.error
      : checkError
        ? (checkErrors[checkError] ?? null)
        : null;
  const sourceLabel = links.source.replace(/^https?:\/\//, "");
  const cut = sourceLabel.lastIndexOf("/");

  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <Entrances />

      <header className="hero on-cobalt" id="top">
        <nav className="site-nav" aria-label="Main">
          <Wordmark href="/" />
          <div className="site-nav-actions">
            <ul className="site-nav-links">
              <li>
                <a className="site-nav-link" href="#how">
                  How it works
                </a>
              </li>
              <li>
                <a className="site-nav-link" href={links.example}>
                  Example report
                </a>
              </li>
              <li>
                <a className="site-nav-link" href={links.docs}>
                  Docs
                </a>
              </li>
            </ul>
            <a className="button" href="#check">
              Check a release
            </a>
          </div>
        </nav>
        <Hero
          build={heroExample.build}
          appended={heroExample.appended}
          source={heroExample.source}
          support={support}
        />
      </header>

      <main id="main">
        <section className="proof" aria-labelledby="proof-title" data-enter>
          <div className="proof-statement" data-part>
            <h2 id="proof-title" className="proof-title">
              Shipped, never committed:
            </h2>{" "}
            <ProofNames items={incidents} />
          </div>
        </section>

        <section
          id="how"
          className="how"
          aria-labelledby="how-title"
          data-enter
        >
          <h2 id="how-title" className="section-title" data-part>
            How a check runs
          </h2>
          <p className="how-run" data-part style={{ ["--part" as string]: 1 }}>
            {pipeline.release}, checked in {pipeline.seconds} seconds.
          </p>
          <Pipeline stages={pipeline.stages} />
        </section>

        <section
          id="lookup"
          className="lookup on-dark"
          aria-labelledby="lookup-title"
          data-enter
        >
          <h2 id="lookup-title" className="lookup-title" data-part>
            <label htmlFor="lookup-release">Look up any release</label>
          </h2>
          <Lookup
            initialQuery={
              lookup.error && release
                ? release
                : `${lookup.record.name}@${lookup.record.version}`
            }
            initialRecord={lookup.record}
            initialLive={lookup.live}
            initialError={lookup.error}
            examples={examples}
          />
        </section>

        <section
          id="questions"
          className="questions"
          aria-labelledby="questions-title"
          data-enter
        >
          <h2 id="questions-title" className="questions-title" data-part>
            Questions
          </h2>
          <dl className="questions-list">
            {questions.map((item, i) => (
              <div
                key={item.q}
                className="question-row"
                data-part
                style={{ ["--part" as string]: i + 1 }}
              >
                <dt className="question">{item.q}</dt>
                <dd className="answer">{item.a}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section
          id="check"
          className="check"
          aria-labelledby="check-title"
          data-enter
        >
          <form className="check-form" action="/check" method="post">
            <h2 id="check-title" className="check-line" data-part>
              Before you install
            </h2>
            <div
              className="check-line check-fields"
              data-part
              style={{ ["--part" as string]: 1 }}
            >
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
              <span className="check-comma" aria-hidden="true">
                ,{" "}
              </span>
              <button type="submit" className="check-submit">
                check it.
              </button>
            </div>
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
              "A check sends the package name and version to the UNMASK server. Reports are kept for up to 30 minutes."
            ) : (
              <>
                Checks run on the UNMASK analyzer, which this deployment does
                not include. The{" "}
                <a className="text-link" href={links.example}>
                  example report
                </a>{" "}
                shows what a check returns.
              </>
            )}
          </p>
        </section>
      </main>

      <footer className="site-footer on-dark" data-enter>
        <div className="footer-top" data-part>
          <Wordmark href="#top" />
          <div className="footer-notes">
            <p className="footer-note">
              Evidence for every byte a release ships.
            </p>
            <p className="footer-note">Never a verdict of safe.</p>
          </div>
          <a className="footer-back" href="#top">
            Back to top
            <svg
              className="footer-back-arrow"
              viewBox="0 0 12 12"
              aria-hidden="true"
            >
              <path
                d="M6 10.5V2M2.5 5.5L6 2l3.5 3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
              />
            </svg>
          </a>
        </div>

        <div className="footer-bottom">
          <a
            className="footer-display"
            href={links.source}
            data-part
            style={{ ["--part" as string]: 1 }}
          >
            <span className="footer-display-line">
              {sourceLabel.slice(0, cut)}
            </span>
            <span className="footer-display-line">
              {sourceLabel.slice(cut)}
              <svg
                className="footer-display-arrow"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  d="M5.5 18.5L17 7M7.5 5.5h11v11"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="4.6"
                />
              </svg>
            </span>
          </a>
          <div
            className="footer-meta"
            data-part
            style={{ ["--part" as string]: 2 }}
          >
            <ul className="footer-links">
              <li>
                <a className="footer-link" href="#how">
                  How it works
                </a>
              </li>
              <li>
                <a className="footer-link" href={links.example}>
                  Example report
                </a>
              </li>
              <li>
                <a className="footer-link" href={links.docs}>
                  Docs
                </a>
              </li>
              <li>
                <a className="footer-link" href={links.cli}>
                  CLI
                </a>
              </li>
              <li>
                <a className="footer-link" href={links.issues}>
                  Report an issue
                </a>
              </li>
            </ul>
            <p className="footer-legal">{legal}</p>
            <a className="footer-link footer-open" href={links.source}>
              Open source
            </a>
          </div>
        </div>
      </footer>
    </>
  );
}
