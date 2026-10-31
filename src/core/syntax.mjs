import { parse } from "acorn";
import { createHash } from "node:crypto";
import { validateReport } from "./report.mjs";
import {
  BEHAVIOR_LIMITS,
  javascriptSignal,
  manifestScriptSpans,
  destructiveSignals,
  DESTRUCTIVE_LIMITS,
  moduleAliases,
  NETWORK_MODULES,
  obfuscationSignals,
  OBFUSCATION_LIMITS,
  scriptSignals,
  summaryFor,
} from "./behavior-signals.mjs";

export const SYNTAX_LIMITS = Object.freeze({
  fileBytes: 2097152,
  totalBytesPerSide: 8388608,
  tokens: 200000,
  cues: 1000,
  sourceLiterals: 10000,
});
const hash = (value) => createHash("sha256").update(value).digest("hex");
function offsets(text) {
  const result = new Uint32Array(text.length + 1);
  let index = 0,
    bytes = 0;
  for (const character of text) {
    result[index] = bytes;
    if (character.length === 2) result[index + 1] = bytes;
    index += character.length;
    bytes += Buffer.byteLength(character);
    result[index] = bytes;
  }
  return result;
}
function evidenceFor(side, inventory, entry, node, positions) {
  const range = [positions[node.start], positions[node.end]];
  const identity = [
    side,
    inventory.digest.sha256,
    entry.path ?? entry.originalPath,
    range,
  ];
  const evidence = {
    id: `ev-${hash(JSON.stringify(identity))}`,
    side,
    blobDigest: inventory.digest.sha256,
    path: entry.path,
    originalPath: entry.originalPath,
    fileSha256: entry.sha256,
    size: entry.size,
    range,
  };
  let end = Math.min(range[1], range[0] + 512);
  while (end > range[0]) {
    try {
      evidence.excerpt = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(entry.content.subarray(range[0], end));
      evidence.excerptRange = [range[0], end];
      break;
    } catch {
      end--;
    }
  }
  return evidence;
}
function nameOf(node) {
  const parts = [];
  for (let depth = 0; node && depth < 4; depth++) {
    if (node.type === "Identifier") return [node.name, ...parts].join(".");
    if (
      node.type === "CallExpression" &&
      node.callee?.type === "Identifier" &&
      node.callee.name === "require" &&
      node.arguments.length === 1 &&
      node.arguments[0].type === "Literal" &&
      typeof node.arguments[0].value === "string"
    ) {
      const module = node.arguments[0].value.replace(/^node:/, "");
      return ["child_process", "http", "https", "net"].includes(module)
        ? [module, ...parts].join(".")
        : "";
    }
    if (node.type !== "MemberExpression" || node.computed) return "";
    parts.unshift(node.property.name);
    node = node.object;
  }
  return "";
}
function aliasedName(callee, aliases) {
  if (callee?.type === "Identifier") return aliases.get(callee.name) ?? "";
  if (
    callee?.type === "MemberExpression" &&
    !callee.computed &&
    callee.object.type === "Identifier" &&
    aliases.has(callee.object.name)
  )
    return `${aliases.get(callee.object.name)}.${callee.property.name}`;
  return "";
}
function capability(node, aliases) {
  const name = nameOf(node.callee);
  const aliased = aliases?.size ? aliasedName(node.callee, aliases) : "";
  if (
    node.type === "CallExpression" &&
    aliased &&
    /^(https?\.(request|get)|net\.connect)$/.test(aliased)
  )
    return "network-call";
  if (
    node.type === "CallExpression" &&
    /^(fetch|globalThis.fetch|https?\.(request|get)|net\.connect)$/.test(name)
  )
    return "network-call";
  if (
    node.type === "CallExpression" &&
    /^(child_process\.)?(exec|execSync|execFile|execFileSync|spawn|spawnSync)$/.test(
      name,
    )
  )
    return "process-execution";
  if (
    ["CallExpression", "NewExpression"].includes(node.type) &&
    /^(eval|Function)$/.test(name)
  )
    return "dynamic-code";
  if (
    node.type === "MemberExpression" &&
    nameOf(node).startsWith("process.env.")
  )
    return "environment-access";
  return null;
}
function nodes(ast) {
  const stack = [ast],
    result = [];
  while (stack.length) {
    const node = stack.pop();
    result.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (let i = value.length - 1; i >= 0; i--)
          if (value[i]?.type) stack.push(value[i]);
      } else if (value?.type) stack.push(value);
    }
  }
  return result;
}

export function inspectJavaScript(artifact, source, overrides = {}) {
  const limits = { ...SYNTAX_LIMITS };
  for (const [key, value] of Object.entries(overrides)) {
    if (
      !(key in limits) ||
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > limits[key]
    )
      throw new TypeError("Syntax limits may only lower defaults");
    limits[key] = value;
  }
  const result = {
    cues: [],
    evidence: [],
    coverage: { files: 0, bytes: 0 },
    sourceCoverage: { files: 0, bytes: 0 },
    annotations: [],
    limits,
  };
  const literals = new Map(),
    candidates = [],
    evidence = new Map();
  let sourceLiteralTruncated = false,
    syntaxCount = 0;
  const hookTargets = new Map();
  const linked = new Map();
  const link = (path, hooks, from) => {
    const item = linked.get(path) ?? { hooks: new Set(), from: new Set() };
    for (const hook of hooks) item.hooks.add(hook);
    item.from.add(from);
    if (linked.has(path) || linked.size < BEHAVIOR_LIMITS.linkedScripts)
      linked.set(path, item);
  };
  const behaviorUse = { review: 0, HIGH: 0, perFileRule: new Map() };
  const admitBehavior = (priority, path, ruleId) => {
    const key = `${path}\0${ruleId}`;
    const used = behaviorUse.perFileRule.get(key) || 0;
    const tier = priority === "HIGH" ? "HIGH" : "review";
    const cap =
      tier === "HIGH" ? BEHAVIOR_LIMITS.highCues : BEHAVIOR_LIMITS.reviewCues;
    if (
      used >= 0 &&
      behaviorUse[tier] < cap &&
      (tier === "HIGH" || used < BEHAVIOR_LIMITS.reviewCuesPerFileRule)
    ) {
      behaviorUse[tier]++;
      behaviorUse.perFileRule.set(key, used + 1);
      return true;
    }
    if (used !== -1) {
      behaviorUse.perFileRule.set(key, -1);
      result.annotations.push({
        type: "behavior-not-inspected",
        side: "artifact",
        path,
        ruleId,
        reason: "behavior-cue-cap",
      });
    }
    return false;
  };
  const manifest = (artifact?.entries || []).find(
    (entry) => entry.type === "file" && entry.path === "package.json",
  );
  let behaviorManifest = { status: "not-assessed", reason: "not-retained" };
  if (Buffer.isBuffer(manifest?.content))
    try {
      const text = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(manifest.content);
      const positions = offsets(text);
      const parsed = manifestScriptSpans(text);
      behaviorManifest = parsed.reason
        ? { status: parsed.status, reason: parsed.reason }
        : { status: parsed.status };
      for (const item of parsed.hooks) {
        const assessed = scriptSignals(item.script);
        if (assessed.status !== "assessed")
          result.annotations.push({
            type: "behavior-not-inspected",
            side: "artifact",
            path: manifest.path,
            hook: item.hook,
            reason: assessed.reason,
          });
        for (const script of assessed.scripts || [])
          link(script, [item.hook], `package.json#scripts.${item.hook}`);
        for (const target of assessed.targets || [])
          hookTargets.set(target, [
            ...new Set([...(hookTargets.get(target) || []), item.hook]),
          ]);
        for (const { ruleId, priority, ...signal } of assessed.signals)
          if (admitBehavior(priority, manifest.path, ruleId))
            candidates.push({
              behavior: { ruleId, priority, hook: item.hook, ...signal },
              evidence: evidenceFor(
                "artifact",
                artifact,
                manifest,
                item,
                positions,
              ),
            });
      }
    } catch {
      behaviorManifest = { status: "not-assessed", reason: "invalid-utf8" };
    }
  for (const [side, inventory] of [
    ["artifact", artifact],
    ["source", source],
  ]) {
    let consumed = 0;
    const entries = (inventory?.entries || [])
      .filter((entry) => entry.type === "file")
      .sort((a, b) =>
        a.originalPath < b.originalPath
          ? -1
          : a.originalPath > b.originalPath
            ? 1
            : 0,
      );
    for (const entry of entries) {
      const skip = (reason) =>
        result.annotations.push({
          type: "syntax-not-inspected",
          side,
          path: entry.path,
          originalPath: entry.originalPath,
          reason,
        });
      if (!/\.(?:mjs|cjs|js)$/.test(entry.path || entry.originalPath)) {
        skip("unsupported-syntax");
        continue;
      }
      if (!Buffer.isBuffer(entry.content)) {
        skip("not-retained");
        continue;
      }
      if (entry.size > limits.fileBytes) {
        skip("syntax-file-cap");
        continue;
      }
      if (consumed + entry.size > limits.totalBytesPerSide) {
        skip("syntax-total-cap");
        continue;
      }
      consumed += entry.size;
      let text, ast;
      try {
        text = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(entry.content);
        const parseAs = (sourceType) => {
          let tokens = 0;
          return parse(text, {
            ecmaVersion: 2025,
            sourceType,
            allowHashBang: true,
            onToken() {
              if (++tokens > limits.tokens) throw new Error("syntax-token-cap");
            },
          });
        };
        try {
          ast = parseAs("module");
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          ast = parseAs("commonjs");
        }
      } catch (error) {
        skip(
          error.message === "syntax-token-cap" ? error.message : "parse-failed",
        );
        continue;
      }
      const coverage =
        side === "artifact" ? result.coverage : result.sourceCoverage;
      coverage.files++;
      coverage.bytes += entry.size;
      const positions = offsets(text);
      const all = nodes(ast);
      const networkAliases =
        side === "artifact" ? moduleAliases(all, NETWORK_MODULES) : null;
      if (side === "artifact") {
        const hooks = hookTargets.get(entry.path);
        const found = obfuscationSignals(all);
        if (found.capped) skip("behavior-obfuscation-cap");
        const destructive = destructiveSignals(all);
        if (destructive.capped) skip("behavior-destructive-cap");
        found.signals.push(...destructive.signals);
        for (const {
          ruleId,
          priority,
          node,
          related,
          detail,
        } of found.signals) {
          if (admitBehavior(priority, entry.path, ruleId))
            candidates.push({
              behavior: { ruleId, priority, ...detail },
              hooks,
              evidence: evidenceFor(side, inventory, entry, node, positions),
              related: related.map((item) =>
                evidenceFor(side, inventory, entry, item, positions),
              ),
            });
        }
      }
      for (const node of all) {
        if (side === "source") {
          if (
            node.type === "Literal" &&
            typeof node.value === "string" &&
            !literals.has(node.value)
          ) {
            if (literals.size < limits.sourceLiterals)
              literals.set(
                node.value,
                evidenceFor(side, inventory, entry, node, positions),
              );
            else sourceLiteralTruncated = true;
          }
          continue;
        }
        const kind = capability(node, networkAliases);
        const signal = javascriptSignal(node);
        if (!kind && !signal) continue;
        if (kind && syntaxCount >= limits.cues) {
          skip("syntax-cue-cap");
          break;
        }
        const hooks = hookTargets.get(entry.path);
        syntaxCount += kind ? 1 : 0;
        if (kind)
          candidates.push({
            kind,
            hooks,
            evidence: evidenceFor(side, inventory, entry, node, positions),
            literal:
              node.arguments?.[0]?.type === "Literal" &&
              typeof node.arguments[0].value === "string"
                ? node.arguments[0].value
                : null,
          });
        if (signal && admitBehavior("review", entry.path, signal.ruleId)) {
          const { ruleId, at, ...detail } = signal;
          candidates.push({
            behavior: { ruleId, priority: "review", ...detail },
            hooks,
            evidence: evidenceFor(
              side,
              inventory,
              entry,
              at || node,
              positions,
            ),
          });
        }
      }
    }
  }
  for (const candidate of candidates)
    if (
      candidate.kind === "process-execution" &&
      candidate.hooks &&
      candidate.literal !== null
    )
      for (const script of scriptSignals(candidate.literal).scripts || [])
        link(script, candidate.hooks, candidate.evidence.path);
  for (const [path, { hooks, from }] of linked) {
    const entry = artifact.entries.find(
      (item) => item.type === "file" && item.path === path,
    );
    const unscanned = (reason) =>
      result.annotations.push({
        type: "behavior-not-inspected",
        side: "artifact",
        path,
        reason,
      });
    if (!entry) {
      unscanned("linked-script-missing");
      continue;
    }
    if (!Buffer.isBuffer(entry.content)) {
      unscanned("not-retained");
      continue;
    }
    if (entry.size > BEHAVIOR_LIMITS.linkedScriptBytes) {
      unscanned("linked-script-byte-cap");
      continue;
    }
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        entry.content,
      );
    } catch {
      unscanned("invalid-utf8");
      continue;
    }
    const assessed = scriptSignals(text, {
      maxBytes: BEHAVIOR_LIMITS.linkedScriptBytes,
      maxTokens: BEHAVIOR_LIMITS.linkedScriptTokens,
    });
    if (assessed.status !== "assessed") {
      unscanned(assessed.reason);
      continue;
    }
    const positions = offsets(text);
    const lines = [];
    for (let start = 0; start < text.length;) {
      const stop = text.indexOf("\n", start);
      const end = stop === -1 ? text.length : stop;
      lines.push({ start, end, lower: text.slice(start, end).toLowerCase() });
      start = end + 1;
    }
    for (const { ruleId, priority, ...signal } of assessed.signals) {
      const words = [
        ...(signal.tools || []),
        ...(signal.file ? [signal.file.toLowerCase()] : []),
        ...(signal.paths || []),
        ...(signal.variables || []).map((name) => name.toLowerCase()),
        ...(signal.commands || []).map((command) => command.split(" ")[0]),
      ];
      const cited = lines
        .filter((line) => words.some((word) => line.lower.includes(word)))
        .slice(0, 3);
      if (!cited.length || !admitBehavior(priority, path, ruleId)) continue;
      const [first, ...rest] = cited.map((line) =>
        evidenceFor("artifact", artifact, entry, line, positions),
      );
      candidates.push({
        behavior: {
          ruleId,
          priority,
          script: path,
          linkedFrom: [...from].sort(),
          ...signal,
        },
        hooks: [...hooks].sort(),
        evidence: first,
        related: rest,
      });
    }
  }
  const stem = (value) => value.replace(/\.[cm]?[jt]sx?$/, "");
  const unknownSource = new Set(
    result.annotations
      .filter(
        (item) =>
          item.type === "syntax-not-inspected" && item.side === "source",
      )
      .map((item) => stem(item.path || item.originalPath)),
  );
  for (const candidate of candidates) {
    const ids = [candidate.evidence.id];
    evidence.set(candidate.evidence.id, candidate.evidence);
    const hookTarget = candidate.hooks
      ? { installHookTarget: candidate.hooks }
      : {};
    for (const item of candidate.related || []) {
      evidence.set(item.id, item);
      if (!ids.includes(item.id)) ids.push(item.id);
    }
    if (candidate.behavior) {
      const { ruleId, priority, ...signal } = candidate.behavior;
      result.cues.push({
        module: "behavior",
        ruleId,
        priority,
        summary: summaryFor(ruleId),
        confidence: "suspicion-not-proof",
        signal,
        ...hookTarget,
        evidenceIds: ids,
      });
      continue;
    }
    const match = candidate.literal !== null && literals.get(candidate.literal);
    if (match) {
      evidence.set(match.id, match);
      ids.push(match.id);
    }
    result.cues.push({
      ruleId: `syntax-${candidate.kind}`,
      priority: "review",
      summary:
        "Syntactic capability reference; execution and binding are not proven.",
      literalStatus:
        candidate.literal === null
          ? "no-static-literal"
          : match
            ? "found-in-inspected-source"
            : source
              ? result.sourceCoverage.files === 0 ||
                sourceLiteralTruncated ||
                unknownSource.has(
                  stem(
                    candidate.evidence.path || candidate.evidence.originalPath,
                  ),
                )
                ? "not-assessed"
                : "not-found-in-inspected-source"
              : "source-unavailable",
      ...hookTarget,
      evidenceIds: ids,
    });
  }
  result.evidence = [...evidence.values()];
  result.annotations.push({
    type: "behavior-scope",
    manifest: behaviorManifest,
    limits: {
      ...BEHAVIOR_LIMITS,
      obfuscation: { ...OBFUSCATION_LIMITS },
      destructive: { ...DESTRUCTIVE_LIMITS },
    },
    limitation:
      "Behavior cues are static text and syntax suspicions, not proof of execution or intent. Install hooks and package code were not run; aliases, computed names and runtime-constructed paths are not resolved.",
  });
  result.annotations.push({
    type: "syntax-scope",
    parser: "acorn@8.19.0",
    sourceCoverage: result.sourceCoverage,
    sourceLiteralCount: literals.size,
    sourceLiteralTruncated,
    limitation:
      "Literal matches are not semantic equivalence; missing literals refer only to inspected JavaScript. TypeScript, JSX, source maps, computed aliases and dynamic targets are not resolved.",
  });
  return result;
}

export function addSyntaxInspection(report, inspection) {
  const result = structuredClone(report);
  const existing = new Set(result.evidence.map((item) => item.id));
  for (const item of inspection.evidence)
    if (!existing.has(item.id)) {
      result.evidence.push(item);
      existing.add(item.id);
    }
  const byFile = new Map(result.files.map((file) => [file.originalPath, file]));
  for (const item of inspection.evidence) {
    const file = item.side === "artifact" && byFile.get(item.originalPath);
    if (file && !file.evidenceIds.includes(item.id))
      file.evidenceIds.push(item.id);
  }
  const evidenceById = new Map(
    inspection.evidence.map((item) => [item.id, item]),
  );
  for (const cue of inspection.cues) {
    const item = evidenceById.get(cue.evidenceIds[0]);
    const file = byFile.get(item.originalPath);
    const unchanged = file?.state === "byte-identical";
    if (unchanged)
      result.annotations.push({ type: "unchanged-capability", ...cue });
    else result.cues.push(cue);
  }
  result.annotations.push(...inspection.annotations);
  result.coverage.syntaxInspected = inspection.coverage;
  result.inputs.limits = { ...result.inputs.limits, syntax: inspection.limits };
  result.inputs.syntaxParser = "acorn@8.19.0";
  return validateReport(result);
}
