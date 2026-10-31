"use client";

import { useState } from "react";

export function Questions({
  items,
}: {
  items: readonly { q: string; a: string }[];
}) {
  const [selected, setSelected] = useState(0);
  return (
    <div className="faq-grid">
      <div className="faq-list" data-part style={{ ["--part" as string]: 1 }}>
        <h2 className="faq-title" id="questions-title">
          Questions, answered
        </h2>
        <ul>
          {items.map((item, i) => (
            <li key={item.q} data-selected={i === selected ? "" : undefined}>
              <button
                type="button"
                className="faq-q"
                aria-expanded={i === selected}
                aria-controls={`faq-a-${i}`}
                onClick={() => setSelected(i)}
                onMouseEnter={() => setSelected(i)}
                onFocus={() => setSelected(i)}
              >
                <span className="faq-dot" aria-hidden="true" />
                {item.q}
              </button>
              <p
                className="faq-inline"
                id={`faq-a-${i}`}
                hidden={i !== selected}
              >
                {item.a}
              </p>
            </li>
          ))}
        </ul>
      </div>
      <div
        className="faq-pane"
        aria-hidden="true"
        data-part
        style={{ ["--part" as string]: 2 }}
      >
        <p key={selected} className="faq-answer">
          {items[selected].a}
        </p>
      </div>
    </div>
  );
}
