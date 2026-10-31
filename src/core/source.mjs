function unresolved(reason, directory = null) {
  return {
    status: "unresolved",
    directory,
    entries: [],
    manifest: null,
    reason,
  };
}
function directoryPath(value) {
  if (
    typeof value !== "string" ||
    /[\0\\]/u.test(value) ||
    value.startsWith("/") ||
    /^[a-z]:/iu.test(value)
  )
    return null;
  if (value === "") return "";
  const path = value.replace(/\/+$/u, "");
  return path.split("/").some((p) => !p || p === "." || p === "..")
    ? null
    : path;
}
function manifest(entry) {
  if (entry?.type !== "file" || !Buffer.isBuffer(entry.content)) return null;
  try {
    const value = JSON.parse(entry.content.toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
}
function blocked(entries, directory) {
  return entries.some(
    (e) =>
      e.path !== null &&
      e.path !== undefined &&
      e.type !== "directory" &&
      (e.path === directory || directory.startsWith(e.path + "/")),
  );
}
export function selectSourcePackage(
  inventory,
  { directory, packageName } = {},
) {
  const entries = inventory.entries;
  let selected = directory;
  if (selected !== undefined) {
    selected = directoryPath(selected);
    if (selected === null) return unresolved("invalid-directory");
  } else {
    if (!inventory.complete) return unresolved("incomplete-inventory");
    const candidates = entries.filter(
      (e) =>
        (e.path === "package.json" || e.path?.endsWith("/package.json")) &&
        typeof packageName === "string" &&
        manifest(e)?.name === packageName,
    );
    if (candidates.length !== 1)
      return unresolved(
        candidates.length ? "ambiguous-manifest" : "manifest-not-found",
      );
    selected = candidates[0].path
      .slice(0, -"package.json".length)
      .replace(/\/$/u, "");
  }
  if (selected && blocked(entries, selected))
    return unresolved("nonregular-package-root", selected);
  const prefix = selected ? selected + "/" : "";
  const selectedEntries = entries
    .filter(
      (e) =>
        typeof e.path === "string" &&
        e.path.startsWith(prefix) &&
        e.path !== selected,
    )
    .map((e) => ({ ...e, path: e.path.slice(prefix.length) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const existingDirectory = entries.some(
    (e) =>
      e.type === "directory" &&
      (e.path === selected || (selected === "" && e.path === null)),
  );
  if (!selectedEntries.length && !existingDirectory)
    return unresolved("directory-not-found", selected);
  if (selectedEntries.some((e) => directoryPath(e.path) === null))
    return unresolved("unsafe-mapped-path", selected);
  const manifestEntry = selectedEntries.find((e) => e.path === "package.json");
  const parsed = manifest(manifestEntry);
  const reason = !manifestEntry
    ? "missing"
    : manifestEntry.type !== "file"
      ? "nonregular-manifest"
      : !Buffer.isBuffer(manifestEntry.content)
        ? manifestEntry.inspection
        : "invalid-json";
  return {
    status: "selected",
    directory: selected,
    entries: selectedEntries,
    manifest: parsed,
    ...(!parsed ? { reason } : {}),
  };
}
