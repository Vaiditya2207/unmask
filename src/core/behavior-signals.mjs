import { parseExpressionAt } from "acorn";

export const BEHAVIOR_LIMITS = Object.freeze({
  manifestBytes: 262144,
  scriptBytes: 8192,
  scriptTokens: 512,
  literalBytes: 4096,
  linkedScripts: 16,
  linkedScriptBytes: 65536,
  linkedScriptTokens: 8192,
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
    "Install hook text appears to run downloaded content (piped into an interpreter, or saved and then executed); this is a suspicion from static text, not observed execution.",
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
  "behavior-encoded-dynamic-code":
    "Decoded data appears to flow into dynamic code evaluation; this is a static suspicion and nothing was evaluated.",
  "behavior-encoded-process-execution":
    "Decoded data appears to flow into child process execution; this is a static suspicion and nothing was executed.",
  "behavior-encoded-module-load":
    "A module name is statically decoded before being required; loading and use are not proven.",
  "behavior-recursive-overwrite":
    "A recursive directory walker that writes or deletes files is called on a root, parent, home or decoded path; destructive overwrite is suspected from static structure, not observed.",
  "behavior-process-remote-shell":
    "A child process command string pipes downloaded content into an interpreter; this is a static suspicion, not observed execution.",
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
const base = (word) =>
  word
    .slice(Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\")) + 1)
    .replace(/\.exe$/, "");
const credentialIn = (text) => {
  const lower = text.toLowerCase();
  return CREDENTIAL_PATHS.filter((item) => lower.includes(item));
};
function tokens(script, limit = BEHAVIOR_LIMITS.scriptTokens) {
  const result = [];
  let word = "";
  const flush = () => {
    if (word) result.push(word);
    word = "";
  };
  for (const character of script) {
    if (result.length > limit) return null;
    if (character === "\n" || character === "\r") {
      flush();
      result.push(";");
    } else if (/\s/.test(character) || character === '"' || character === "'")
      flush();
    else if ("|;&<>()`".includes(character)) {
      flush();
      result.push(character);
    } else word += character;
  }
  flush();
  return result.length > limit ? null : result;
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

const OUTPUT_FLAGS = new Set([
  "-o",
  "--output",
  "--output-document",
  "-outfile",
]);
const COMMAND_BREAKS = new Set([";", "&", "|", "("]);
const RUNNERS = new Set([
  "start",
  "start-process",
  "regsvr32",
  "rundll32",
  "mshta",
  "cscript",
  "wscript",
]);
const SCRIPT_FILE = /\.(sh|bash|bat|cmd|ps1)$/i;
function linkedScripts(raw) {
  const found = new Set();
  for (const word of raw) {
    const path = word.replace(/^\.[\\/]/, "").replace(/[\\/]+/g, "/");
    if (
      SCRIPT_FILE.test(path) &&
      /^[\w@.][\w@./-]*$/.test(path) &&
      !path.split("/").includes("..")
    )
      found.add(path);
  }
  return [...found].slice(0, 16);
}
function downloadedFile(words, firstNetwork) {
  if (firstNetwork < 0) return null;
  const outputs = new Set();
  for (let i = firstNetwork; i + 1 < words.length; i++) {
    if (OUTPUT_FLAGS.has(words[i]) || words[i] === ">")
      outputs.add(words[i + 1].replace(/^\.[\\/]/, ""));
    if (base(words[i]) !== "certutil") continue;
    for (let at = i + 1; at + 1 < words.length; at++) {
      if (COMMAND_BREAKS.has(words[at])) break;
      if (/^https?:\/\//.test(words[at]) && !COMMAND_BREAKS.has(words[at + 1]))
        outputs.add(words[at + 1].replace(/^\.[\\/]/, ""));
    }
  }
  for (let i = firstNetwork + 1; i < words.length; i++) {
    const word = words[i].replace(/^\.[\\/]/, "");
    if (!outputs.has(word)) continue;
    const before = words[i - 1];
    const ranAsCommand =
      COMMAND_BREAKS.has(before) &&
      (words[i] !== word || /\.(exe|bat|cmd|ps1)$/.test(word));
    const ranByInterpreter =
      INTERPRETERS.has(base(before)) ||
      RUNNERS.has(base(before)) ||
      (RUNNERS.has(base(words[i - 2] ?? "")) && before.startsWith("-"));
    if (ranAsCommand || ranByInterpreter) return word;
  }
  return null;
}

export function scriptSignals(
  script,
  {
    maxBytes = BEHAVIOR_LIMITS.scriptBytes,
    maxTokens = BEHAVIOR_LIMITS.scriptTokens,
  } = {},
) {
  if (typeof script !== "string" || Buffer.byteLength(script) > maxBytes)
    return { status: "not-assessed", reason: "script-byte-cap", signals: [] };
  let words = tokens(script, maxTokens);
  if (!words)
    return { status: "not-assessed", reason: "script-token-cap", signals: [] };
  const raw = words;
  words = raw.map((word) => word.toLowerCase());
  const signals = [];
  const network = [
    ...new Set(words.filter((word) => NETWORK_TOOLS.has(base(word))).map(base)),
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
  const saved = downloadedFile(words, firstNetwork);
  if (!piped && saved) piped = "downloaded-file";
  if (network.length && piped)
    signals.push({
      ruleId: "behavior-install-remote-shell",
      priority: "HIGH",
      tools: network,
      interpreter: piped,
      ...(piped === "downloaded-file" ? { file: saved } : {}),
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
  return {
    status: "assessed",
    signals,
    targets: targets.slice(0, 16),
    scripts: linkedScripts(raw),
  };
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

export const OBFUSCATION_LIMITS = Object.freeze({
  sinksPerFile: 1024,
  subtreeNodes: 64,
  subtreeDepth: 8,
  bindingHops: 2,
  payloadBytes: 65536,
  payloadMinLength: 40,
  charCodes: 4096,
});
const DYNAMIC_SINKS = new Set([
  "eval",
  "globalThis.eval",
  "global.eval",
  "window.eval",
  "Function",
  "globalThis.Function",
  "vm.runInThisContext",
  "vm.runInNewContext",
  "vm.runInContext",
  "vm.compileFunction",
  "vm.Script",
]);
const PROCESS_SINKS = new Set(
  [
    "exec",
    "execSync",
    "spawn",
    "spawnSync",
    "execFile",
    "execFileSync",
    "fork",
  ].map((name) => `child_process.${name}`),
);
const DECODERS = new Set([
  "atob",
  "globalThis.atob",
  "window.atob",
  "Buffer.from",
  "Buffer",
  "String.fromCharCode",
  "unescape",
  "decodeURIComponent",
  "zlib.inflateSync",
  "zlib.inflateRawSync",
  "zlib.gunzipSync",
  "zlib.unzipSync",
  "zlib.brotliDecompressSync",
]);
const ENCODINGS = new Set(["base64", "base64url", "hex"]);
const SENSITIVE_MODULES = new Set([
  "child_process",
  "vm",
  "fs",
  "http",
  "https",
  "net",
  "dns",
  "os",
  "worker_threads",
]);
const DECODED_HINTS = [
  "child_process",
  "require(",
  "eval(",
  "Function(",
  "http://",
  "https://",
  "process.env",
  ".npmrc",
  "/bin/sh",
];
const MODULES = new Set(["child_process", "vm", "zlib", "module"]);

function stringLiteral(node) {
  return node?.type === "Literal" && typeof node.value === "string"
    ? node.value
    : null;
}
function requiredModule(node) {
  return node?.type === "CallExpression" &&
    node.callee.type === "Identifier" &&
    node.callee.name === "require" &&
    node.arguments.length === 1
    ? stringLiteral(node.arguments[0])?.replace(/^node:/, "")
    : undefined;
}
function qualified(node, aliases, depth = 0) {
  if (!node || depth > 4) return "";
  if (node.type === "Identifier") return aliases.get(node.name) ?? node.name;
  const module = requiredModule(node);
  if (module !== undefined) return module;
  if (node.type === "MemberExpression") {
    const property = node.computed
      ? stringLiteral(node.property)
      : node.property.name;
    const object = qualified(node.object, aliases, depth + 1);
    return property && object ? `${object}.${property}` : "";
  }
  return "";
}
export const NETWORK_MODULES = new Set(["http", "https", "net"]);
export function moduleAliases(all, modules = MODULES) {
  const aliases = new Map();
  for (const node of all) {
    if (node.type !== "VariableDeclarator" || !node.init) continue;
    const module = requiredModule(node.init);
    if (!modules.has(module)) continue;
    if (node.id.type === "Identifier") aliases.set(node.id.name, module);
    else if (node.id.type === "ObjectPattern")
      for (const property of node.id.properties)
        if (
          property.type === "Property" &&
          !property.computed &&
          property.key.type === "Identifier" &&
          property.value.type === "Identifier"
        )
          aliases.set(property.value.name, `${module}.${property.key.name}`);
  }
  for (const node of all)
    if (node.type === "ImportDeclaration") {
      const module = stringLiteral(node.source)?.replace(/^node:/, "");
      if (!modules.has(module)) continue;
      for (const item of node.specifiers)
        aliases.set(
          item.local.name,
          item.type === "ImportSpecifier"
            ? `${module}.${item.imported.name ?? item.imported.value}`
            : module,
        );
    }
  return aliases;
}
function singleBindings(all) {
  const counts = new Map(),
    inits = new Map();
  for (const node of all)
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier") {
      counts.set(node.id.name, (counts.get(node.id.name) || 0) + 1);
      if (node.init) inits.set(node.id.name, node.init);
    } else if (
      node.type === "AssignmentExpression" &&
      node.left.type === "Identifier"
    )
      counts.set(node.left.name, (counts.get(node.left.name) || 0) + 2);
  for (const [name, count] of counts) if (count !== 1) inits.delete(name);
  return inits;
}
function isEncodedText(value) {
  return (
    value.length >= OBFUSCATION_LIMITS.payloadMinLength &&
    value.length <= OBFUSCATION_LIMITS.payloadBytes &&
    /^[A-Za-z0-9+/=_-]+$/.test(value)
  );
}
function decoderOf(node, aliases) {
  if (!["CallExpression", "NewExpression"].includes(node.type)) return null;
  const name = qualified(node.callee, aliases);
  if (name.startsWith("decoder-helper:")) {
    const [, helper, encoding] = name.split(":");
    return `${helper}():${encoding}`;
  }
  if (!DECODERS.has(name)) return null;
  if (name === "Buffer.from" || name === "Buffer") {
    const encoding = stringLiteral(node.arguments[1]);
    return ENCODINGS.has(encoding) ? `${name}:${encoding}` : null;
  }
  if (name === "unescape" || name === "decodeURIComponent") {
    const value = stringLiteral(node.arguments[0]);
    return value &&
      value.length >= OBFUSCATION_LIMITS.payloadMinLength &&
      value.includes("%")
      ? name
      : null;
  }
  return name;
}
function literalArgument(node, bindings) {
  const first = node.arguments[0];
  const bound = first?.type === "Identifier" && bindings?.get(first.name);
  return stringLiteral(bound) !== null ? bound : first;
}
function decodeLiteral(decoder, node, bindings) {
  if (decoder === "String.fromCharCode") {
    if (node.arguments.length > OBFUSCATION_LIMITS.charCodes) return null;
    const codes = node.arguments.map((item) =>
      item.type === "Literal" && Number.isInteger(item.value) ? item.value : -1,
    );
    return codes.every((code) => code >= 0 && code <= 0xffff)
      ? String.fromCharCode(...codes)
      : null;
  }
  const value = stringLiteral(literalArgument(node, bindings));
  if (value === null || value.length > OBFUSCATION_LIMITS.payloadBytes)
    return null;
  if (decoder === "unescape" || decoder === "decodeURIComponent")
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  if (["atob", "globalThis.atob", "window.atob"].includes(decoder))
    return Buffer.from(value, "base64").toString("latin1");
  const [, encoding] = decoder.split(":");
  return encoding ? Buffer.from(value, encoding).toString("utf8") : null;
}
function payloadFacts(decoded) {
  return {
    decodedBytes: Buffer.byteLength(decoded),
    decodedHints: DECODED_HINTS.filter((hint) => decoded.includes(hint)),
  };
}
const OPAQUE = new Set([
  "FunctionExpression",
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "ClassExpression",
  "ClassDeclaration",
]);
function codeArguments(name, node) {
  const args = node.arguments;
  if (name === "Function" || name === "globalThis.Function") return args;
  if (
    /^child_process\.(spawn|spawnSync|execFile|execFileSync|fork)$/.test(name)
  )
    return args.slice(0, 2);
  return args.slice(0, 1);
}
function findDecoder(starts, aliases, bindings) {
  const stack = starts.toReversed().map((item) => [item, 0, 0]);
  const seen = new Set();
  let visited = 0,
    truncated = false;
  while (stack.length && visited < OBFUSCATION_LIMITS.subtreeNodes) {
    const [node, depth, hops] = stack.pop();
    if (!node || seen.has(node) || OPAQUE.has(node.type)) continue;
    seen.add(node);
    visited++;
    const decoder = decoderOf(node, aliases);
    if (decoder) {
      const candidate = literalArgument(node, bindings);
      const payload =
        stringLiteral(candidate) !== null &&
        (isEncodedText(candidate.value) ||
          decoder === "unescape" ||
          decoder === "decodeURIComponent")
          ? candidate
          : undefined;
      const decoded = decodeLiteral(decoder, node, bindings);
      return {
        decoder: decoder.split(":")[0],
        encoding: decoder.split(":")[1],
        node,
        payload,
        ...(decoded === null ? {} : payloadFacts(decoded)),
      };
    }
    if (node.type === "Identifier" && hops < OBFUSCATION_LIMITS.bindingHops) {
      const init = bindings.get(node.name);
      if (init) stack.push([init, 0, hops + 1]);
      continue;
    }
    if (depth >= OBFUSCATION_LIMITS.subtreeDepth) {
      truncated ||= !["Literal", "Identifier", "TemplateElement"].includes(
        node.type,
      );
      continue;
    }
    const children = [];
    for (const [key, value] of Object.entries(node)) {
      if (key === "callee" && node.type === "CallExpression") {
        if (value.type === "MemberExpression") children.push(value.object);
        continue;
      }
      if (Array.isArray(value)) {
        for (const item of value) if (item?.type) children.push(item);
      } else if (value?.type) children.push(value);
    }
    for (const child of children.reverse())
      stack.push([child, depth + 1, hops]);
  }
  return truncated || stack.length ? { capped: true } : null;
}

function unwrapToString(node) {
  return node?.type === "CallExpression" &&
    node.callee.type === "MemberExpression" &&
    !node.callee.computed &&
    node.callee.property.name === "toString"
    ? node.callee.object
    : node;
}
function decodeHelpers(all, aliases) {
  for (const node of all) {
    const [name, fn] =
      node.type === "FunctionDeclaration" && node.id
        ? [node.id.name, node]
        : node.type === "VariableDeclarator" &&
            node.id.type === "Identifier" &&
            FUNCTIONS.has(node.init?.type)
          ? [node.id.name, node.init]
          : [];
    const param = fn?.params[0];
    if (param?.type !== "Identifier") continue;
    const body =
      fn.body.type === "BlockStatement"
        ? fn.body.body.length === 1 &&
          fn.body.body[0].type === "ReturnStatement"
          ? fn.body.body[0].argument
          : null
        : fn.body;
    const call = unwrapToString(body);
    const decoder = call && decoderOf(call, aliases);
    if (
      !decoder ||
      call.arguments[0]?.type !== "Identifier" ||
      call.arguments[0].name !== param.name
    )
      continue;
    const encoding = decoder.split(":")[1] || "base64";
    aliases.set(name, `decoder-helper:${name}:${encoding}`);
  }
}
function moduleInstances(all, aliases) {
  const names = new Set();
  for (const node of all)
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.init?.type === "NewExpression" &&
      ["module.constructor", "module"].includes(
        qualified(node.init.callee, aliases),
      )
    )
      names.add(node.id.name);
  return names;
}

export function obfuscationSignals(all) {
  const aliases = moduleAliases(all);
  decodeHelpers(all, aliases);
  const instances = moduleInstances(all, aliases);
  const requires = new Set(["require"]);
  for (const node of all)
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.init?.type === "Identifier" &&
      node.init.name === "require"
    )
      requires.add(node.id.name);
  const bindings = singleBindings(all);
  const signals = [];
  let sinks = 0,
    capped = false;
  for (const node of all) {
    if (!["CallExpression", "NewExpression"].includes(node.type)) continue;
    const callee = node.callee;
    const instanceCall =
      callee.type === "MemberExpression" &&
      callee.object.type === "Identifier" &&
      instances.has(callee.object.name);
    const name = instanceCall
      ? callee.computed
        ? "Module#[computed]"
        : `Module#${callee.property.name}`
      : qualified(callee, aliases);
    const module = requiredModule(node);
    if (instanceCall && callee.computed) {
      const found = findDecoder([callee.property], aliases, bindings);
      if (found && !found.capped) {
        if (++sinks > OBFUSCATION_LIMITS.sinksPerFile) {
          capped = true;
          break;
        }
        signals.push({
          ruleId: "behavior-encoded-dynamic-code",
          priority: "HIGH",
          node,
          related: [found.node].filter((item) => item !== node),
          detail: {
            sink: name,
            decoder: found.decoder,
            decodedProperty: true,
          },
        });
        continue;
      }
    }
    const dynamic = DYNAMIC_SINKS.has(name) || name === "Module#_compile";
    const spawnsProcess = PROCESS_SINKS.has(name);
    const encodedRequire =
      node.callee.type === "Identifier" &&
      requires.has(node.callee.name) &&
      module === undefined &&
      node.arguments.length === 1;
    if (!dynamic && !spawnsProcess && !encodedRequire) continue;
    if (++sinks > OBFUSCATION_LIMITS.sinksPerFile) {
      capped = true;
      break;
    }
    if (spawnsProcess) {
      const command = stringLiteral(node.arguments[0]);
      const remote =
        command !== null &&
        scriptSignals(command).signals?.find(
          (item) => item.ruleId === "behavior-install-remote-shell",
        );
      if (remote) {
        signals.push({
          ruleId: "behavior-process-remote-shell",
          priority: "HIGH",
          node,
          related: [],
          detail: {
            sink: name,
            tools: remote.tools,
            interpreter: remote.interpreter,
          },
        });
        continue;
      }
    }
    const found = node.arguments.length
      ? findDecoder(
          codeArguments(encodedRequire ? "require" : name, node),
          aliases,
          bindings,
        )
      : null;
    if (found?.capped) {
      capped = true;
      continue;
    }
    if (!found) continue;
    const { node: decoderNode, payload, decoder, encoding, ...facts } = found;
    const detail = {
      sink: encodedRequire ? "require" : name,
      decoder,
      ...(encoding ? { encoding } : {}),
      ...facts,
    };
    const ruleId = dynamic
      ? "behavior-encoded-dynamic-code"
      : spawnsProcess
        ? "behavior-encoded-process-execution"
        : "behavior-encoded-module-load";
    let priority = "HIGH";
    if (encodedRequire) {
      const decoded = decodeLiteral(
        decoderOf(decoderNode, aliases),
        decoderNode,
        bindings,
      );
      if (decoded === null) continue;
      const printable = decoded.length <= 64 && /^[\x20-\x7e]+$/.test(decoded);
      if (printable) detail.decodedModule = decoded.replace(/^node:/, "");
      priority = SENSITIVE_MODULES.has(detail.decodedModule)
        ? "HIGH"
        : "review";
    }
    signals.push({
      ruleId,
      priority,
      node,
      related: [decoderNode, ...(payload ? [payload] : [])].filter(
        (item) => item !== node,
      ),
      detail,
    });
  }
  return { signals, capped };
}

export const DESTRUCTIVE_LIMITS = Object.freeze({
  functions: 512,
  bodyNodes: 4096,
  callSites: 64,
  decodedPerName: 16,
});
const FS_MODULES = new Set(["fs", "fs/promises", "graceful-fs", "fs-extra"]);
const LISTING = new Set(["readdirSync", "readdir", "opendirSync", "opendir"]);
const MUTATING = new Set([
  "writeFile",
  "writeFileSync",
  "appendFile",
  "appendFileSync",
  "unlink",
  "unlinkSync",
  "rm",
  "rmSync",
  "rmdir",
  "rmdirSync",
  "truncate",
  "truncateSync",
  "createWriteStream",
]);
const ROOT_TARGETS = new Set([
  "/",
  "\\",
  "..",
  "../",
  "../..",
  "../../",
  "~",
  "~/",
  "C:\\",
  "C:/",
]);
const DECODED_ROOT_TARGETS = new Set([...ROOT_TARGETS, ".", "./"]);
const FUNCTIONS = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);
function fsOperation(node, aliases) {
  if (node.type !== "CallExpression") return null;
  const name = qualified(node.callee, aliases);
  const parts = name.split(".");
  return FS_MODULES.has(parts[0]) ? parts.at(-1) : null;
}
function namedFunctions(all) {
  const result = [];
  for (const node of all) {
    if (node.type === "FunctionDeclaration" && node.id)
      result.push([node.id.name, node]);
    else if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      FUNCTIONS.has(node.init?.type)
    )
      result.push([node.id.name, node.init]);
  }
  return result;
}
function walkerFacts(name, fn, aliases) {
  const facts = {};
  const stack = [fn.body];
  let visited = 0;
  while (stack.length) {
    if (++visited > DESTRUCTIVE_LIMITS.bodyNodes) return { capped: true };
    const node = stack.pop();
    if (node.type === "CallExpression") {
      const operation = fsOperation(node, aliases);
      if (LISTING.has(operation)) facts.listing ??= node;
      if (MUTATING.has(operation)) facts.mutation ??= [node, operation];
      if (node.callee.type === "Identifier" && node.callee.name === name)
        facts.recursion ??= node;
    }
    for (const value of Object.values(node))
      if (Array.isArray(value)) {
        for (const item of value) if (item?.type) stack.push(item);
      } else if (value?.type) stack.push(value);
  }
  return facts;
}
function decodedValues(all, aliases) {
  const values = new Map();
  for (const node of all) {
    if (node.type !== "VariableDeclarator" || node.id.type !== "Identifier")
      continue;
    let init = node.init;
    if (
      init?.type === "CallExpression" &&
      init.callee.type === "MemberExpression" &&
      !init.callee.computed &&
      init.callee.property.name === "toString"
    )
      init = init.callee.object;
    const decoder = init && decoderOf(init, aliases);
    const decoded = decoder && decodeLiteral(decoder, init);
    if (typeof decoded !== "string") continue;
    const list = values.get(node.id.name) ?? [];
    if (list.length < DESTRUCTIVE_LIMITS.decodedPerName) list.push(decoded);
    values.set(node.id.name, list);
  }
  return values;
}
function targetOf(arg, aliases, decoded) {
  const literal = stringLiteral(arg);
  if (literal !== null)
    return ROOT_TARGETS.has(literal)
      ? { via: "literal", targets: [literal] }
      : null;
  if (
    arg?.type === "CallExpression" &&
    qualified(arg.callee, aliases).endsWith("homedir")
  )
    return { via: "home-directory", targets: ["~"] };
  let base = arg;
  if (
    base?.type === "CallExpression" &&
    base.callee.type === "MemberExpression" &&
    !base.callee.computed &&
    base.callee.property.name === "toString"
  )
    base = base.callee.object;
  const decoder = base && decoderOf(base, aliases);
  const values = decoder
    ? [decodeLiteral(decoder, base)].filter((v) => typeof v === "string")
    : base?.type === "Identifier"
      ? decoded.get(base.name) || []
      : [];
  const roots = values.filter((value) => DECODED_ROOT_TARGETS.has(value));
  return roots.length ? { via: "decoded", targets: [...new Set(roots)] } : null;
}

export function destructiveSignals(all) {
  const aliases = new Map([
    ...moduleAliases(all, FS_MODULES),
    ...moduleAliases(all, new Set(["os"])),
  ]);
  const functions = namedFunctions(all);
  if (functions.length > DESTRUCTIVE_LIMITS.functions)
    return { signals: [], capped: true };
  const walkers = new Map();
  let capped = false;
  for (const [name, fn] of functions) {
    const facts = walkerFacts(name, fn, aliases);
    if (facts.capped) capped = true;
    else if (facts.listing && facts.mutation && facts.recursion)
      walkers.set(name, facts);
  }
  const signals = [];
  if (!walkers.size) return { signals, capped };
  const decoded = decodedValues(all, moduleAliases(all));
  const reported = new Set();
  let sites = 0;
  for (const node of all) {
    if (
      node.type !== "CallExpression" ||
      node.callee.type !== "Identifier" ||
      !walkers.has(node.callee.name) ||
      reported.has(node.callee.name)
    )
      continue;
    if (++sites > DESTRUCTIVE_LIMITS.callSites) {
      capped = true;
      break;
    }
    const target = targetOf(node.arguments[0], aliases, decoded);
    if (!target) continue;
    const facts = walkers.get(node.callee.name);
    reported.add(node.callee.name);
    signals.push({
      ruleId: "behavior-recursive-overwrite",
      priority: "HIGH",
      node,
      related: [facts.mutation[0], facts.listing],
      detail: {
        walker: node.callee.name,
        operation: facts.mutation[1],
        via: target.via,
        targets: target.targets,
      },
    });
  }
  return { signals, capped };
}
