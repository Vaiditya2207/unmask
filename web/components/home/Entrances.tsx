"use client";

import { useEffect } from "react";

// Marks each [data-enter] section once it scrolls into view; CSS staggers its parts.
export function Entrances() {
  useEffect(() => {
    const sections = Array.from(
      document.querySelectorAll<HTMLElement>("[data-enter]"),
    );
    if (!("IntersectionObserver" in window)) {
      sections.forEach((s) => s.setAttribute("data-in", ""));
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
    const showAll = () =>
      sections.forEach((s) => s.setAttribute("data-in", ""));
    window.addEventListener("beforeprint", showAll);
    return () => {
      observer.disconnect();
      window.removeEventListener("beforeprint", showAll);
    };
  }, []);
  return null;
}
