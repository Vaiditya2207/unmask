import {
  appendFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function validRelative(relative) {
  return (
    typeof relative === "string" &&
    /^[a-zA-Z0-9_@./-]+$/.test(relative) &&
    !path.isAbsolute(relative) &&
    !relative.split("/").some((part) => !part || part === ".." || part === ".")
  );
}

export function versionChanged(previous, current) {
  return typeof previous === "string" && previous !== current;
}

export function localFile(root, relative) {
  if (!validRelative(relative)) return false;
  const target = path.resolve(root, relative);
  return (
    target.startsWith(`${path.resolve(root)}${path.sep}`) &&
    existsSync(target) &&
    realpathSync(target).startsWith(`${realpathSync(root)}${path.sep}`) &&
    statSync(target).isFile() &&
    statSync(target).size > 0
  );
}

export function readiness(root, { built = false } = {}) {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json")));
  const config = JSON.parse(
    readFileSync(path.join(root, "release.config.json")),
  );
  const reasons = [];
  const lockPath = path.join(root, "package-lock.json");
  if (!existsSync(lockPath)) reasons.push("Pinned npm lockfile is required");
  else {
    const lock = JSON.parse(readFileSync(lockPath));
    if (
      lock.name !== pkg.name ||
      lock.version !== pkg.version ||
      lock.packages?.[""]?.name !== pkg.name ||
      lock.packages?.[""]?.version !== pkg.version
    )
      reasons.push("Package and lockfile identity/version differ");
  }
  if (config.enabled !== true) reasons.push("Release publishing is disabled");
  if (
    pkg.private !== false ||
    !config.approvedPackageName ||
    pkg.name !== config.approvedPackageName
  )
    reasons.push("Approved public npm identity is not configured");
  if (
    pkg.publishConfig?.registry !== "https://registry.npmjs.org/" ||
    pkg.publishConfig?.access !== "public"
  )
    reasons.push("Public npm publishConfig is missing");
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(pkg.version) ||
    pkg.version === "0.0.0"
  )
    reasons.push("A positive stable version is required");
  for (const script of ["build", "test:product", "test:release"]) {
    if (
      typeof pkg.scripts?.[script] !== "string" ||
      !pkg.scripts[script].trim()
    )
      reasons.push(`Missing product command: ${script}`);
  }
  if (
    !Array.isArray(config.sourceFiles) ||
    new Set(config.sourceFiles).size < 3 ||
    config.sourceFiles.some((file) => !localFile(root, file))
  )
    reasons.push("Real CLI, server and website source files are required");
  if (!localFile(root, config.dockerfile))
    reasons.push("Real Dockerfile is required");
  const testRoot =
    typeof config.productTestDirectory === "string" &&
    !config.productTestDirectory.includes("..") &&
    !path.isAbsolute(config.productTestDirectory)
      ? path.join(root, config.productTestDirectory)
      : "";
  if (
    !testRoot ||
    !existsSync(testRoot) ||
    !statSync(testRoot).isDirectory() ||
    !readdirSync(testRoot, { recursive: true }).some(
      (file) =>
        /\.(test|spec)\.[cm]?[jt]sx?$/.test(file) && localFile(testRoot, file),
    )
  )
    reasons.push("Product test files are required");
  for (const entry of ["cli", "server", "web"]) {
    if (
      !validRelative(config[entry]) ||
      !config[entry].startsWith("dist/") ||
      (built && !localFile(root, config[entry]))
    )
      reasons.push(
        `Missing ${built ? "built " : ""}${entry} entrypoint under dist/`,
      );
  }
  if (typeof pkg.bin?.unmask !== "string" || pkg.bin.unmask !== config.cli)
    reasons.push("npm bin.unmask must identify the CLI entrypoint");
  return {
    ready: reasons.length === 0,
    enabled: config.enabled === true,
    reasons,
    version: pkg.version,
  };
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  const result = readiness(process.cwd(), {
    built: process.argv.includes("--built"),
  });
  if (process.argv.includes("--version-candidate") && result.ready) {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH));
    if (!/^[a-f0-9]{40}$/.test(event.before || "") || /^0+$/.test(event.before))
      throw new Error("Previous main commit is required");
    const previous = JSON.parse(
      execFileSync("git", ["show", `${event.before}:package.json`], {
        encoding: "utf8",
      }),
    );
    if (!versionChanged(previous.version, result.version)) {
      result.ready = false;
      result.reasons.push("No version change on this main push");
    }
  }
  console.log(JSON.stringify(result, null, 2));
  if (process.argv.includes("--github-output")) {
    if (!process.env.GITHUB_OUTPUT)
      throw new Error("GITHUB_OUTPUT is required");
    appendFileSync(process.env.GITHUB_OUTPUT, `ready=${result.ready}\n`);
    if (
      result.enabled &&
      !result.ready &&
      !result.reasons.includes("No version change on this main push")
    )
      process.exitCode = 1;
  } else if (!process.argv.includes("--report") && !result.ready)
    process.exitCode = 1;
}
