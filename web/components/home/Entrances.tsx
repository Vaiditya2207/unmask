"use client";

import { useEffect } from "react";

// Marks each [data-enter] section once it scrolls into view; CSS staggers its parts.
// It also marks the document as ready, which switches off the CSS fallback that
// shows every part anyway when this script never runs.
export function Entrances() {
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-entrances", "");
    const sections = Array.from(
      document.querySelectorAll<HTMLElement>("[data-enter]"),
    );
    const showAll = () =>
      sections.forEach((s) => s.setAttribute("data-in", ""));
    if (!("IntersectionObserver" in window)) {
      showAll();
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.setAttribute("data-in", "");
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -12% 0px" },
    );
    sections.forEach((s) => observer.observe(s));
    window.addEventListener("beforeprint", showAll);
    return () => {
      observer.disconnect();
      window.removeEventListener("beforeprint", showAll);
    };
  }, []);
  return null;
}
