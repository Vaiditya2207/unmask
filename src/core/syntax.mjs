import { parse } from "acorn";
import { createHash } from "node:crypto";
import { validateReport } from "./report.mjs";

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
function capability(node) {
  const name = nameOf(node.callee);
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
  let sourceLiteralTruncated = false;
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
      for (const node of nodes(ast)) {
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
        const kind = capability(node);
        if (!kind) continue;
        if (candidates.length >= limits.cues) {
          skip("syntax-cue-cap");
          break;
        }
        candidates.push({
          kind,
          evidence: evidenceFor(side, inventory, entry, node, positions),
          literal:
            node.arguments?.[0]?.type === "Literal" &&
            typeof node.arguments[0].value === "string"
              ? node.arguments[0].value
              : null,
        });
      }
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
      evidenceIds: ids,
    });
  }
  result.evidence = [...evidence.values()];
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
