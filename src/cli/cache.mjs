import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { LocalInputError } from "../core/pipeline.mjs";
import { validateReport } from "../core/report.mjs";
import { parsePackageSpec } from "../core/acquire.mjs";

const OWNER = "unmask-local-report-cache";
const DIRECTORY = "unmask-reports-v1";
const MARKER = ".unmask-owner.json";
const LOCK = ".unmask-write.lock";
const MAX_REPORT_BYTES = 16 * 1024 * 1024;
const MAX_SCAN_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 500;
const ownedMarker = JSON.stringify({ owner: OWNER, schemaVersion: "1" }) + "\n";
const failure = (
  code = "cache-invalid",
  message = "Cache operation refused: use a private UNMASK-owned cache with regular, unlinked, valid report files.",
) => new LocalInputError(code, message);
const usage = () =>
  failure(
    "cache-usage",
    "Use cache import --report FILE, cache inspect, or cache prune --older-than-days N --limit N [--apply]; optional --cache-dir DIR and --json.",
  );
const digest = (text) => createHash("sha256").update(text).digest("hex");
const terminalJson = (value, space) =>
  JSON.stringify(value, null, space).replace(
    /[\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
function parse(argv) {
  const action = argv[0];
  if (!["import", "inspect", "prune"].includes(action)) throw usage();
  const options = { action };
  const accepted = [
    "--cache-dir",
    "--json",
    ...(action === "import" ? ["--report"] : []),
    ...(action === "prune" ? ["--older-than-days", "--limit", "--apply"] : []),
  ];
  for (let index = 1; index < argv.length; index++) {
    const key = argv[index];
    if (!accepted.includes(key) || Object.hasOwn(options, key)) throw usage();
    if (["--json", "--apply"].includes(key)) options[key] = true;
    else {
      const value = argv[++index];
      if (!value || value.startsWith("--") || value.includes("\0"))
        throw usage();
      options[key] = value;
    }
  }
  if (action === "import" && !options["--report"]) throw usage();
  if (action === "prune") {
    for (const key of ["--older-than-days", "--limit"]) {
      if (!/^(0|[1-9]\d*)$/.test(options[key] ?? "")) throw usage();
      options[key] = Number(options[key]);
      if (!Number.isSafeInteger(options[key])) throw usage();
    }
    if (
      options["--older-than-days"] > 36500 ||
      options["--limit"] < 1 ||
      options["--limit"] > 100
    )
      throw usage();
  }
  return options;
}
async function directoryChain(filename, create = false) {
  const absolute = path.resolve(filename);
  const { root } = path.parse(absolute);
  let current = root;
  for (const part of absolute
    .slice(root.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (!create) return null;
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (mkdirError.code !== "EEXIST") throw mkdirError;
      }
      stat = await lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure();
  }
  return lstat(absolute);
}
function sameFile(first, second) {
  return first.dev === second.dev && first.ino === second.ino;
}
async function readRegular(filename, maxBytes) {
  const stat = await lstat(filename);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > maxBytes
  )
    throw failure();
  const handle = await open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat();
    if (
      !sameFile(stat, opened) ||
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.size > maxBytes
    )
      throw failure();
    const buffer = Buffer.alloc(Math.min(opened.size + 1, maxBytes + 1));
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        size,
        buffer.length - size,
        size,
      );
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > maxBytes || size !== opened.size) throw failure();
    const end = await handle.stat();
    if (
      end.size !== opened.size ||
      end.mtimeMs !== opened.mtimeMs ||
      end.ctimeMs !== opened.ctimeMs
    )
      throw failure();
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, size),
      ),
      stat: end,
    };
  } finally {
    await handle.close();
  }
}
async function assertRoot(cache) {
  const stat = await directoryChain(cache.root);
  if (
    !stat ||
    !sameFile(cache.stat, stat) ||
    (stat.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  )
    throw failure();
  const marker = await readRegular(path.join(cache.root, MARKER), 256);
  if (marker.text !== ownedMarker) throw failure();
}
async function createExclusive(filename, text) {
  const handle = await open(
    filename,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(text);
  } finally {
    await handle.close();
  }
}
async function ownedRoot(base, create) {
  const root = path.join(base, DIRECTORY);
  const parentStat = await directoryChain(base, create);
  if (!parentStat) return { root, exists: false };
  let stat;
  try {
    stat = await lstat(root);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (!create) return { root, exists: false };
    try {
      await mkdir(root, { mode: 0o700 });
      await createExclusive(path.join(root, MARKER), ownedMarker);
    } catch (createError) {
      if (createError.code !== "EEXIST") throw createError;
    }
    stat = await lstat(root);
  }
  const cache = { root, stat, exists: true };
  await assertRoot(cache);
  return cache;
}
function decodeReport(text) {
  let report;
  try {
    report = JSON.parse(text);
    validateReport(report);
  } catch {
    throw failure(
      "cache-report-invalid",
      "Input must be a bounded, valid UNMASK report JSON file; no result was imported or deleted.",
    );
  }
  return report;
}
function scopeFor(report) {
  const scope = { artifactSha256: report.inputs.artifact.sha256 };
  try {
    const claim = report.inputs.claim;
    const spec = `${claim?.name}@${claim?.version}`;
    parsePackageSpec(spec);
    scope.package = spec;
  } catch {}
  return scope;
}
async function readCachedEntry(cache, name, now) {
  if (!/^[a-f0-9]{64}\.json$/.test(name)) throw failure();
  const { text, stat } = await readRegular(
    path.join(cache.root, name),
    MAX_REPORT_BYTES,
  );
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw failure();
  }
  if (
    !value ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "cachedAt,owner,report,schemaVersion" ||
    value.owner !== OWNER ||
    value.schemaVersion !== "1" ||
    !Number.isSafeInteger(value.cachedAt) ||
    value.cachedAt < 0 ||
    value.cachedAt > now ||
    digest(JSON.stringify(value.report)) + ".json" !== name
  )
    throw failure();
  const report = decodeReport(JSON.stringify(value.report));
  return {
    id: name.slice(0, -5),
    filename: name,
    cachedAt: new Date(value.cachedAt).toISOString(),
    ageSeconds: Math.floor((now - value.cachedAt) / 1000),
    sizeBytes: stat.size,
    scope: scopeFor(report),
    modelStatus: report.model.status,
    stat,
  };
}
async function cachedEntry(cache, name, now) {
  if (!/^[a-f0-9]{64}\.json$/.test(name))
    throw failure(
      "cache-entry-invalid",
      "Unrecognized entry in the managed cache root; inspect it locally. No deletion was started.",
    );
  try {
    return await readCachedEntry(cache, name, now);
  } catch {
    throw failure(
      "cache-entry-invalid",
      `Cached report ${name} is invalid, linked, oversized or future-dated. Inspect this entry locally and check the clock before retrying; no deletion was started.`,
    );
  }
}
async function rejectBusyReader(cache) {
  let lock;
  try {
    lock = await lstat(path.join(cache.root, LOCK));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (!lock.isFile() || lock.isSymbolicLink() || lock.nlink !== 1)
    throw failure();
  throw failure(
    "cache-busy",
    "A cache writer lock is present. Retry after the writer finishes; inspect a stale lock locally rather than removing an active lock.",
  );
}
async function inspect(cache, now, ownsLock = false) {
  if (!cache.exists) return [];
  await assertRoot(cache);
  if (!ownsLock) await rejectBusyReader(cache);
  const directory = await opendir(cache.root);
  const entries = [];
  let size = 0;
  for await (const item of directory) {
    if (item.name === MARKER) continue;
    if (item.name === LOCK) {
      if (!ownsLock) await rejectBusyReader(cache);
      const lock = await readRegular(path.join(cache.root, LOCK), 64);
      if (lock.text !== "unmask-cache-write\n") throw failure();
      continue;
    }
    if (entries.length >= MAX_ENTRIES)
      throw failure(
        "cache-limit",
        "Cache scan exceeded 500 reports; no deletion was started.",
      );
    let entry;
    try {
      if (!ownsLock) await rejectBusyReader(cache);
      entry = await cachedEntry(cache, item.name, now);
    } catch (error) {
      if (!ownsLock) await rejectBusyReader(cache);
      throw error;
    }
    size += entry.sizeBytes;
    if (size > MAX_SCAN_BYTES)
      throw failure(
        "cache-limit",
        "Cache scan exceeded 64 MiB; no deletion was started.",
      );
    entries.push(entry);
  }
  await assertRoot(cache);
  if (!ownsLock) await rejectBusyReader(cache);
  return entries.sort(
    (a, b) => a.cachedAt.localeCompare(b.cachedAt) || a.id.localeCompare(b.id),
  );
}
const publicEntry = ({ stat, filename, ...entry }) => entry;
async function withLock(cache, operation) {
  await assertRoot(cache);
  const filename = path.join(cache.root, LOCK);
  let stat;
  try {
    await createExclusive(filename, "unmask-cache-write\n");
    stat = await lstat(filename);
  } catch {
    throw failure(
      "cache-busy",
      "Cache is busy or a write lock could not be created. Do not remove another process's active lock.",
    );
  }
  try {
    return await operation();
  } finally {
    await assertRoot(cache);
    const current = await lstat(filename);
    if (
      !sameFile(current, stat) ||
      !current.isFile() ||
      current.isSymbolicLink()
    )
      throw failure();
    await unlink(filename);
  }
}
async function importReport(cache, report, now) {
  return withLock(cache, async () => {
    const entries = await inspect(cache, now, true);
    const reportJson = JSON.stringify(report);
    const id = digest(reportJson);
    const text =
      JSON.stringify({
        owner: OWNER,
        schemaVersion: "1",
        cachedAt: now,
        report,
      }) + "\n";
    if (Buffer.byteLength(text) > MAX_REPORT_BYTES)
      throw failure(
        "cache-limit",
        "Report exceeds the 16 MiB cache entry limit.",
      );
    const existing = entries.find((entry) => entry.id === id);
    if (
      !existing &&
      (entries.length >= MAX_ENTRIES ||
        entries.reduce((total, entry) => total + entry.sizeBytes, 0) +
          Buffer.byteLength(text) >
          MAX_SCAN_BYTES)
    )
      throw failure(
        "cache-limit",
        "Cache capacity is bounded to 500 reports and 64 MiB; prune old reports explicitly before importing more.",
      );
    let imported = true;
    try {
      await assertRoot(cache);
      await createExclusive(path.join(cache.root, id + ".json"), text);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      await cachedEntry(cache, id + ".json", now);
      imported = false;
    }
    return {
      imported,
      entry: publicEntry(await cachedEntry(cache, id + ".json", now)),
    };
  });
}
export async function cacheCommand(argv, runtime = {}) {
  const options = parse(argv);
  const cwd = runtime.cwd ?? process.cwd();
  const base = path.resolve(cwd, options["--cache-dir"] ?? ".unmask-cache");
  const now = (runtime.now ?? Date.now)();
  if (!Number.isSafeInteger(now) || now < 0 || now > 8640000000000000)
    throw usage();
  try {
    let report;
    if (options.action === "import") {
      const input = path.resolve(cwd, options["--report"]);
      if (!(await directoryChain(path.dirname(input)))) throw failure();
      report = decodeReport((await readRegular(input, MAX_REPORT_BYTES)).text);
    }
    const cache = await ownedRoot(base, options.action === "import");
    const result = {
      schemaVersion: "1",
      root: cache.root,
      exists: cache.exists,
      limitations: [
        "Only explicitly imported local report snapshots are managed; input blobs and hosted caches are untouched.",
        "Cached reports can be stale and are not a new analysis or safety guarantee.",
      ],
    };
    if (report) Object.assign(result, await importReport(cache, report, now));
    else if (options.action === "inspect")
      result.entries = (await inspect(cache, now)).map(publicEntry);
    else {
      const prune = async () => {
        const entries = await inspect(cache, now, !!options["--apply"]);
        const candidates = entries
          .filter(
            (entry) =>
              now - Date.parse(entry.cachedAt) >=
              options["--older-than-days"] * 86400000,
          )
          .slice(0, options["--limit"]);
        result.dryRun = !options["--apply"];
        result.candidates = candidates.map(publicEntry);
        result.deleted = 0;
        for (const entry of options["--apply"] ? candidates : []) {
          await assertRoot(cache);
          const current = await lstat(path.join(cache.root, entry.filename));
          if (
            !current.isFile() ||
            current.isSymbolicLink() ||
            current.nlink !== 1 ||
            !sameFile(current, entry.stat) ||
            current.size !== entry.stat.size ||
            current.mtimeMs !== entry.stat.mtimeMs ||
            current.ctimeMs !== entry.stat.ctimeMs
          )
            throw failure();
          await unlink(path.join(cache.root, entry.filename));
          result.deleted++;
        }
      };
      if (options["--apply"] && cache.exists) await withLock(cache, prune);
      else await prune();
    }
    const stdout = runtime.stdout ?? process.stdout;
    stdout.write(
      options["--json"]
        ? terminalJson(result, 2) + "\n"
        : `UNMASK report cache ${terminalJson(result.root)}\n` +
            (result.entry
              ? `${result.imported ? "Imported" : "Already cached"}: ${terminalJson(result.entry.scope)}\n`
              : (result.entries ?? result.candidates)
                  .map(
                    (entry) =>
                      `${entry.id} ${entry.ageSeconds}s ${entry.sizeBytes} bytes ${terminalJson(entry.scope)} model=${terminalJson(entry.modelStatus)}`,
                  )
                  .join("\n") + "\n") +
            (options.action === "prune"
              ? `${result.dryRun ? "Dry run" : "Applied"}: ${result.candidates.length} selected, ${result.deleted} deleted.\n`
              : "") +
            result.limitations.join("\n") +
            "\n",
    );
    return 0;
  } catch (error) {
    if (error instanceof LocalInputError) throw error;
    throw failure();
  }
}
