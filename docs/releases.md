# CI, releases and manual deployment

The repository currently has **tooling tests, not an analyzer or server**.
`release.config.json` keeps publishing disabled, npm remains private at `0.0.0`,
and the release workflow skips publication. A green Repository checks job means
formatting, release-policy tests and npm archive checks passed. It does not mean
the website, package analysis, model integration or deployment works.

## Checks on every branch and PR

Use the exact Node version in `.nvmrc` (24.22.2):

```bash
npm ci --ignore-scripts
npm run check
npm test
npm run check:package
npm run release:readiness
```

The last command intentionally exits nonzero for the scaffold. CI prints its blockers and skips product publishing without claiming product
readiness. Once publishing is enabled, incomplete prerequisites fail checks and
the configured product tests/build become required. Read-only PR and branch CI
also builds the configured Linux AMD64 image locally, then passes that exact
image and the real npm tarball to `test:release`. It checks the original image ID
and archive digest again after smoke. Build or smoke failure fails the required
Repository checks job; there is no registry login, push or secret access in this
path. Product smoke must therefore work without fork secrets or fail closed. Tests exercise actual
release planning, collision refusal, failed checks, archive digests, packaging
exclusions and the disabled publishing entrypoints. Packaging tests run real
`npm pack --ignore-scripts` and inspect the resulting tar archive. They do not
publish anything or execute a packed package. Candidate-orchestration tests
use actual npm tarballs with simulated Docker/smoke process adapters, covering
build/smoke failure propagation and changed archive/image identity. Those tests
do not establish a working Dockerfile or product runtime.

PR and branch checks have only `contents: read`, use commit-pinned actions, and
install with `npm ci --ignore-scripts`. There is no `pull_request_target` or PR
secret access. Configure GitHub branch protection separately to require
`Repository checks`; workflow files do not establish repository protection.

## Prerequisites to open the release gate

These are future product implementation requirements, not supplied application
code. Complete them in reviewed changes before setting `enabled: true`:

- Obtain the authorized npm name/account/scope. Set `approvedPackageName` to that
  exact package name, supply public npm `publishConfig`, `bin.unmask`, a stable
  positive version and `private: false`. Keep the lockfile identity/version in
  sync. Merely removing `private` does not authorize publication.
- Implement real CLI, HTTP server and website source. List at least three
  distinct real source files in `sourceFiles`. Set `cli`, `server` and `web` to
  the actual nonempty built files under `dist/`. All three must be present in
  the npm archive; this foundation uses a single built distribution.
- Add meaningful product tests under `productTestDirectory`, with `.test` or
  `.spec` filenames. Add actual `build`, `test:product` and `test:release`
  commands. No no-op commands or generated placeholder applications qualify.
- Supply a real Dockerfile named by `dockerfile`. It must consume the **exact
  CI-produced npm tarball** and its matching lockfile, rather than independently
  rebuilding or copying a separate `dist/` tree. Install locked production
  dependencies with `npm ci --omit=dev --ignore-scripts`, run as a non-root user,
  and serve the website/API on `0.0.0.0:$PORT`. Include the npm tarball SHA-256 in
  an image label. The server's `/version` response must expose the release
  version, full source commit and that same tarball hash; smoke checks must
  compare them with the release manifest.
- The actual Dockerfile, tarball build-context wiring, label and `/version`
  implementation belong to the app PR. This foundation supplies no Dockerfile
  or server. Its current `.dockerignore` admits the built distribution, package
  metadata, license and Dockerfile, and does **not** yet admit the exact tarball.
  The app PR must update that allowlist and candidate/release build inputs before
  enabling the gate; the foundation does not yet enforce this artifact contract.
- Implement `test:release` to install and exercise `RELEASE_PACKAGE` in an isolated
  temporary directory, start `RELEASE_IMAGE`, and test the real website and API
  through the normal HTTP entrypoint. Verify persisted analysis and a follow-up
  request if state matters. Clean up containers and temporary files on failure.
  The image must use the intended hosted Google Gemma API configuration; no
  local Ollama or substituted model path is configured here. Model credentials
  and provider-backed test isolation need a separate authorized setup.
- Enable GitHub release immutability in repository settings. Publication checks
  `GET /repos/{owner}/{repo}/immutable-releases` before any tag/image mutation.
  That endpoint requires Administration read, which `GITHUB_TOKEN` may lack.
  If needed, configure a separately authorized read-only
  `RELEASE_SETTINGS_TOKEN`; it is used only for that settings check. The normal
  workflow token needs Contents write and Packages write in the publication job.
  No credential was requested or configured by this change.

## Versioned release contract

A version-changing push to `main` runs the same repository checks before the
release gate. Release runs use `queue: max` without cancellation so a later
documentation-only push does not replace a waiting version bump. GitHub permits
up to 100 pending runs; excess runs are canceled. Queue order follows when runs
start waiting and is not a guarantee of commit order. A later version published
first makes an older candidate fail the monotonic-version check rather than
publishing out of order. Monitor canceled or failed candidates and choose a new
version when recovery is needed. Ordinary branch pushes only run checks. An unchanged version on
main does not publish again. A version-changing push with an already used tag
or release fails rather than overwriting it; even a rerun of the same candidate
refuses an existing version. The candidate must also be greater than every
existing stable version in tags and releases; comparison uses BigInt numeric
segments, not lexical ordering or floating-point numbers. Prerelease and
unrelated tags do not count as stable versions. Choose a new version after a partially failed
publication. No automatic rollback deletes tags, releases, assets or images.

When enabled, the workflow runs product tests and builds the actual application,
checks built entrypoints and packs the npm tarball. It builds a Linux AMD64 image
locally, then runs `test:release` with that exact image and tarball. Publication
requires successful checks and smoke, the same checkout SHA, the original archive
digest and the same local image ID, architecture and revision label.

Before publishing, the tooling inventories GitHub tags/releases, confirms release
immutability, and refuses existing GHCR version/SHA tags. It creates the Git tag
without force, pushes version and full-SHA image tags, and checks both registry
digests agree. GHCR tags themselves are mutable registry references; deployment
must use the recorded digest. GitHub immutability locks the published release's
assets and Git tag. A failure after reserving a tag or pushing an image can leave
partial artifacts; recover by reviewing the failed run and using a new version.
Do not overwrite or delete artifacts to make a retry pass.

The workflow attaches the npm tarball and `release-manifest.json` to a draft,
checks GitHub's uploaded asset digest/size, verifies the Git tag still points to
the candidate, then publishes and confirms immutability. The manifest binds:

- The stable version, Git tag, full source SHA and workflow URL.
- The npm package name, tarball filename, byte size and SHA-256 digest.
- The GHCR image digest/reference and `linux/amd64` platform.

**An attached npm tarball is not an npm registry publication.** This foundation
contains no `npm publish` command, and the manifest keeps
`package.registryPublished: false`. A completed GitHub artifact release would
satisfy the GitHub distribution step while npm registry acceptance remains unmet.
Registry trusted publishing, ownership and provenance setup remain pending the
authorized npm account/scope. No live release, GHCR image or npm package has been
published to validate these adapters.

## Deploy a selected release in DigitalOcean App Platform

The deployment portal is the existing App Platform dashboard; this project adds
no custom portal and creates no DigitalOcean resources. An operator selects a
published GitHub release number and reads its manifest. In the app's dashboard, open
**Settings → App Spec → Edit** and set `image.digest` to that release's GHCR digest and **omit
`image.tag`**. Save/apply the spec through the dashboard for an authorized
manual deployment. To roll back, select a previously verified release and apply
its recorded digest through the same App Spec editor. Do not deploy from the
source branch or a floating `latest` tag. GHCR publication does not auto-deploy
App Platform.

For the initial deployment, manually make the GHCR image public and verify
anonymous pull access. That visibility setting is an operator prerequisite;
this foundation does not change package visibility or provision pull credentials.

Once the real server's port and health endpoint exist, configure a Web Service
with that port, HTTP health check and the required hosted model secret reference.
Use a **single app instance** while report storage is in memory: a request routed
to a second instance could otherwise return a report 404. Scaling requires shared
report storage or an explicit routing design in a later app change.
For an app spec, the source fields will have this shape:

```yaml
image:
  registry_type: GHCR
  registry: <GitHub-owner>
  repository: <repository-name>
  digest: sha256:<digest-from-release-manifest>
```

This excerpt is a contract, not a deployable app spec. Account/project, budget,
region, instance size, registry visibility/pull access, actual server entrypoint,
port, health path and model-secret availability remain unconfigured. Private
registry access is outside the initial public-image deployment contract and
requires a separately authorized setup. App Platform supports Linux AMD64
container images and recommends digests. After a separately authorized deployment,
verify the serving digest and `/version` identity against the chosen manifest,
then perform the normal website/API smoke test. Health alone is not release acceptance.
Temporal is not involved in this foundation.

## Official references

- [GitHub concurrency queues](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
- [GitHub workflow permissions](https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions#permissions)
- [GitHub immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
- [GitHub immutability settings endpoint](https://docs.github.com/en/rest/repos/repos#check-if-immutable-releases-are-enabled-for-a-repository)
- [GitHub release assets](https://docs.github.com/en/rest/releases/assets)
- [npm pack and ignore-scripts](https://docs.npmjs.com/cli/v12/commands/npm-pack/)
- [DigitalOcean dashboard App Spec editing](https://docs.digitalocean.com/products/app-platform/how-to/update-app-spec/)
- [DigitalOcean container image deployment](https://docs.digitalocean.com/products/app-platform/how-to/deploy-from-container-images/)
