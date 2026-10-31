export const PROMPT_VERSION = "diff-3";
export const MAX_HUNKS = 4;
export const HUNK_FORMAT =
  "source=before artifact=after; line=[op,start,end,text]; -:source-only +:artifact-only space:unchanged(artifact offsets); UTF-8 byte offsets; quote via evidence with same path/side/span";
const MAX_HUNK_LINES = 64;
export const SIGNALS = Object.freeze([
  "lifecycle",
  "dependency",
  "executable",
  "network",
  "secret-access",
  "environment-access",
]);
const INSTALL_HOOKS = new Set([
  "preinstall",
  "install",
  "postinstall",
  "prepare",
  "preprepare",
  "postprepare",
]);
const DEPENDENCY_FIELDS = new Set([
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "bundledDependencies",
  "bundleDependencies",
]);
const ENTRYPOINT_FIELDS = new Set(["main", "module", "bin", "exports"]);
const RULE_SIGNALS = new Map([
  ["lifecycle-source-absent", "lifecycle"],
  ["lifecycle-implicit-gyp", "lifecycle"],
  ["manifest-lifecycle-source-absent", "lifecycle"],
  ["manifest-runtime-dependency-added", "dependency"],
  ["manifest-entrypoint-source-absent", "executable"],
  ["syntax-process-execution", "executable"],
  ["syntax-dynamic-code", "executable"],
  ["syntax-network-call", "network"],
  ["syntax-environment-access", "environment-access"],
  ["behavior-install-remote-shell", "lifecycle"],
  ["behavior-install-network-fetch", "lifecycle"],
  ["behavior-install-inline-execution", "lifecycle"],
  ["behavior-install-credential-access", "lifecycle"],
  ["behavior-encoded-dynamic-code", "executable"],
  ["behavior-encoded-process-execution", "executable"],
  ["behavior-encoded-module-load", "executable"],
  ["behavior-process-remote-shell", "executable"],
  ["behavior-credential-path-reference", "secret-access"],
  ["behavior-sensitive-environment-read", "secret-access"],
  ["behavior-environment-enumeration", "secret-access"],
]);
function fieldSignal(field) {
  if (typeof field !== "string" || !field.startsWith("/")) return undefined;
  const [root, key] = field
    .slice(1)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (root === "scripts" && INSTALL_HOOKS.has(key)) return "lifecycle";
  if (DEPENDENCY_FIELDS.has(root)) return "dependency";
  if (ENTRYPOINT_FIELDS.has(root)) return "executable";
  return undefined;
}
export function evidenceSignal({ ruleId, module, field, priority } = {}) {
  const signal =
    RULE_SIGNALS.get(ruleId) ??
    (module === "manifest" ? fieldSignal(field) : undefined);
  if (!signal) return null;
  // Static behavior cues the analyzer marks HIGH rank with novel static literals.
  const high =
    module === "behavior" &&
    priority === "HIGH" &&
    typeof ruleId === "string" &&
    ruleId.startsWith("behavior-");
  return { signal, rank: SIGNALS.indexOf(signal), high };
}
function linesOf(item) {
  if (!item) return [];
  const result = [];
  let at = item.range[0];
  const parts = item.excerpt.split("\n");
  if (parts.at(-1) === "") parts.pop();
  for (const text of parts) {
    const end = at + Buffer.byteLength(text);
    result.push({ text, range: [at, end] });
    at = end + 1;
  }
  return result;
}
function lineDiff(before, after) {
  const table = Array.from({ length: before.length + 1 }, () =>
    new Array(after.length + 1).fill(0),
  );
  for (let i = before.length - 1; i >= 0; i--)
    for (let j = after.length - 1; j >= 0; j--)
      table[i][j] =
        before[i].text === after[j].text
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
  const lines = [];
  let i = 0,
    j = 0;
  // Emit removals before additions so a replacement reads as - then +.
  while (i < before.length || j < after.length) {
    if (
      i < before.length &&
      j < after.length &&
      before[i].text === after[j].text
    ) {
      lines.push([" ", ...after[j].range, after[j].text]);
      i++;
      j++;
    } else if (
      i < before.length &&
      (j === after.length || table[i + 1][j] >= table[i][j + 1])
    ) {
      lines.push(["-", ...before[i].range, before[i].text]);
      i++;
    } else {
      lines.push(["+", ...after[j].range, after[j].text]);
      j++;
    }
  }
  return lines;
}
export function diffHunk(file, rawEntries, exact) {
  if (
    file?.state !== "changed" ||
    !file.spans ||
    !Array.isArray(file.evidenceIds)
  )
    return null;
  const sides = {};
  for (const side of ["source", "artifact"]) {
    const span = file.spans[side];
    if (
      !Array.isArray(span) ||
      span.length !== 2 ||
      !span.every((n) => Number.isSafeInteger(n) && n >= 0) ||
      span[0] > span[1]
    )
      return null;
    const ids = [
      ...new Set(
        file.evidenceIds.filter((id) => {
          const e = rawEntries.get(id);
          return (
            e?.side === side &&
            e.path === file.path &&
            Array.isArray(e.range) &&
            e.range[0] === span[0] &&
            e.range[1] === span[1]
          );
        }),
      ),
    ];
    if (ids.length !== 1) return null;
    // An empty span is an exact insertion point; a nonempty one needs a complete selected excerpt.
    sides[side] = span[0] === span[1] ? null : exact(ids[0]);
    if (span[0] !== span[1] && !sides[side]) return null;
  }
  const before = linesOf(sides.source),
    after = linesOf(sides.artifact);
  if (
    (!before.length && !after.length) ||
    before.length > MAX_HUNK_LINES ||
    after.length > MAX_HUNK_LINES
  )
    return null;
  return {
    path: file.path,
    change: !before.length ? "added" : !after.length ? "removed" : "modified",
    source: [...file.spans.source],
    artifact: [...file.spans.artifact],
    lines: lineDiff(before, after),
  };
}
