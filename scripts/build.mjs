import {
  mkdirSync,
  readFileSync,
  readdirSync,
  lstatSync,
  rmSync,
  writeFileSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const relative = (value) =>
  typeof value === "string" &&
  value.startsWith("dist/") &&
  value.split("/").every((part) => part && part !== "." && part !== "..") &&
  !value.includes("\\");
export function declaredEntrypoints(pkg) {
  const entries =
    typeof pkg.bin === "string"
      ? [pkg.bin]
      : pkg.bin && typeof pkg.bin === "object"
        ? Object.values(pkg.bin)
        : [];
  if (!entries.every(relative))
    throw new Error("Declared product entrypoint must be under dist/");
  return entries;
}
function regular(root, name) {
  const filename = path.join(root, name);
  const stat = lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(`Build input/output must be a regular file: ${name}`);
  return readFileSync(filename);
}
function sourceInputs(root) {
  const packageBytes = regular(root, "package.json");
  const lockBytes = regular(root, "package-lock.json");
  const pkg = JSON.parse(packageBytes);
  const lock = JSON.parse(lockBytes);
  if (
    lock.name !== pkg.name ||
    lock.version !== pkg.version ||
    lock.packages?.[""]?.name !== pkg.name ||
    lock.packages?.[""]?.version !== pkg.version
  )
    throw new Error("Package and lockfile identity differ");
  for (const key of [
    "dependencies",
    "optionalDependencies",
    "devDependencies",
  ]) {
    const stable = (value) =>
      JSON.stringify(
        Object.entries(value ?? {}).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        ),
      );
    if (stable(pkg[key]) !== stable(lock.packages[""][key]))
      throw new Error(`Package and lockfile ${key} differ`);
  }
  const names = readdirSync(path.join(root, "src"), { recursive: true })
    .filter((name) => {
      const stat = lstatSync(path.join(root, "src", name));
      if (stat.isSymbolicLink())
        throw new Error(`Unsupported product input symlink: ${name}`);
      if (stat.isDirectory()) return false;
      if (stat.isFile() && path.basename(name) === ".gitkeep") return false;
      if (
        !stat.isFile() ||
        !/^(cli|core|server|viewer|model)\/[a-z-]+\.mjs$/.test(name)
      )
        throw new Error(`Unsupported product input: ${name}`);
      return true;
    })
    .sort();
  if (!names.length) throw new Error("No actual product modules to build");
  const modules = new Map(
    names.map((name) => [name, regular(root, `src/${name}`)]),
  );
  for (const name of declaredEntrypoints(pkg))
    if (!modules.has(name.slice(5)))
      throw new Error(`Declared entrypoint is not built: ${name}`);
  const records = [
    ["package.json", hash(packageBytes)],
    ["package-lock.json", hash(lockBytes)],
    ["scripts/build.mjs", hash(regular(root, "scripts/build.mjs"))],
    [".nvmrc", hash(regular(root, ".nvmrc"))],
    ...[...modules].map(([name, bytes]) => [`src/${name}`, hash(bytes)]),
  ];
  return {
    pkg,
    modules,
    sourceSha256: hash(JSON.stringify(records)),
    packageSha256: hash(packageBytes),
    lockfileSha256: hash(lockBytes),
  };
}
function gitIdentity(root) {
  try {
    const dirty =
      execFileSync(
        "git",
        ["status", "--porcelain", "--untracked-files=normal"],
        { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim().length > 0;
    const commit = dirty
      ? "unknown"
      : execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: root,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
    return { dirty, commit };
  } catch {
    return { dirty: true, commit: "unknown" };
  }
}
export function buildProduct(root) {
  const input = sourceInputs(root);
  const identity = gitIdentity(root);
  const destination = path.join(root, "dist");
  rmSync(destination, { recursive: true, force: true });
  const files = {};
  for (const [name, bytes] of input.modules) {
    mkdirSync(path.dirname(path.join(destination, name)), { recursive: true });
    writeFileSync(path.join(destination, name), bytes, {
      mode: declaredEntrypoints(input.pkg).includes(`dist/${name}`)
        ? 0o755
        : 0o644,
    });
    files[name] = { sha256: hash(bytes), size: bytes.length };
  }
  const metadata = {
    buildSchema: "1",
    version: input.pkg.version,
    ...identity,
    sourceSha256: input.sourceSha256,
    packageSha256: input.packageSha256,
    lockfileSha256: input.lockfileSha256,
    files,
  };
  writeFileSync(
    path.join(destination, "version.json"),
    JSON.stringify(metadata) + "\n",
  );
  return metadata;
}
export function verifyBuild(root, { expectedSha, requireClean = false } = {}) {
  if (!existsSync(path.join(root, "dist/version.json")))
    throw new Error(
      "Product build is missing; run npm run build before packing",
    );
  const input = sourceInputs(root);
  const metadata = JSON.parse(regular(root, "dist/version.json"));
  if (
    metadata.buildSchema !== "1" ||
    metadata.version !== input.pkg.version ||
    metadata.sourceSha256 !== input.sourceSha256 ||
    metadata.packageSha256 !== input.packageSha256 ||
    metadata.lockfileSha256 !== input.lockfileSha256
  )
    throw new Error("Product build is stale; source/package/lock bytes differ");
  if (
    !metadata.files ||
    JSON.stringify(Object.keys(metadata.files).sort()) !==
      JSON.stringify([...input.modules.keys()].sort())
  )
    throw new Error("Product build module inventory differs");
  const actual = readdirSync(path.join(root, "dist"), { recursive: true })
    .filter((name) => {
      const stat = lstatSync(path.join(root, "dist", name));
      if (stat.isSymbolicLink())
        throw new Error("Product build contains a symlink");
      return stat.isFile();
    })
    .sort();
  if (
    JSON.stringify(actual) !==
    JSON.stringify([...input.modules.keys(), "version.json"].sort())
  )
    throw new Error("Product build contains missing or unexpected bytes");
  for (const [name, bytes] of input.modules) {
    const built = regular(root, `dist/${name}`);
    if (
      !built.equals(bytes) ||
      metadata.files[name]?.sha256 !== hash(built) ||
      metadata.files[name]?.size !== built.length
    )
      throw new Error(`Product build bytes/digest differ: ${name}`);
  }
  if (
    typeof metadata.dirty !== "boolean" ||
    (metadata.dirty
      ? metadata.commit !== "unknown"
      : !/^[a-f0-9]{40}$/.test(metadata.commit))
  )
    throw new Error("Invalid build commit identity");
  if (requireClean || expectedSha !== undefined) {
    if (expectedSha !== undefined && !/^[a-f0-9]{40}$/.test(expectedSha))
      throw new Error("Expected release SHA must be a full commit");
    const current = gitIdentity(root);
    if (metadata.dirty || current.dirty)
      throw new Error("A clean product build is required for a release");
    if (
      metadata.commit !== current.commit ||
      (expectedSha !== undefined && metadata.commit !== expectedSha)
    )
      throw new Error("Build commit differs from expected release SHA");
  }
  return metadata;
}

if (
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  buildProduct(root);
  console.log(
    "Built product modules with byte-bound version metadata in dist/",
  );
}
