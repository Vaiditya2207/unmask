"use client";

import { useState } from "react";

type View = "source" | "published";

// Characters per line of the code strip in the slot (its width is 48ch).
const LINE = 48;

const views: { value: View; label: string }[] = [
  { value: "source", label: "Source" },
  { value: "published", label: "Published" },
];

// The headline with its slot: the published bytes of a build stand where the word
// "actually" would be. The chips around it are working controls for that slot.
export function Hero({
  build,
  appended,
  source,
  support,
}: {
  build: string;
  appended: string;
  source: string;
  support: string;
}) {
  const [view, setView] = useState<View>("published");
  const [highlight, setHighlight] = useState(true);
  const total = build.length + appended.length;
  const start = (build.length / total) * 100;

  return (
    <div className="hero-stage">
      <div className="hero-group">
        <h1 className="hero-title">
          <span className="hero-line">
            <span className="hero-line-inner">
              See what <span className="visually-hidden">actually </span>
              <span
                className="hero-slot"
                data-ui
                aria-hidden="true"
                data-view={view}
                data-highlight={highlight ? "on" : "off"}
                style={{
                  ["--boundary" as string]: Math.floor(build.length / LINE),
                  ["--lines" as string]: Math.ceil(total / LINE),
                }}
              >
                <code
                  key={view}
                  className="slot-code"
                  data-build={build}
                  data-appended={appended}
                  data-source={source}
                />
              </span>
            </span>
          </span>
          <span className="hero-line hero-line-second">
            <span className="hero-line-inner">shipped.</span>
          </span>
        </h1>

        <div className="hero-controls" data-ui>
          <div
            className="chip hero-chip-showing"
            role="radiogroup"
            aria-labelledby="hero-showing"
            style={{ ["--i" as string]: 0 }}
          >
            <span className="chip-label" id="hero-showing">
              Showing
            </span>
            <span className="segmented">
              {views.map((option) => (
                <label key={option.value} className="segmented-option">
                  <input
                    className="visually-hidden"
                    type="radio"
                    name="hero-view"
                    value={option.value}
                    checked={view === option.value}
                    onChange={() => setView(option.value)}
                  />
                  <span className="segmented-pill">{option.label}</span>
                </label>
              ))}
            </span>
          </div>

          <div
            className="chip hero-chip-bytes"
            role="group"
            aria-labelledby="hero-bytes"
            style={{ ["--i" as string]: 1 }}
          >
            <span className="chip-label" id="hero-bytes">
              Not in any source file
            </span>
            <span className="chip-readout">{appended.length} B</span>
            <span
              className="byte-track"
              role="img"
              aria-label={`Bytes ${build.length} to ${total} of ${total}`}
            >
              <span className="byte-track-fill" style={{ left: `${start}%` }} />
            </span>
          </div>

          <div
            className="chip hero-chip-light"
            style={{ ["--i" as string]: 2 }}
          >
            <span className="chip-stack">
              <span className="chip-label" id="hero-highlight">
                Highlight
              </span>
              <span className="chip-readout" aria-hidden="true">
                {highlight ? "On" : "Off"}
              </span>
            </span>
            <button
              type="button"
              className="switch"
              role="switch"
              aria-checked={highlight}
              aria-labelledby="hero-highlight"
              onClick={() => setHighlight((on) => !on)}
            >
              <span className="switch-thumb" />
            </button>
          </div>
        </div>
      </div>

      <p className="hero-support">{support}</p>
    </div>
  );
}
