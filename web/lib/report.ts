// The analysis server's schema 1 report (src/core/report.mjs, src/core/policy.mjs), and a pure view model
// built from it for the report viewer. Nothing here invents a figure: every count, size and range is read
// from the report or summed from its own rows.

export type FileState =
  "byte-identical" | "changed" | "artifact-only" | "not-compared";
export type Side = "artifact" | "source";
export type Range = [number, number];

export interface Counter {
  files: number;
  bytes: number;
}

export interface ReportFile {
  path: string | null;
  originalPath: string;
  size: number;
  artifactSha256: string;
  state: FileState;
  localization: "whole-file" | "byte-spans";
  evidenceIds: string[];
  sourceSha256?: string;
  spans?: { artifact: Range; source: Range };
  reason?: string;
  sourceLink?: unknown;
}

export interface Evidence {
  id: string;
  side: Side;
  blobDigest: string;
  path: string | null;
  originalPath: string;
  fileSha256: string;
  size: number;
  range: Range;
  excerpt?: string;
  excerptRange?: Range;
}

export interface Cue {
  ruleId: string;
  priority: string;
  summary: string;
  evidenceIds: string[];
  module?: string;
  literalStatus?: string;
  field?: string;
  change?: string;
  normalization?: string;
  bindings?: unknown[];
}

export interface Annotation {
  type: string;
  module?: string;
  side?: Side;
  path?: string | null;
  originalPath?: string;
  reason?: string;
  field?: string;
  label?: string;
  evidenceIds?: string[];
  [key: string]: unknown;
}

export interface Manifest {
  status: "usable" | "unavailable" | "invalid";
  value?: Record<string, unknown>;
  evidenceIds?: string[];
  reason?: string;
}

export interface SourceAlternative {
  repository: string;
  commit: string;
  directory: string;
  method: string;
  archiveUrl?: string;
  sourceRoot?: string;
}

export interface SourceSelection {
  status:
    "selected" | "resolved" | "unresolved" | "conflicting" | "unavailable";
  method:
    | "provenance-verified"
    | "provenance-claimed"
    | "publisher-gitHead"
    | "user-full-SHA"
    | "unresolved"
    | "conflicting";
  complete: boolean;
  alternatives: SourceAlternative[];
  commit?: string;
  repository?: string;
  directory?: string;
  reason?: string;
}

export interface Coverage {
  inventory: Counter & { complete: boolean; lowerBound: boolean };
  states: Record<FileState, Counter>;
  compared: Counter;
  unresolved: Counter;
  syntaxInspected: Counter;
  modelReviewed: Counter;
  links: { artifact: number; source: number };
  nonregular: { artifact: number; source: number };
  linkEntries: unknown[];
  sourceAvailable: boolean;
  sourceComplete: boolean;
  complete: boolean;
  sourceOnly: string[];
}

export interface Digests {
  sha256: string;
  sha512?: string;
  kind?: string;
}

export interface Inputs {
  artifact: Digests & {
    expectedIntegrity?: {
      algorithm?: "sha256" | "sha512";
      digest?: string;
      status: "match" | "mismatch" | "unavailable";
    };
    provenance?: { status: string; verificationImplemented?: boolean };
  };
  sourceArchive?: Digests;
  registryDocument?: Digests;
  claim?: { name: string; version: string };
  syntaxParser?: string;
  limits?: Record<string, unknown>;
  limitsDigest?: string;
}

export interface Failure {
  code: string;
  message: string;
  side?: Side;
  reason?: string;
  [key: string]: unknown;
}

export interface PolicyFinding {
  ruleId: string;
  evidenceIds: string[];
  [key: string]: unknown;
}

export interface Observation {
  url: string;
  observedAt: string;
  bytes: number;
  status: number;
  contentLength?: number;
}

export interface Report {
  schemaVersion: "1";
  analyzerVersion: string;
  policyVersion: string;
  limitsVersion: string;
  inputs: Inputs;
  source: SourceSelection;
  files: ReportFile[];
  coverage: Coverage;
  evidence: Evidence[];
  manifests: { artifact: Manifest; source: Manifest; registry: Manifest };
  cues: Cue[];
  annotations: Annotation[];
  failures: Failure[];
  model: { status: string; reason?: string; [key: string]: unknown };
  run: {
    surface: string;
    observations: Observation[];
    timestamps: Record<string, unknown>;
    timings: Record<string, unknown>;
  };
  policy: { exitCode: 0 | 2 | 3; findings: PolicyFinding[] };
}

export const FILE_STATES: FileState[] = [
  "byte-identical",
  "changed",
  "artifact-only",
  "not-compared",
];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown) => Number.isSafeInteger(value);
const isCounter = (value: unknown) =>
  isObject(value) && isCount(value.files) && isCount(value.bytes);

// A structural check of what the viewer reads. The server's validateReport is the full check; this one
// only keeps a malformed body from reaching the renderer.
export function isReport(value: unknown): value is Report {
  if (!isObject(value) || value.schemaVersion !== "1") return false;
  const { inputs, source, coverage, policy, manifests, model, run } = value;
  if (!isObject(inputs) || !isObject(inputs.artifact)) return false;
  if (!isObject(source) || !Array.isArray(source.alternatives)) return false;
  if (
    !isObject(coverage) ||
    !isCounter(coverage.inventory) ||
    !isObject(coverage.states) ||
    !FILE_STATES.every((state) =>
      isCounter((coverage.states as Record<string, unknown>)[state]),
    ) ||
    !Array.isArray(coverage.sourceOnly)
  )
    return false;
  if (
    !isObject(policy) ||
    ![0, 2, 3].includes(policy.exitCode as number) ||
    !Array.isArray(policy.findings)
  )
    return false;
  if (
    !isObject(manifests) ||
    !isObject(model) ||
    !isObject(run) ||
    !Array.isArray(run.observations)
  )
    return false;
  for (const key of ["files", "evidence", "cues", "annotations", "failures"])
    if (!Array.isArray(value[key])) return false;
  return (value.files as unknown[]).every(
    (file) =>
      isObject(file) &&
      FILE_STATES.includes(file.state as FileState) &&
      isCount(file.size) &&
      Array.isArray(file.evidenceIds),
  );
}

// ---------- View model ----------

export type CueKind = "environment" | "process" | "network" | "other";
export const CUE_KINDS: CueKind[] = [
  "environment",
  "process",
  "network",
  "other",
];
export type KindCounts = Record<CueKind, number>;

const kindByRule: Record<string, CueKind> = {
  "syntax-environment-access": "environment",
  "syntax-process-execution": "process",
  "syntax-network-call": "network",
};

export const kindLabel: Record<CueKind, string> = {
  environment: "Environment",
  process: "Processes",
  network: "Network",
  other: "Other",
};

const kindVerb: Record<CueKind, string> = {
  environment: "reads the environment",
  process: "starts processes",
  network: "makes network calls",
  other: "carries other review cues",
};

export function cueKind(ruleId: string): CueKind {
  return kindByRule[ruleId] ?? "other";
}

export function ruleLabel(ruleId: string) {
  if (ruleId === "syntax-environment-access") return "Environment";
  if (ruleId === "syntax-process-execution") return "Process";
  if (ruleId === "syntax-network-call") return "Network";
  if (ruleId === "syntax-dynamic-code") return "Dynamic code";
  if (ruleId.startsWith("manifest-")) return "Manifest";
  return ruleId;
}

export const stateLabel: Record<FileState, string> = {
  "byte-identical": "Byte-identical",
  changed: "Changed",
  "artifact-only": "Not in source",
  "not-compared": "Not compared",
};

const notComparedReason: Record<string, string> = {
  "source-unavailable": "source unavailable",
  prefixless: "no package/ prefix in the tarball",
  "source-link": "a source folder on its path is a link",
  "source-incomplete": "the source inventory hit a limit",
  "source-nonregular": "the source entry is not a regular file",
};

const syntaxReason: Record<string, string> = {
  "unsupported-syntax": "unsupported syntax",
  "not-retained": "content not retained",
  "syntax-file-cap": "file over the size limit",
  "syntax-total-cap": "total size limit reached",
  "syntax-token-cap": "token limit reached",
  "parse-failed": "could not be parsed",
  "syntax-cue-cap": "cue limit reached",
};

const sourceReason: Record<string, string> = {
  "no-full-sha-source-candidate":
    "The registry records no commit for this release",
  "no-source-candidate":
    "No source repository could be identified for this release",
  "source-acquisition-failed": "The source archive could not be downloaded",
  "explicit-repository-disagrees":
    "The repository requested differs from the one the registry records",
  "unsupported-explicit-repository":
    "The repository requested is not supported",
  "invalid-source-directory": "The source directory is not valid",
  "invalid-user-pin": "The commit requested is not valid",
};

const methodLabel: Record<SourceSelection["method"], string> = {
  "provenance-verified": "verified provenance",
  "provenance-claimed": "provenance claim",
  "publisher-gitHead": "publisher gitHead",
  "user-full-SHA": "commit requested",
  unresolved: "unresolved",
  conflicting: "conflicting claims",
};

const findingText: Record<string, (f: PolicyFinding) => string> = {
  "integrity-mismatch": () =>
    "The tarball does not match the registry's integrity digest.",
  "provenance-verification-failed": () => "Provenance verification failed.",
  "identity-claim-conflict": () =>
    "The tarball's name or version differs from the release requested.",
  "lifecycle-source-absent": (f) =>
    `The ${String(f.script ?? "install")} script differs from the source manifest.`,
  "lifecycle-implicit-gyp": () =>
    "binding.gyp is not in the source, and npm builds it on install.",
};

const INSTALL_HOOKS = ["preinstall", "install", "postinstall"] as const;
export type InstallHook = (typeof INSTALL_HOOKS)[number];

export interface CueView {
  ruleId: string;
  kind: CueKind;
  priority: string;
  path: string | null;
  side: Side | null;
  range: Range | null;
  excerpt: string | null;
  summary: string;
}

export interface CueGroup {
  ruleId: string;
  label: string;
  kind: CueKind;
  cues: CueView[];
}

export interface FileRow {
  key: string;
  path: string;
  state: FileState;
  stateLabel: string;
  size: number;
  sha256: string;
  unresolved: boolean;
  signal: boolean;
  cueCount: number;
  kindCounts: KindCounts;
  groups: CueGroup[];
  rangeChars: number;
  note: string | null;
  declared: string | null;
  syntaxNotInspected: string | null;
  unchangedCapabilities: number;
  reason: string | null;
  spans: { artifact: Range; source: Range } | null;
  runsOnInstall: InstallHook | null;
}

export interface InstallPath {
  hook: InstallHook;
  command: string;
  file: FileRow;
  note: string;
}

export interface StatusCell {
  label: string;
  value: string;
  aside: string | null;
  signal: boolean;
}

export type Segment = { text: string; code?: boolean };

export interface Tab {
  id: "all" | FileState;
  label: string;
  count: number;
}

export interface ReportView {
  spec: string;
  checkedAt: string | null;
  mode: "compared" | "no-source";
  source: {
    available: boolean;
    complete: boolean;
    repository: string | null;
    repositoryLabel: string | null;
    href: string | null;
    commit: string | null;
    directory: string | null;
    method: string;
    reason: string;
  };
  inventory: Counter & { complete: boolean; lowerBound: boolean };
  counts: Record<FileState, Counter>;
  unresolved: Counter;
  rows: FileRow[];
  tabs: Tab[];
  defaultKey: string | null;
  cueCount: number;
  cueFiles: number;
  syntaxCueCount: number;
  installPaths: InstallPath[];
  status: StatusCell[];
  policy: { exitCode: 0 | 2 | 3; findings: string[] };
  failures: Failure[];
  finding: Segment[];
  notInspected: { artifact: string[]; sourceCount: number; reasons: string[] };
  sourceOnly: { paths: string[]; scope: string | null };
  notCompared: FileRow[];
  foot: { schema: string; policyVersion: string; parser: string | null };
}

const emptyKinds = (): KindCounts => ({
  environment: 0,
  process: 0,
  network: 0,
  other: 0,
});

const plural = (count: number, one: string, many = `${one}s`) =>
  `${formatCount(count)} ${count === 1 ? one : many}`;

function joinWords(words: string[]) {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

// One line for a table well: newlines and their indentation fold into a space, or vanish next to a
// round or square bracket, so `execSync(\n  \`npm` reads `execSync(\`npm`.
export function oneLine(text: string, max = 200) {
  const flat = text
    .replace(/([([])[ \t]*\r?\n\s*/g, "$1")
    .replace(/\s*\r?\n\s*([)\]])/g, "$1")
    .replace(/\s*\r?\n\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function declaredLabel(field: string) {
  const top = field.split("/")[1] ?? "";
  if (top === "files") return "listed in files";
  if (top === "exports") return "declared export";
  return `declared ${top || "output"}`;
}

function sameScript(manifest: Manifest, hook: InstallHook) {
  const scripts = manifest.value?.scripts;
  return isObject(scripts) && typeof scripts[hook] === "string"
    ? (scripts[hook] as string)
    : null;
}

// Paths a lifecycle command names, in order: `node ./install.js` names install.js.
function commandPaths(command: string) {
  return command
    .split(/[\s;&|()<>]+/)
    .map((token) => token.replace(/^['"]|['"]$/g, "").replace(/^\.\//, ""))
    .filter(Boolean);
}

export function buildView(report: Report): ReportView {
  const { coverage, source } = report;
  const evidence = new Map(report.evidence.map((item) => [item.id, item]));
  const artifactManifest = report.manifests.artifact;
  const claim = report.inputs.claim;
  const spec = claim
    ? `${claim.name}@${claim.version}`
    : artifactManifest.status === "usable" &&
        typeof artifactManifest.value?.name === "string"
      ? `${artifactManifest.value.name}@${String(artifactManifest.value.version ?? "")}`
      : "Local artifact";

  // Cues reach a file through their evidence: the first artifact-side item, else the first item.
  const cues: CueView[] = report.cues.map((cue) => {
    const items = cue.evidenceIds
      .map((id) => evidence.get(id))
      .filter((item): item is Evidence => Boolean(item));
    const item = items.find((e) => e.side === "artifact") ?? items[0];
    const manifestCue = cue.module === "manifest" || Boolean(cue.field);
    const excerpt = manifestCue
      ? `${cue.field ?? ""}${cue.change ? ` (${cue.change.replace(/-/g, " ")})` : ""}`.trim() ||
        null
      : item?.excerpt
        ? oneLine(item.excerpt)
        : null;
    return {
      ruleId: cue.ruleId,
      kind: cueKind(cue.ruleId),
      priority: cue.priority,
      path: item?.path ?? null,
      side: item?.side ?? null,
      range: item ? item.range : null,
      excerpt,
      summary: cue.summary,
    };
  });

  const annotationsFor = (path: string, type: string, side?: Side) =>
    report.annotations.filter(
      (a) => a.type === type && a.path === path && (!side || a.side === side),
    );

  const scripts = artifactManifest.value?.scripts;
  const hookFor = new Map<string, InstallHook>();
  const commands = new Map<InstallHook, string>();
  if (artifactManifest.status === "usable" && isObject(scripts)) {
    const published = new Set(report.files.map((f) => f.path));
    for (const hook of INSTALL_HOOKS) {
      const command = scripts[hook];
      if (typeof command !== "string" || !command.trim()) continue;
      const target = commandPaths(command).find((p) => published.has(p));
      if (target && !hookFor.has(target)) {
        hookFor.set(target, hook);
        commands.set(hook, command);
      }
    }
  }

  const rows: FileRow[] = report.files.map((file) => {
    const path = file.path ?? file.originalPath;
    const own = cues
      .filter((cue) => cue.path === path)
      .sort((a, b) => (a.range?.[0] ?? 0) - (b.range?.[0] ?? 0));
    const kindCounts = emptyKinds();
    for (const cue of own) kindCounts[cue.kind]++;
    const groups: CueGroup[] = [];
    for (const kind of CUE_KINDS)
      for (const cue of own.filter((c) => c.kind === kind)) {
        let group = groups.find((g) => g.ruleId === cue.ruleId);
        if (!group) {
          group = {
            ruleId: cue.ruleId,
            label: ruleLabel(cue.ruleId),
            kind,
            cues: [],
          };
          groups.push(group);
        }
        group.cues.push(cue);
      }
    const unresolved = file.state !== "byte-identical";
    const declared =
      annotationsFor(path, "declared-output-location")[0]?.field ?? null;
    const notInspected =
      annotationsFor(path, "syntax-not-inspected", "artifact")[0]?.reason ??
      null;
    const syntaxNotInspected = notInspected
      ? (syntaxReason[notInspected] ?? notInspected)
      : null;
    const reason = file.reason
      ? (notComparedReason[file.reason] ?? file.reason)
      : null;
    // One note per row. An empty cue cell must not read as "nothing found" when nothing was looked at.
    const note =
      unresolved && own.length === 0 && syntaxNotInspected
        ? "syntax not inspected"
        : declared && unresolved
          ? `${declaredLabel(declared)}, content unverified`
          : file.state === "not-compared" &&
              file.reason &&
              file.reason !== "source-unavailable"
            ? reason
            : null;
    return {
      key: path,
      path,
      state: file.state,
      stateLabel: stateLabel[file.state],
      size: file.size,
      sha256: file.artifactSha256,
      unresolved,
      signal:
        own.length > 0 &&
        (file.state === "artifact-only" || file.state === "changed"),
      cueCount: own.length,
      kindCounts,
      groups,
      rangeChars: Math.max(
        9,
        ...own.map((c) => (c.range ? `${c.range[0]}–${c.range[1]}`.length : 0)),
      ),
      note,
      declared: declared ? declaredLabel(declared) : null,
      syntaxNotInspected,
      unchangedCapabilities: annotationsFor(path, "unchanged-capability")
        .length,
      reason,
      spans: file.spans ?? null,
      runsOnInstall: hookFor.get(path) ?? null,
    };
  });

  // Unexplained first; then the files with most cues, then the largest.
  rows.sort(
    (a, b) =>
      Number(b.unresolved) - Number(a.unresolved) ||
      b.cueCount - a.cueCount ||
      b.size - a.size ||
      a.path.localeCompare(b.path),
  );

  const counts = Object.fromEntries(
    FILE_STATES.map((state) => [state, { files: 0, bytes: 0 }]),
  ) as Record<FileState, Counter>;
  for (const row of rows) {
    counts[row.state].files++;
    counts[row.state].bytes += row.size;
  }
  const unresolved = {
    files: rows.length - counts["byte-identical"].files,
    bytes:
      rows.reduce((sum, row) => sum + row.size, 0) -
      counts["byte-identical"].bytes,
  };

  const candidates = rows.some((row) => row.unresolved)
    ? rows.filter((row) => row.unresolved)
    : rows;
  const most = Math.max(0, ...candidates.map((row) => row.cueCount));
  const defaultKey =
    candidates.find((row) => row.cueCount === most)?.key ?? null;

  const tabs: Tab[] = [
    { id: "all", label: "All", count: rows.length },
    {
      id: "artifact-only",
      label: stateLabel["artifact-only"],
      count: counts["artifact-only"].files,
    },
    ...(["changed", "not-compared"] as const)
      .filter((state) => counts[state].files > 0)
      .map((state) => ({
        id: state,
        label: stateLabel[state],
        count: counts[state].files,
      })),
    {
      id: "byte-identical",
      label: stateLabel["byte-identical"],
      count: counts["byte-identical"].files,
    },
  ];

  const sourceManifest = report.manifests.source;
  const installPaths: InstallPath[] = [];
  for (const [hook, command] of commands) {
    const file = rows.find((row) => row.runsOnInstall === hook);
    if (!file) continue;
    const inSource =
      sourceManifest.status === "usable"
        ? sameScript(sourceManifest, hook)
        : undefined;
    let note: string;
    if (inSource === command && file.state === "artifact-only")
      note = `The ${hook} command matches the source; the file it runs does not exist there.`;
    else {
      const commandPart =
        inSource === undefined
          ? `There is no source manifest to compare the ${hook} command with`
          : inSource === null
            ? `The ${hook} command is not in the source manifest`
            : inSource === command
              ? `The ${hook} command matches the source`
              : `The ${hook} command differs from the source manifest`;
      const filePart = {
        "artifact-only": "the file it runs is not in the source",
        changed: "the file it runs differs from the source",
        "byte-identical": "the file it runs is byte-identical to the source",
        "not-compared": "the file it runs was not compared",
      }[file.state];
      note = `${commandPart}; ${filePart}.`;
    }
    installPaths.push({ hook, command, file, note });
  }

  const available = coverage.sourceAvailable;
  const repository = source.repository ?? null;
  const commit = source.commit ?? null;
  const directory = source.directory ? source.directory : null;
  const href =
    repository && commit && /^https:\/\/github\.com\//.test(repository)
      ? `${repository.replace(/\.git$/, "")}/tree/${commit}${directory ? `/${directory}` : ""}`
      : repository;

  const integrity = report.inputs.artifact.expectedIntegrity;
  const provenance = report.inputs.artifact.provenance?.status;
  const status: StatusCell[] = [
    {
      label: "Integrity",
      value:
        integrity?.status === "match"
          ? "Matches npm"
          : integrity?.status === "mismatch"
            ? "Does not match npm"
            : integrity?.status === "unavailable"
              ? "No digest from npm"
              : "Not checked",
      aside: integrity?.algorithm ? `(${integrity.algorithm})` : null,
      signal: integrity?.status === "mismatch",
    },
    {
      label: "Source",
      value: available
        ? source.complete
          ? "Found, complete"
          : "Found, incomplete"
        : source.status === "unavailable"
          ? "Could not be fetched"
          : source.status === "conflicting"
            ? "Conflicting claims"
            : "Not found",
      aside: null,
      signal: false,
    },
    {
      label: "Provenance",
      value:
        provenance === "verified"
          ? "Verified"
          : provenance === "failed"
            ? "Failed"
            : provenance && provenance !== "not-assessed"
              ? provenance.replace(/-/g, " ")
              : "Not assessed",
      aside: null,
      signal: provenance === "failed",
    },
    {
      label: "Model",
      value:
        {
          disabled: "Off",
          complete: "Reviewed",
          "not-sent": "Not sent",
          unavailable: "Unavailable",
          timeout: "Timed out",
          failed: "Failed",
        }[report.model.status] ?? report.model.status,
      aside: null,
      signal: false,
    },
  ];

  const syntaxNotInspected = report.annotations.filter(
    (a) => a.type === "syntax-not-inspected",
  );
  const artifactNotInspected = new Set(
    syntaxNotInspected
      .filter((a) => a.side === "artifact")
      .map((a) => a.path ?? a.originalPath),
  );
  const notInspected = {
    artifact: rows
      .filter((row) => artifactNotInspected.has(row.path))
      .map((row) => row.path),
    sourceCount: syntaxNotInspected.filter((a) => a.side === "source").length,
    reasons: [
      ...new Set(
        syntaxNotInspected.map((a) =>
          a.reason ? (syntaxReason[a.reason] ?? a.reason) : "not recorded",
        ),
      ),
    ],
  };

  const cueFiles = new Set(
    cues.filter((cue) => cue.path).map((cue) => cue.path),
  ).size;
  const findings = report.policy.findings.map(
    (f) => findingText[f.ruleId]?.(f) ?? `Policy rule ${f.ruleId} fired.`,
  );

  const total = rows.length;
  const finding: Segment[] = [];
  const reasonText = source.reason
    ? (sourceReason[source.reason] ??
      `Source selection ended with ${source.reason}`)
    : "No source was selected for this release";
  if (!available) {
    const nc = counts["not-compared"].files;
    finding.push({
      text: `No source to compare. ${reasonText}; ${plural(nc, "file")} ${nc === 1 ? "was" : "were"} not compared.`,
    });
  } else {
    if (report.policy.exitCode === 2)
      finding.push({
        text: coverage.inventory.lowerBound
          ? "This check is incomplete: the file inventory hit a limit, so counts are lower bounds. "
          : `This check is incomplete: it recorded ${plural(report.failures.length, "failure")}. `,
      });
    if (findings.length)
      finding.push({
        text: `The policy raised ${plural(findings.length, "finding")}. `,
      });
    const parts: string[] = [];
    const artifactOnly = counts["artifact-only"].files;
    if (artifactOnly)
      parts.push(
        `${formatCount(artifactOnly)} of ${plural(total, "published file")} ${artifactOnly === 1 ? "is" : "are"} not in the source`,
      );
    const changed = counts.changed.files;
    if (changed)
      parts.push(
        parts.length
          ? `${formatCount(changed)} ${changed === 1 ? "differs" : "differ"} from it`
          : `${formatCount(changed)} of ${plural(total, "published file")} ${changed === 1 ? "differs" : "differ"} from the source`,
      );
    if (counts["not-compared"].files)
      parts.push(
        `${formatCount(counts["not-compared"].files)} could not be compared`,
      );
    finding.push({
      text: parts.length
        ? `${joinWords(parts)}. `
        : total === 1
          ? "The one published file is byte-identical to the source. "
          : `All ${plural(total, "published file")} are byte-identical to the source. `,
    });
    const [install] = installPaths;
    if (install) {
      const kinds = CUE_KINDS.filter((k) => install.file.kindCounts[k] > 0);
      finding.push({ text: install.file.path, code: true });
      finding.push({
        text: kinds.length
          ? ` runs on install and contains code that ${joinWords(kinds.map((k) => kindVerb[k]))}.`
          : install.file.syntaxNotInspected
            ? " runs on install; its syntax was not inspected."
            : " runs on install; no review cues were found in it.",
      });
    } else if (cues.length) {
      const busiest = rows.find((row) => row.cueCount > 0);
      if (cueFiles === 1 && busiest) {
        finding.push({ text: busiest.path, code: true });
        finding.push({
          text: ` carries ${plural(busiest.cueCount, "review cue")}.`,
        });
      } else
        finding.push({
          text: `${plural(cues.length, "review cue")} point at ${plural(cueFiles, "file")}.`,
        });
    }
  }
  const last = finding[finding.length - 1];
  if (last && !last.code) last.text = last.text.trimEnd();

  const observed = report.run.observations
    .map((o) => o.observedAt)
    .filter((t) => !Number.isNaN(Date.parse(t)))
    .sort();

  return {
    spec,
    checkedAt: observed[0] ?? null,
    mode: available ? "compared" : "no-source",
    source: {
      available,
      complete: source.complete,
      repository,
      repositoryLabel: repository ? repoLabel(repository) : null,
      href,
      commit,
      directory,
      method: methodLabel[source.method] ?? source.method,
      reason: reasonText,
    },
    inventory: coverage.inventory,
    counts,
    unresolved,
    rows,
    tabs,
    defaultKey,
    cueCount: cues.length,
    cueFiles,
    syntaxCueCount: cues.filter((c) => c.ruleId.startsWith("syntax-")).length,
    installPaths,
    status,
    policy: { exitCode: report.policy.exitCode, findings },
    failures: report.failures,
    finding,
    notInspected,
    sourceOnly: { paths: coverage.sourceOnly, scope: directory },
    // In the report's own (path) order, as the no-source state lists them.
    notCompared: report.files
      .filter((file) => file.state === "not-compared")
      .map((file) =>
        rows.find((row) => row.key === (file.path ?? file.originalPath)),
      )
      .filter((row): row is FileRow => Boolean(row)),
    foot: {
      schema: report.schemaVersion,
      policyVersion: report.policyVersion,
      parser: report.inputs.syntaxParser ?? null,
    },
  };
}

// ---------- Formatting (also used by the home page's record panel) ----------

export function shortSha(value: string, length = 7) {
  return value.slice(0, length);
}

export function repoLabel(url: string) {
  return url
    .replace(/^git\+/, "")
    .replace(/^https?:\/\//, "")
    .replace(/\.git$/, "");
}

const numberFormat = new Intl.NumberFormat("en-GB");

export function formatCount(value: number) {
  return numberFormat.format(value);
}

export function formatBytes(value: number) {
  return `${numberFormat.format(value)} B`;
}

const dateFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});
const timeFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});

// "31 Oct 2026, 20:35 UTC"; with seconds for a check that is still running.
export function formatUtc(value: string | number, seconds = false) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${(seconds ? timeFormat : dateFormat).format(date)} UTC`;
}
