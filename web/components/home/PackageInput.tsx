"use client";

import { useEffect, useState, type InputHTMLAttributes } from "react";
import { packageSuggestions } from "@/lib/package-search.ts";
import { parseSpec } from "@/lib/registry.ts";

export function PackageInput({
  id,
  value,
  defaultValue,
  onChange,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { id: string }) {
  const [draft, setDraft] = useState(String(defaultValue ?? ""));
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const query = String(value ?? draft);
  useEffect(() => {
    setSuggestions([]);
    const text = query.trim();
    const parsed = parseSpec(text);
    if (
      text.length < 2 ||
      text.length > 214 ||
      (parsed.ok && parsed.version) ||
      !/^[@a-zA-Z0-9._~/-]+$/.test(text)
    )
      return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(
          `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(text)}&size=8`,
          {
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(4000),
            ]),
            credentials: "omit",
          },
        );
        if (!response.ok) return;
        const choices = packageSuggestions(await response.json());
        if (!controller.signal.aborted) setSuggestions(choices);
      } catch {}
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);
  return (
    <>
      <input
        {...props}
        id={id}
        value={query}
        list={`${id}-suggestions`}
        onChange={(event) => {
          setDraft(event.target.value);
          onChange?.(event);
        }}
      />
      <datalist id={`${id}-suggestions`}>
        {suggestions.map((spec) => (
          <option key={spec} value={spec} />
        ))}
      </datalist>
    </>
  );
}
