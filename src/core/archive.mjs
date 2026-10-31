import { createHash } from "node:crypto";
import { createGunzip } from "node:zlib";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import tar from "tar-stream";

export const DEFAULT_LIMITS = Object.freeze({
  compressedBytes: 50 * 1024 * 1024,
  expandedBytes: 250 * 1024 * 1024,
  entries: 20000,
  ratio: 100,
  fileBytes: 10 * 1024 * 1024,
  parseMs: 30000,
  metadataBytes: 65536,
  pathBytes: 4096,
  pathDepth: 64,
  pathNodes: 40000,
});
class InputFailure extends Error {
  constructor(code, message, path) {
    super(message);
    this.failure = { code, message, ...(path === undefined ? {} : { path }) };
  }
}
function fail(code, message, path) {
  throw new InputFailure(code, message, path);
}
function safePath(value, limits) {
  if (typeof value === "string" && Buffer.byteLength(value) > limits.pathBytes)
    fail("path-cap", "Archive path byte limit exceeded");
  if (
    typeof value !== "string" ||
    !value ||
    /[\0\\]/u.test(value) ||
    value.startsWith("/") ||
    /^[a-z]:/iu.test(value)
  )
    fail("unsafe-path", "Unsafe archive path", value);
  const parts = value.replace(/\/+$/u, "").split("/");
  if (parts.length > limits.pathDepth)
    fail("path-depth-cap", "Archive path depth limit exceeded", value);
  if (parts.some((p) => !p || p === "." || p === ".."))
    fail("unsafe-path", "Unsafe archive path component", value);
  return parts.join("/");
}
function field(buffer, start, length) {
  const part = buffer.subarray(start, start + length);
  const nul = part.indexOf(0);
  if (nul !== -1 && part.subarray(nul).some((n) => n !== 0))
    fail("unsafe-path", "Embedded NUL in archive path");
  return part.subarray(0, nul === -1 ? part.length : nul).toString("utf8");
}
function declaredSize(header) {
  const value = header.subarray(124, 136);
  let n;
  if (value[0] === 0x80) {
    n = 0;
    for (const b of value.subarray(1)) n = n * 256 + b;
  } else {
    const text = value
      .toString("ascii")
      .replace(/[\0 ]+$/u, "")
      .trim();
    if (!/^[0-7]*$/u.test(text)) fail("invalid-metadata", "Invalid tar size");
    n = text ? Number.parseInt(text, 8) : 0;
  }
  if (!Number.isSafeInteger(n) || n < 0)
    fail("invalid-metadata", "Invalid tar size");
  return n;
}
function readPax(body, global, limits) {
  const values = Object.create(null);
  for (let offset = 0; offset < body.length;) {
    const space = body.indexOf(32, offset);
    const digits =
      space === -1 ? "" : body.subarray(offset, space).toString("ascii");
    if (!/^[1-9][0-9]*$/u.test(digits))
      fail("invalid-metadata", "Invalid PAX length");
    const length = Number(digits);
    const end = offset + length;
    if (
      !Number.isSafeInteger(length) ||
      end > body.length ||
      end <= space + 2 ||
      body[end - 1] !== 10
    )
      fail("invalid-metadata", "Invalid PAX record");
    const record = body.subarray(space + 1, end - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals <= 0 || record.includes("\0"))
      fail("invalid-metadata", "Invalid PAX value");
    const key = record.slice(0, equals);
    const value = record.slice(equals + 1);
    if (key === "path") safePath(value, limits);
    if (/sparse/iu.test(key))
      fail("unsupported-type", "Sparse archives are unsupported");
    if (global && ["path", "size", "linkpath"].includes(key))
      fail(
        "unsupported-metadata",
        "Global path and size overrides are unsupported",
      );
    if (
      key === "size" &&
      (!/^[0-9]+$/u.test(value) || !Number.isSafeInteger(Number(value)))
    )
      fail("invalid-metadata", "Invalid PAX size");
    values[key] = value;
    offset = end;
  }
  return values;
}
function framingGate(limits, compressedSize, checkTime) {
  const header = Buffer.alloc(512);
  let filled = 0,
    remaining = 0,
    padding = 0,
    metadata = null,
    metaOffset = 0,
    metaType = "",
    pendingSize;
  let expanded = 0,
    count = 0,
    zeroBlocks = 0;
  return new Transform({
    transform(chunk, encoding, callback) {
      try {
        checkTime();
        expanded += chunk.length;
        if (expanded > limits.expandedBytes)
          fail("expanded-cap", "Expanded archive byte limit exceeded");
        if (expanded > compressedSize * limits.ratio)
          fail("ratio-cap", "Archive expansion ratio exceeded");
        let offset = 0;
        while (offset < chunk.length) {
          checkTime();
          if (remaining) {
            const n = Math.min(remaining, chunk.length - offset);
            const part = chunk.subarray(offset, offset + n);
            if (metadata) {
              part.copy(metadata, metaOffset);
              metaOffset += n;
            } else this.push(part);
            offset += n;
            remaining -= n;
            if (!remaining && metadata) {
              if (metaType === "x" || metaType === "g") {
                const pax = readPax(metadata, metaType === "g", limits);
                if (metaType === "x")
                  pendingSize =
                    pax.size === undefined ? undefined : Number(pax.size);
              } else {
                const value = field(metadata, 0, metadata.length);
                if (metaType === "L" || metaType === "N")
                  safePath(value, limits);
              }
              this.push(Buffer.from(header));
              this.push(metadata);
              metadata = null;
            }
            continue;
          }
          if (padding) {
            const n = Math.min(padding, chunk.length - offset);
            this.push(chunk.subarray(offset, offset + n));
            offset += n;
            padding -= n;
            continue;
          }
          const n = Math.min(512 - filled, chunk.length - offset);
          chunk.copy(header, filled, offset, offset + n);
          offset += n;
          filled += n;
          if (filled !== 512) continue;
          filled = 0;
          if (header.every((n) => n === 0)) {
            zeroBlocks++;
            this.push(Buffer.from(header));
            continue;
          }
          if (zeroBlocks)
            fail("malformed-archive", "Nonzero data follows tar termination");
          if (++count > limits.entries)
            fail("entry-cap", "Archive entry limit exceeded");
          const name = field(header, 0, 100);
          const prefix = header
            .subarray(257, 263)
            .equals(Buffer.from("ustar\0"))
            ? field(header, 345, 155)
            : "";
          safePath(prefix ? `${prefix}/${name}` : name, limits);
          const type = String.fromCharCode(header[156]);
          const isMetadata = ["x", "g", "L", "K", "N"].includes(type);
          if (!isMetadata && !["\0", "0", "1", "2", "5"].includes(type))
            fail("unsupported-type", "Unsupported archive entry type", name);
          if (["1", "2"].includes(type)) field(header, 157, 100);
          let size = declaredSize(header);
          if (!isMetadata && pendingSize !== undefined) {
            size = pendingSize;
            pendingSize = undefined;
          }
          if (
            size >
            limits.expandedBytes - (expanded - (chunk.length - offset))
          )
            fail(
              "expanded-cap",
              "Declared entry exceeds remaining expanded budget",
              name,
            );
          if (!isMetadata && !["\0", "0"].includes(type) && size !== 0)
            fail("invalid-metadata", "Nonregular entry has a body", name);
          remaining = size;
          padding = (512 - (size % 512)) % 512;
          if (isMetadata) {
            if (size === 0 || size > limits.metadataBytes)
              fail(
                "metadata-cap",
                "Archive metadata exceeds bounded parser allowance",
                name,
              );
            metadata = Buffer.alloc(size);
            metaOffset = 0;
            metaType = type;
          } else this.push(Buffer.from(header));
        }
        callback();
      } catch (error) {
        callback(error);
      }
    },
    flush(callback) {
      callback(
        filled || remaining || padding || zeroBlocks < 2
          ? new InputFailure("malformed-archive", "Truncated tar container")
          : null,
      );
    },
  });
}
function key(path) {
  return path.normalize("NFC").toLowerCase();
}
function registerPath(paths, path, type, nodeBudget) {
  if (path === null) return;
  const parts = path.split("/");
  let children = paths;
  for (let i = 0; i < parts.length; i++) {
    const component = parts[i];
    const normalized = key(component);
    const leaf = i === parts.length - 1;
    let previous = children.get(normalized);
    if (previous) {
      if (previous.original !== component || (leaf && previous.explicit))
        fail("path-collision", "Duplicate or ambiguous archive path", path);
      if (
        (!leaf && previous.type !== "directory") ||
        (leaf && type !== "directory")
      )
        fail(
          "path-collision",
          "Non-directory path shadows archive descendants",
          path,
        );
      if (leaf) previous.explicit = true;
    } else {
      if (nodeBudget.used >= nodeBudget.limit)
        fail("path-node-cap", "Archive path index node limit exceeded", path);
      nodeBudget.used++;
      previous = {
        original: component,
        type: leaf ? type : "directory",
        explicit: leaf,
        children: new Map(),
      };
      children.set(normalized, previous);
    }
    children = previous.children;
  }
}
export async function readArchive(bytes, options = {}) {
  if (!Buffer.isBuffer(bytes))
    throw new TypeError("Archive input must be a Buffer");
  if (!["artifact", "source"].includes(options.kind))
    throw new TypeError("Archive kind must be artifact or source");
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  for (const [name, value] of Object.entries(limits)) {
    if (
      !(name in DEFAULT_LIMITS) ||
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > DEFAULT_LIMITS[name]
    )
      throw new TypeError(`Invalid archive limit: ${name}`);
  }
  const budget = options.retentionBudget ?? {
    limitBytes: 134217728,
    usedBytes: 0,
  };
  if (
    ![budget.limitBytes, budget.usedBytes].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    ) ||
    budget.usedBytes > budget.limitBytes
  )
    throw new TypeError("Invalid shared retention budget");
  const result = {
    digest: {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sha512: createHash("sha512").update(bytes).digest("hex"),
    },
    entries: [],
    complete: true,
    limits: { ...limits },
    failures: [],
    totals: {
      regularFiles: 0,
      regularBytes: 0,
      nonregularEntries: 0,
      retainedBytes: 0,
    },
  };
  const started = performance.now();
  const checkTime = () => {
    if (performance.now() - started >= limits.parseMs)
      fail("parse-timeout", "Archive parse deadline exceeded");
  };
  let extract, pending, timer;
  try {
    checkTime();
    if (bytes.length > limits.compressedBytes)
      fail("compressed-cap", "Compressed archive byte limit exceeded");
    let root;
    if (options.kind === "source") {
      if (typeof options.sourceRoot !== "string" || !options.sourceRoot)
        fail(
          "source-root-required",
          "Local source archive requires an explicit root",
        );
      root = safePath(options.sourceRoot, limits);
    }
    const originals = new Map(),
      mapped = new Map();
    const nodeBudget = { limit: limits.pathNodes, used: 0 };
    extract = tar.extract();
    pending = pipeline(
      Readable.from([bytes]),
      createGunzip({ chunkSize: 16384 }),
      framingGate(limits, bytes.length, checkTime),
      extract,
    );
    pending.catch(() => {});
    timer = setTimeout(
      () =>
        extract.destroy(
          new InputFailure("parse-timeout", "Archive parse deadline exceeded"),
        ),
      limits.parseMs,
    );
    for await (const stream of extract) {
      checkTime();
      const h = stream.header;
      const original = safePath(h.name, limits);
      const type = h.type === "link" ? "hardlink" : h.type;
      if (!["file", "directory", "symlink", "hardlink"].includes(type))
        fail("unsupported-type", "Unsupported archive entry type", h.name);
      if (
        !Number.isSafeInteger(h.size) ||
        h.size < 0 ||
        h.size > limits.expandedBytes
      )
        fail("invalid-metadata", "Invalid effective size", h.name);
      let path;
      if (root !== undefined) {
        if (original === root) {
          if (type !== "directory")
            fail(
              "source-root-invalid",
              "Source archive root is not a directory",
              h.name,
            );
          path = null;
        } else if (original.startsWith(root + "/"))
          path = original.slice(root.length + 1);
        else
          fail(
            "source-root-mismatch",
            "Entry is outside the declared source root",
            h.name,
          );
      } else
        path = original.includes("/")
          ? original.slice(original.indexOf("/") + 1)
          : null;
      if (path !== null) path = safePath(path, limits);
      registerPath(originals, original, type, nodeBudget);
      registerPath(mapped, path, type, nodeBudget);
      const entry = {
        path,
        originalPath: h.name,
        type,
        size: h.size,
        content: null,
        inspection: "nonregular",
      };
      if (type === "file") {
        const hash = createHash("sha256");
        entry.inspection =
          h.size > limits.fileBytes
            ? "size-cap"
            : h.size > budget.limitBytes - budget.usedBytes
              ? "retention-cap"
              : "retained";
        const retained = entry.inspection === "retained";
        let content = null,
          offset = 0;
        if (retained) {
          budget.usedBytes += h.size;
          content = Buffer.allocUnsafe(h.size);
        }
        try {
          for await (const chunk of stream) {
            checkTime();
            if (offset + chunk.length > h.size)
              fail("invalid-metadata", "File exceeds declared size", h.name);
            hash.update(chunk);
            if (content) chunk.copy(content, offset);
            offset += chunk.length;
          }
          if (offset !== h.size)
            fail("malformed-archive", "Truncated file", h.name);
        } catch (error) {
          if (retained) budget.usedBytes -= h.size;
          throw error;
        }
        entry.sha256 = hash.digest("hex");
        entry.content = content;
        result.totals.regularFiles++;
        result.totals.regularBytes += h.size;
        result.totals.retainedBytes += content?.length ?? 0;
      } else {
        if (["symlink", "hardlink"].includes(type))
          entry.linkTarget = h.linkname ?? "";
        for await (const chunk of stream) {
          if (chunk.length)
            fail("invalid-metadata", "Nonregular entry body", h.name);
        }
        result.totals.nonregularEntries++;
      }
      result.entries.push(entry);
    }
    await pending;
  } catch (error) {
    extract?.destroy();
    if (pending) await pending.catch(() => {});
    if (
      !(error instanceof InputFailure) &&
      !["Z_DATA_ERROR", "Z_BUF_ERROR", "ERR_STREAM_PREMATURE_CLOSE"].includes(
        error.code,
      ) &&
      !/^(?:Invalid tar header[.:]|Invalid header$|Header exceeds max size$|Unexpected end of data$)/u.test(
        error.message,
      )
    )
      throw error;
    result.complete = false;
    result.failures.push(
      error.failure ?? {
        code: "malformed-archive",
        message: "Malformed gzip or tar container",
      },
    );
  } finally {
    clearTimeout(timer);
  }
  result.entries.sort((a, b) =>
    (a.path ?? "\uffff" + a.originalPath) <
    (b.path ?? "\uffff" + b.originalPath)
      ? -1
      : (a.path ?? "\uffff" + a.originalPath) >
          (b.path ?? "\uffff" + b.originalPath)
        ? 1
        : 0,
  );
  return result;
}
