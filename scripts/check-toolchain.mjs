import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exact = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const stable = (value) =>
  JSON.stringify(
    Object.entries(value ?? {}).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    ),
  );
export function checkToolchain(root, { runtime = process.versions.node } = {}) {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json")));
  const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json")));
  const node = readFileSync(path.join(root, ".nvmrc"), "utf8").trim();
  if (
    !exact.test(node) ||
    pkg.engines?.node !== node ||
    runtime !== node ||
    lock.packages?.[""]?.engines?.node !== node
  )
    throw new Error("Node pin, engines, lock and runtime must match exactly");
  if (
    lock.lockfileVersion !== 3 ||
    lock.name !== pkg.name ||
    lock.version !== pkg.version ||
    lock.packages?.[""]?.name !== pkg.name ||
    lock.packages?.[""]?.version !== pkg.version
  )
    throw new Error("Package/lock identity must agree");
  const dependencies = new Map();
  for (const group of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
  ]) {
    if (stable(pkg[group]) !== stable(lock.packages[""][group]))
      throw new Error("Root dependency lock pins differ");
    for (const [name, version] of Object.entries(pkg[group] ?? {})) {
      if (
        !exact.test(version) ||
        lock.packages[`node_modules/${name}`]?.version !== version
      )
        throw new Error(`Exact dependency pin missing from lock: ${name}`);
      dependencies.set(name, version);
    }
  }
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (name === "") continue;
    let url;
    try {
      url = new URL(entry.resolved);
    } catch {
      throw new Error(`Dependency origin missing: ${name}`);
    }
    if (
      url.origin !== "https://registry.npmjs.org" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error(
        `Dependency origin is not the public npm registry: ${name}`,
      );
    const integrity = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(
      entry.integrity ?? "",
    );
    if (
      !integrity ||
      Buffer.from(integrity[1], "base64").length !== 64 ||
      Buffer.from(integrity[1], "base64").toString("base64") !== integrity[1]
    )
      throw new Error(`Dependency byte integrity missing or invalid: ${name}`);
  }
  return {
    node,
    dependencies: dependencies.size,
    lockedPackages: Object.keys(lock.packages).length - 1,
  };
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
)
  console.log(JSON.stringify(checkToolchain(process.cwd()), null, 2));
