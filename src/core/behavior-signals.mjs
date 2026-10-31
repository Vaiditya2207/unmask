import { parseExpressionAt } from "acorn";

export const BEHAVIOR_LIMITS = Object.freeze({
  manifestBytes: 262144,
  scriptBytes: 8192,
  scriptTokens: 512,
  literalBytes: 4096,
  reviewCues: 128,
  reviewCuesPerFileRule: 8,
  highCues: 128,
});
export const INSTALL_HOOKS = Object.freeze([
  "preinstall",
  "install",
  "postinstall",
]);
const SUMMARIES = {
  "behavior-install-network-fetch":
    "Install hook text references a download tool or URL; a network fetch during install is suspected, not proven. Target code was not executed.",
  "behavior-install-remote-shell":
    "Install hook text appears to pipe downloaded content into an interpreter; this is a suspicion from static text, not observed execution.",
  "behavior-install-inline-execution":
    "Install hook text runs inline interpreter code; the executed content is not proven and was not run.",
  "behavior-install-credential-access":
    "Install hook text references credential files or secret environment values; access is suspected, not proven.",
  "behavior-credential-path-reference":
    "String names a credential-store path; reading or sending it is not proven.",
  "behavior-sensitive-environment-read":
    "Code references a secret-like environment variable; use and disclosure are not proven.",
  "behavior-environment-enumeration":
    "Code enumerates or serializes the whole process environment; disclosure is not proven.",
};
const NETWORK_TOOLS = new Set([
  "curl",
  "wget",
  "invoke-webrequest",
  "iwr",
  "invoke-restmethod",
  "irm",
  "bitsadmin",
  "certutil",
]);
const INTERPRETERS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "node",
  "python",
  "python3",
  "perl",
  "ruby",
  "powershell",
  "pwsh",
  "iex",
  "invoke-expression",
]);
const PREFIXES = new Set(["sudo", "env", "exec", "command", "nohup"]);
const INLINE_FLAGS = {
  node: ["-e", "--eval", "-p", "--print"],
  sh: ["-c"],
  bash: ["-c"],
  zsh: ["-c"],
  dash: ["-c"],
  python: ["-c"],
  python3: ["-c"],
  perl: ["-e"],
  ruby: ["-e"],
  powershell: ["-c", "-command", "-e", "-enc", "-encodedcommand"],
  pwsh: ["-c", "-command", "-e", "-enc", "-encodedcommand"],
  cmd: ["/c", "/k"],
  "cmd.exe": ["/c", "/k"],
};
const CREDENTIAL_PATHS = [
  ".npmrc",
  ".yarnrc",
  ".pypirc",
  ".netrc",
  ".git-credentials",
  ".ssh/",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  ".aws/credentials",
  ".docker/config.json",
  ".kube/config",
  ".config/gcloud",
  ".azure/",
  ".gnupg",
  "/etc/shadow",
  "/etc/passwd",
  ".bash_history",
  ".zsh_history",
  "login data",
  "wallet.dat",
];
const SECRET_NAME =
  /TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|ACCESS_KEY|CREDENTIAL|_AUTH/i;
const ENUMERATORS = new Set([
  "JSON.stringify",
  "Object.keys",
  "Object.entries",
  "Object.values",
  "Object.getOwnPropertyNames",
]);

export const summaryFor = (ruleId) => SUMMARIES[ruleId];
const base = (word) => word.slice(word.lastIndexOf("/") + 1);
const credentialIn = (text) => {
  const lower = text.toLowerCase();
  return CREDENTIAL_PATHS.filter((item) => lower.includes(item));
};
function tokens(script) {
  const result = [];
  let word = "";
  const flush = () => {
    if (word) result.push(word);
    word = "";
  };
  for (const character of script) {
    if (result.length > BEHAVIOR_LIMITS.scriptTokens) return null;
    if (/\s/.test(character) || character === '"' || character === "'") flush();
    else if ("|;&<>()`".includes(character)) {
      flush();
      result.push(character);
    } else word += character;
  }
  flush();
  return result.length > BEHAVIOR_LIMITS.scriptTokens ? null : result;
}
function secretVariables(script) {
  const names = [];
  let index = 0;
  while ((index = script.indexOf("$", index)) !== -1 && names.length < 8) {
    let start = index + 1;
    if (script[start] === "{") start++;
    let end = start;
    while (end < script.length && /[A-Za-z0-9_]/.test(script[end])) end++;
    const name = script.slice(start, end);
    if (SECRET_NAME.test(name)) names.push(name);
    index = end;
  }
  return names;
}

export function scriptSignals(script) {
  if (
    typeof script !== "string" ||
    Buffer.byteLength(script) > BEHAVIOR_LIMITS.scriptBytes
  )
    return { status: "not-assessed", reason: "script-byte-cap", signals: [] };
  let words = tokens(script);
  if (!words)
    return { status: "not-assessed", reason: "script-token-cap", signals: [] };
  const raw = words;
  words = raw.map((word) => word.toLowerCase());
  const signals = [];
  const network = [
    ...new Set(words.filter((word) => NETWORK_TOOLS.has(base(word)))),
  ];
  const urls = raw.filter((word) => /^https?:\/\//i.test(word)).slice(0, 4);
  const firstNetwork = words.findIndex((word) => NETWORK_TOOLS.has(base(word)));
  let piped = null;
  for (let i = firstNetwork + 1; i < words.length && firstNetwork >= 0; i++) {
    if (words[i] !== "|") continue;
    let next = i + 1;
    while (
      next < words.length &&
      (PREFIXES.has(base(words[next])) ||
        words[next].startsWith("-") ||
        /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[next]))
    )
      next++;
    if (INTERPRETERS.has(base(words[next] ?? ""))) piped = base(words[next]);
  }
  for (let i = 0; i < firstNetwork && !piped; i++) {
    const opener =
      words[i] === "`" ||
      (["$", "<"].includes(words[i]) && words[i + 1] === "(");
    const shell = words
      .slice(0, i)
      .findLast((word) => INTERPRETERS.has(base(word)));
    if (opener && shell) piped = base(shell);
  }
  if (network.length && piped)
    signals.push({
      ruleId: "behavior-install-remote-shell",
      priority: "HIGH",
      tools: network,
      interpreter: piped,
    });
  else if (network.length || urls.length)
    signals.push({
      ruleId: "behavior-install-network-fetch",
      priority: "review",
      tools: network,
      urls,
    });
  const inline = [];
  for (let i = 0; i + 1 < words.length; i++) {
    const flags = INLINE_FLAGS[base(words[i])];
    if (flags?.includes(words[i + 1]))
      inline.push(`${base(words[i])} ${words[i + 1]}`);
  }
  if (inline.length)
    signals.push({
      ruleId: "behavior-install-inline-execution",
      priority: "review",
      commands: [...new Set(inline)].slice(0, 4),
    });
  const paths = credentialIn(script);
  const variables = secretVariables(script);
  if (paths.length || variables.length)
    signals.push({
      ruleId: "behavior-install-credential-access",
      priority: "review",
      paths,
      variables,
    });
  const targets = [];
  for (let i = 0; i < words.length; i++) {
    if (base(words[i]) !== "node") continue;
    let next = i + 1;
    while (next < words.length && words[next].startsWith("-")) {
      if (INLINE_FLAGS.node.includes(words[next])) next = words.length;
      next++;
    }
    const target = raw[next]?.replace(/^\.\//, "");
    if (target && /^[\w@.][\w@./-]*$/.test(target) && !target.includes(".."))
      targets.push(
        ...(/\.[cm]?js$/i.test(target)
          ? [target]
          : [target, ...[".js", ".cjs", ".mjs"].map((ext) => target + ext)]),
      );
  }
  return { status: "assessed", signals, targets: targets.slice(0, 16) };
}

export function manifestScriptSpans(text) {
  if (Buffer.byteLength(text) > BEHAVIOR_LIMITS.manifestBytes)
    return { status: "not-assessed", reason: "manifest-byte-cap", hooks: [] };
  let root;
  try {
    root = parseExpressionAt(text, 0, { ecmaVersion: 2025 });
  } catch {
    return {
      status: "not-assessed",
      reason: "manifest-parse-failed",
      hooks: [],
    };
  }
  const key = (property) =>
    property.type === "Property" && property.key.type === "Literal"
      ? property.key.value
      : undefined;
  const scripts =
    root.type === "ObjectExpression" &&
    root.properties.findLast((item) => key(item) === "scripts")?.value;
  const hooks = [];
  if (scripts?.type === "ObjectExpression")
    for (const hook of INSTALL_HOOKS) {
      const value = scripts.properties.findLast(
        (item) => key(item) === hook,
      )?.value;
      if (value?.type === "Literal" && typeof value.value === "string")
        hooks.push({
          hook,
          script: value.value,
          start: value.start,
          end: value.end,
        });
    }
  return { status: "assessed", hooks };
}

function isProcessEnv(node) {
  return (
    node?.type === "MemberExpression" &&
    !node.computed &&
    node.object.type === "Identifier" &&
    node.object.name === "process" &&
    node.property.name === "env"
  );
}
function calleeName(node) {
  if (node.type === "Identifier") return node.name;
  if (
    node.type === "MemberExpression" &&
    !node.computed &&
    node.object.type === "Identifier"
  )
    return `${node.object.name}.${node.property.name}`;
  return "";
}

export function javascriptSignal(node) {
  if (
    (node.type === "Literal" && typeof node.value === "string") ||
    node.type === "TemplateElement"
  ) {
    const value = node.type === "Literal" ? node.value : node.value.cooked;
    if (
      typeof value !== "string" ||
      Buffer.byteLength(value) > BEHAVIOR_LIMITS.literalBytes
    )
      return null;
    const paths = credentialIn(value);
    return paths.length
      ? { ruleId: "behavior-credential-path-reference", paths }
      : null;
  }
  if (node.type === "MemberExpression" && isProcessEnv(node.object)) {
    const name = node.computed
      ? node.property.type === "Literal" &&
        typeof node.property.value === "string"
        ? node.property.value
        : null
      : node.property.name;
    return name && SECRET_NAME.test(name)
      ? { ruleId: "behavior-sensitive-environment-read", variable: name }
      : null;
  }
  if (
    node.type === "CallExpression" &&
    ENUMERATORS.has(calleeName(node.callee)) &&
    isProcessEnv(node.arguments[0])
  )
    return {
      ruleId: "behavior-environment-enumeration",
      via: calleeName(node.callee),
    };
  if (node.type === "ForInStatement" && isProcessEnv(node.right))
    return {
      ruleId: "behavior-environment-enumeration",
      via: "for-in",
      at: node.right,
    };
  return null;
}
