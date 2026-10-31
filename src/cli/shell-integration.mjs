import path from "node:path";

export const SHELL_MARKER = "# unmask-shell-integration v1";
export const SHELL_ENV = "UNMASK_SHELL_INTEGRATION";
export const SHELL_ENV_VALUE = "npm-guard-v1";
export const SHELLS = Object.freeze(["bash", "zsh", "fish"]);
const INSTALL = [
  "install",
  "i",
  "in",
  "ins",
  "inst",
  "insta",
  "instal",
  "isnt",
  "isnta",
  "isntal",
  "isntall",
  "add",
];
const CI = ["ci", "clean-install", "ic", "install-clean", "isntall-clean"];
// Ownership is the exact definition recorded at enable time, never a text match inside some other npm function.
const OWNED = "__UNMASK_NPM_FUNCTION";

const posix = {
  enable: () =>
    [
      SHELL_MARKER,
      `if alias npm >/dev/null 2>&1 || { typeset -f npm >/dev/null 2>&1 && [ "$(typeset -f npm)" != "\${${OWNED}-}" ]; }; then`,
      "  echo 'unmask: an existing npm alias or function was left unchanged; guarded npm was not enabled' >&2",
      "else",
      "function npm {",
      '  if [ -z "${UNMASK_GUARD_ACTIVE:-}" ]; then',
      '    case "${1-}" in',
      `      ${INSTALL.join("|")}) shift; command unmask install "$@"; return $? ;;`,
      `      ${CI.join("|")}) shift; command unmask ci "$@"; return $? ;;`,
      "    esac",
      "  fi",
      '  command npm "$@"',
      "}",
      `${OWNED}="$(typeset -f npm)"`,
      `export ${SHELL_ENV}=${SHELL_ENV_VALUE}`,
      "fi",
    ].join("\n"),
  disable: () =>
    [
      SHELL_MARKER,
      `if [ -n "\${${OWNED}-}" ] && [ "$(typeset -f npm 2>/dev/null)" = "$${OWNED}" ]; then unset -f npm; fi`,
      `unset ${OWNED} ${SHELL_ENV}`,
    ].join("\n"),
};
const fish = {
  enable: () =>
    [
      SHELL_MARKER,
      "set -l __unmask_current",
      "functions -q npm; and set __unmask_current (functions npm | string collect)",
      `if functions -q npm; and test "$__unmask_current" != "$${OWNED}"`,
      "    echo 'unmask: an existing npm function was left unchanged; guarded npm was not enabled' >&2",
      "else",
      "function npm --wraps npm --description 'unmask guarded npm install/ci'",
      "    set -l rest $argv",
      "    set -e rest[1]",
      "    if not set -q UNMASK_GUARD_ACTIVE",
      '        switch "$argv[1]"',
      `            case ${INSTALL.join(" ")}`,
      "                command unmask install $rest",
      "                return $status",
      `            case ${CI.join(" ")}`,
      "                command unmask ci $rest",
      "                return $status",
      "        end",
      "    end",
      "    command npm $argv",
      "end",
      `set -g ${OWNED} (functions npm | string collect)`,
      `set -gx ${SHELL_ENV} ${SHELL_ENV_VALUE}`,
      "end",
    ].join("\n"),
  disable: () =>
    [
      SHELL_MARKER,
      `if functions -q npm; and test (functions npm | string collect) = "$${OWNED}"`,
      "    functions -e npm",
      "end",
      `set -e ${OWNED}`,
      `set -e ${SHELL_ENV}`,
    ].join("\n"),
};

export function shellIntegrationScript(action, shell) {
  if (!["enable", "disable"].includes(action) || !SHELLS.includes(shell))
    throw new TypeError("Unsupported shell integration request");
  return (shell === "fish" ? fish : posix)[action]() + "\n";
}

export function runShellIntegration(action, args, runtime = {}) {
  const env = runtime.env ?? process.env;
  const stdout = runtime.stdout ?? process.stdout;
  const stderr = runtime.stderr ?? process.stderr;
  const detected = path.basename(env.SHELL ?? "");
  const shell = args[0] ?? (SHELLS.includes(detected) ? detected : undefined);
  if (args.length > 1 || !SHELLS.includes(shell)) {
    stderr.write(
      `usage: unmask ${action} <${SHELLS.join("|")}> prints shell code; nothing is written to shell startup files.\n`,
    );
    return 2;
  }
  stdout.write(shellIntegrationScript(action, shell));
  if (stdout.isTTY) {
    const load =
      shell === "fish"
        ? `unmask ${action} fish | source`
        : `eval "$(unmask ${action} ${shell})"`;
    stderr.write(
      action === "enable"
        ? `To guard npm install/ci in this shell run: ${load}\nTo persist, add that line to your shell startup file yourself. Undo with: ${load.replace("enable", "disable")}\n`
        : `To remove the guarded npm function from this shell run: ${load}\n`,
    );
  }
  return 0;
}
