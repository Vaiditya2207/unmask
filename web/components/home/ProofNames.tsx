"use client";

import { useEffect, useState } from "react";

type Incident = { readonly name: string; readonly href: string };

// The names of the incidents, one lit at a time. The lit name moves on every two
// seconds; hovering or focusing a name holds it lit. Without script every name
// stays readable in the muted ink and the second one is lit, as in the mockup.
export function ProofNames({ items }: { items: readonly Incident[] }) {
  const [lit, setLit] = useState(1);
  const [held, setHeld] = useState<number | null>(null);

  useEffect(() => {
    if (held !== null) return;
    const id = window.setInterval(
      () => setLit((i) => (i + 1) % items.length),
      2000,
    );
    return () => window.clearInterval(id);
  }, [held, items.length]);

  const shown = held ?? lit;
  const after = (i: number) =>
    i === items.length - 1 ? "." : i === items.length - 2 ? ", and " : ", ";

  return (
    <ul className="proof-names">
      {items.map((item, i) => (
        <li key={item.name} data-lit={i === shown ? "" : undefined}>
          <a
            className="proof-name"
            href={item.href}
            rel="noreferrer"
            onMouseEnter={() => setHeld(i)}
            onMouseLeave={() => setHeld(null)}
            onFocus={() => setHeld(i)}
            onBlur={() => setHeld(null)}
          >
            {item.name}
          </a>
          {after(i)}
        </li>
      ))}
    </ul>
  );
}
