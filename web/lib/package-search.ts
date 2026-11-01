import { parseSpec } from "./registry.ts";

export function packageSuggestions(value: unknown): string[] {
  const objects = (value as { objects?: unknown[] } | null)?.objects;
  if (!Array.isArray(objects)) return [];
  const choices: string[] = [];
  for (const item of objects.slice(0, 20)) {
    const pkg = (
      item as { package?: { name?: unknown; version?: unknown } } | null
    )?.package;
    if (typeof pkg?.name !== "string" || typeof pkg.version !== "string")
      continue;
    const exact = `${pkg.name}@${pkg.version}`;
    if (parseSpec(exact, { exact: true }).ok && !choices.includes(exact))
      choices.push(exact);
    if (choices.length === 8) break;
  }
  return choices;
}
