export const PROMPT_VERSION = "diff-1";
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
