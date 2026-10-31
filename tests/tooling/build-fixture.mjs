import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";

export function buildFixture(t, { clean = false, configure = () => {} } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "unmask-build-fixture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = {
    name: "unmask-build-fixture",
    version: "1.0.0",
    private: true,
    files: ["dist"],
    bin: { unmask: "dist/cli/main.mjs" },
    scripts: { build: "node scripts/build.mjs" },
    engines: { node: "24.22.2" },
  };
  mkdirSync(path.join(root, "scripts"));
  mkdirSync(path.join(root, "src/cli"), { recursive: true });
  writeFileSync(path.join(root, "src/.gitkeep"), "");
  mkdirSync(path.join(root, "output"));
  writeFileSync(
    path.join(root, "src/cli/main.mjs"),
    '#!/usr/bin/env node\nconsole.log("fixture");\n',
  );
  writeFileSync(
    path.join(root, "scripts/build.mjs"),
    readFileSync(new URL("../../scripts/build.mjs", import.meta.url)),
  );
  writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg));
  writeFileSync(
    path.join(root, "package-lock.json"),
    JSON.stringify({
      name: pkg.name,
      version: pkg.version,
      lockfileVersion: 3,
      packages: { "": { name: pkg.name, version: pkg.version, bin: pkg.bin } },
    }),
  );
  writeFileSync(path.join(root, ".nvmrc"), "24.22.2\n");
  writeFileSync(path.join(root, ".gitignore"), "dist/\noutput/\n");
  const build = () =>
    execFileSync(process.execPath, [path.join(root, "scripts/build.mjs")], {
      cwd: root,
      encoding: "utf8",
    });
  const commit = () => {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-qm",
        "test fixture",
      ],
      { cwd: root },
    );
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  };
  configure({ root, pkg });
  const sha = clean ? commit() : undefined;
  return { root, pkg, build, commit, sha };
}
