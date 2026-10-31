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
the configured product tests/build become required. Tests exercise actual
release planning, collision refusal, failed checks, archive digests, packaging
exclusions and the disabled publishing entrypoints. Packaging tests run real
`npm pack --ignore-scripts` and inspect the resulting tar archive. They do not
publish anything or execute a packed package.

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
- Supply a real Dockerfile named by `dockerfile`. It must consume the already
  built `dist/` distribution and locked production dependencies, avoid package
  lifecycle execution, run as a non-root user, and serve the website/API on
  `0.0.0.0:$PORT`. This change supplies no Dockerfile or server. `.dockerignore`
  admits only the built distribution, package metadata, license and Dockerfile.
  Update that allowlist deliberately if the actual Dockerfile name changes.
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
release gate. Ordinary branch pushes only run checks. An unchanged version on
main does not publish again. A version-changing push with an already used tag
or release fails rather than overwriting it; even a rerun of the same candidate
refuses an existing version. Choose a new version after a partially failed
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
contains no `npm publish` command. Registry trusted publishing, ownership and
provenance setup remain pending the authorized npm account/scope. No live
release, GHCR image or npm package has been published to validate these adapters.

## Deploy a selected release in DigitalOcean App Platform

The deployment portal is the existing App Platform dashboard; this project adds
no custom portal and creates no DigitalOcean resources. An operator selects a
published GitHub release number, reads its manifest, then selects that release's
GHCR image **by digest** in the dashboard. Do not deploy from the source branch
or a floating `latest` tag. GHCR publication does not auto-deploy App Platform.

Once the real server's port and health endpoint exist, configure a Web Service
with that port, HTTP health check and the required hosted model secret reference.
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
port, health path and model-secret availability remain unconfigured. For private
GHCR images, provision read-only pull credentials in the dashboard; never commit
them. App Platform supports Linux AMD64 container images and recommends digests.
After a separately authorized deployment, verify the serving digest and perform
the normal website/API smoke test. Health alone is not release acceptance.
Temporal is not involved in this foundation.

## Official references

- [GitHub workflow permissions](https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions#permissions)
- [GitHub immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
- [GitHub immutability settings endpoint](https://docs.github.com/en/rest/repos/repos#check-if-immutable-releases-are-enabled-for-a-repository)
- [GitHub release assets](https://docs.github.com/en/rest/releases/assets)
- [npm pack and ignore-scripts](https://docs.npmjs.com/cli/v12/commands/npm-pack/)
- [DigitalOcean container image deployment](https://docs.digitalocean.com/products/app-platform/how-to/deploy-from-container-images/)
