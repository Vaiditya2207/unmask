const commitLimit = 100;
const stableTag = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function previousRelease(releases) {
  return releases
    .filter(
      (release) =>
        !release.draft &&
        !release.prerelease &&
        stableTag.test(release.tag_name),
    )
    .sort((left, right) => {
      const a = left.tag_name.match(stableTag).slice(1).map(BigInt);
      const b = right.tag_name.match(stableTag).slice(1).map(BigInt);
      for (let index = 0; index < 3; index++) {
        if (a[index] !== b[index]) return a[index] > b[index] ? -1 : 1;
      }
      return 0;
    })[0];
}

function subject(message) {
  const line = message
    .split(/[\r\n]/, 1)[0]
    .replace(/[\u0000-\u001f\u007f]/g, " ");
  const bounded = line.length > 200 ? `${line.slice(0, 199)}…` : line;
  return bounded
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/@/g, "&#64;")
    .replace(/[\\`*_{}\[\]()#+.!|~]/g, "\\$&");
}

export async function releaseNotes({ repository, sha, releases, api }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[a-f0-9]{40}$/.test(sha))
    throw new Error(
      "Release notes require a repository and full candidate SHA",
    );
  const previous = previousRelease(releases);
  const comparison = previous
    ? await api(
        `compare/${previous.tag_name}...${sha}?per_page=${commitLimit}&page=1`,
      )
    : undefined;
  const commits = previous
    ? comparison.commits
    : await api(`commits?sha=${sha}&per_page=${commitLimit}&page=1`);
  if (
    !Array.isArray(commits) ||
    commits.length > commitLimit ||
    (previous &&
      (!["ahead", "identical"].includes(comparison.status) ||
        !Number.isSafeInteger(comparison.total_commits) ||
        comparison.total_commits < 0 ||
        commits.length !== Math.min(comparison.total_commits, commitLimit) ||
        (comparison.status === "identical") !==
          (comparison.total_commits === 0)))
  )
    throw new Error(
      "Release commit comparison is incomplete or not an ancestor range",
    );
  const base = `https://github.com/${repository}`;
  const lines = commits.map((entry) => {
    if (
      !/^[a-f0-9]{40}$/.test(entry.sha) ||
      typeof entry.commit?.message !== "string"
    )
      throw new Error("Invalid release commit metadata");
    return `- [\`${entry.sha.slice(0, 7)}\`](${base}/commit/${entry.sha}) ${subject(entry.commit.message)}`;
  });
  const link = previous
    ? `[Full compare: ${previous.tag_name} → ${sha.slice(0, 7)}](${base}/compare/${previous.tag_name}...${sha})`
    : `[Full commit history](${base}/commits/${sha})`;
  const truncation =
    previous && comparison.total_commits > commitLimit
      ? `Showing ${commitLimit} of ${comparison.total_commits} commits; see the full compare for the complete list.`
      : !previous && commits.length === commitLimit
        ? `Showing up to ${commitLimit} latest commits; see the full commit history for the complete list.`
        : "";
  return [
    "## Commits",
    previous
      ? `Changes since ${previous.tag_name}.`
      : "Initial release; no previous published stable release.",
    lines.join("\n") || "No new commits since the previous release.",
    truncation,
    link,
  ]
    .filter(Boolean)
    .join("\n\n");
}
