"use client";

import { useEffect, useRef, useState } from "react";

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));
const ease = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

// The reel of report screens advances one frame per screen of scroll while the
// split headline holds. Without script it shows the first frame and does not pin.
export function HeroReel({
  nav,
  lead,
  frames,
}: {
  nav: React.ReactNode;
  lead: React.ReactNode;
  frames: { label: string; node: React.ReactNode }[];
}) {
  const section = useRef<HTMLElement>(null);
  const reel = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState(false);
  const [active, setActive] = useState(0);

  useEffect(() => {
    setLive(true);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    let raf = 0;
    const update = () => {
      raf = 0;
      const s = section.current;
      const w = reel.current;
      const t = track.current;
      if (!s || !w || !t) return;
      const items = Array.from(t.children) as HTMLElement[];
      const steps = items.length - 1;
      const rect = s.getBoundingClientRect();
      const span = rect.height - window.innerHeight;
      const progress = span > 0 ? clamp(-rect.top / span, 0, 1) : 0;
      const raw = progress * steps;
      const base = Math.min(Math.floor(raw), steps);
      const frac = raw - base;
      const move = reduce.matches
        ? frac > 0.5
          ? 1
          : 0
        : ease(clamp((frac - 0.35) / 0.65, 0, 1));
      const position = Math.min(base + move, steps);
      const centred = (i: number) =>
        (w.clientHeight - items[i].offsetHeight) / 2 - items[i].offsetTop;
      const from = centred(base);
      const to = centred(Math.min(base + 1, steps));
      const offset = from + (to - from) * (position - base);
      t.style.transform = `translate3d(0, ${offset.toFixed(1)}px, 0)`;
      setActive(Math.round(position));
    };
    const request = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", request, { passive: true });
    window.addEventListener("resize", request);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", request);
      window.removeEventListener("resize", request);
    };
  }, []);

  return (
    <section
      ref={section}
      className="hero"
      data-live={live ? "" : undefined}
      style={{ ["--frames" as string]: frames.length }}
      aria-labelledby="hero-title"
    >
      <div className="hero-stage">
        {nav}
        <h1 id="hero-title" className="hero-title">
          <span>See what</span> <span>actually shipped</span>
        </h1>
        <div className="reel" ref={reel}>
          <div className="reel-track" ref={track}>
            {frames.map((frame, i) => (
              <div
                key={frame.label}
                className="reel-frame"
                data-active={i === active ? "" : undefined}
                aria-hidden={live && i !== active ? true : undefined}
                inert={live && i !== active ? true : undefined}
              >
                {frame.node}
              </div>
            ))}
          </div>
        </div>
        {lead}
      </div>
    </section>
  );
}
