import { pathToFileURL } from "node:url";
import { releaseNotes } from "./release-notes.mjs";

const stable = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
function versionOrder(a, b) {
  const left = a.tag_name.match(stable).slice(1).map(BigInt);
  const right = b.tag_name.match(stable).slice(1).map(BigInt);
  for (let i = 0; i < 3; i++)
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}

function protectedFields(release) {
  const {
    id,
    tag_name,
    target_commitish,
    name,
    draft,
    prerelease,
    immutable,
    published_at,
    assets,
  } = release;
  return JSON.stringify({
    id,
    tag_name,
    target_commitish,
    name,
    draft,
    prerelease,
    immutable,
    published_at,
    assets: assets
      .map(({ id, name, size, digest }) => ({ id, name, size, digest }))
      .sort((a, b) => a.id - b.id),
  });
}

async function verifyTag(api, release) {
  let { object } = await api(`git/ref/tags/${release.tag_name}`);
  for (let depth = 0; object.type === "tag" && depth < 5; depth++) {
    if (!/^[a-f0-9]{40}$/.test(object.sha))
      throw new Error("Invalid tag object");
    ({ object } = await api(`git/tags/${object.sha}`));
  }
  if (
    object.type !== "commit" ||
    !/^[a-f0-9]{40}$/.test(object.sha) ||
    object.sha !== release.target_commitish
  )
    throw new Error("Resolved release tag differs from full target commit");
}

export async function syncReleaseNotes({ repository, api }) {
  const releases = [];
  for (let page = 1; ; page++) {
    if (page > 100)
      throw new Error("Release inventory exceeded pagination limit");
    const records = await api(`releases?per_page=100&page=${page}`);
    releases.push(...records);
    if (records.length < 100) break;
  }
  const published = releases
    .filter(
      (r) =>
        !r.draft && !r.prerelease && r.published_at && stable.test(r.tag_name),
    )
    .sort((a, b) => versionOrder(b, a));
  if (!published.length) throw new Error("No published stable release");
  const candidate = published[0];
  const release = await api(`releases/${candidate.id}`);
  if (
    release.id !== candidate.id ||
    release.tag_name !== candidate.tag_name ||
    release.draft ||
    release.prerelease ||
    !release.published_at ||
    release.immutable !== true
  )
    throw new Error(
      "Latest release is not the expected published immutable stable release",
    );
  await verifyTag(api, release);
  const notes = await releaseNotes({
    repository,
    sha: release.target_commitish,
    releases: published.filter((r) => versionOrder(r, release) < 0),
    api,
  });
  const priorBody = release.body || "";
  if (priorBody === notes || priorBody.includes(`\n\n${notes}`))
    return { updated: false, releaseId: release.id };
  if (/^## Commits\s*$/m.test(priorBody))
    throw new Error("Different existing commit section requires manual review");
  const body = `${priorBody}\n\n${notes}`;
  const fresh = await api(`releases/${release.id}`);
  if (
    fresh.body !== release.body ||
    protectedFields(fresh) !== protectedFields(release)
  )
    throw new Error("Release changed before notes update");
  await verifyTag(api, release);
  await api(`releases/${release.id}`, { method: "PATCH", body: { body } });
  const verified = await api(`releases/${release.id}`);
  if (
    verified.body !== body ||
    protectedFields(verified) !== protectedFields(release)
  )
    throw new Error(
      "Release notes readback verification failed or protected fields changed",
    );
  await verifyTag(api, release);
  return { updated: true, releaseId: release.id };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const {
    GITHUB_REPOSITORY: repository,
    GITHUB_REF: ref,
    GITHUB_EVENT_NAME: event,
    GITHUB_TOKEN: token,
  } = process.env;
  if (
    repository !== "Vaiditya2207/unmask" ||
    ref !== "refs/heads/main" ||
    !["push", "workflow_dispatch"].includes(event) ||
    !token
  )
    throw new Error("Release notes sync requires trusted main Actions context");
  const api = async (endpoint, { method = "GET", body } = {}) => {
    const response = await fetch(
      `https://api.github.com/repos/${repository}/${endpoint}`,
      {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2026-03-10",
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    if (!response.ok)
      throw new Error(
        `Release notes GitHub ${method} failed (${response.status})`,
      );
    return response.json();
  };
  console.log(JSON.stringify(await syncReleaseNotes({ repository, api })));
}
