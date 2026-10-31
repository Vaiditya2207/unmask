# CI, releases and manual deployment

The repository now contains a CLI, HTTP server and website. Publication remains
closed: `private: true`, version `0.0.0` and `release.config.json.enabled: false`
are intentional gates. Passing local tests does not establish a working image,
hosted model or deployment. No release, registry package or image was published
while implementing this flow. The Docker adapter is runtime-unverified because
no Docker daemon was available.

## Local distribution checks

Use Node 24.22.2 from `.nvmrc` and the checked-in lockfile:

```bash
npm ci --ignore-scripts
npm run check
npm run build
npm test
node scripts/check-package.mjs --build
node scripts/release-readiness.mjs --report
```

`check-package.mjs` requires declared `bin` entrypoints by default. Missing or
stale `dist/` fails; `--build` explicitly rebuilds before packing. The build copies
all supported product modules, removes previous output and records each module's
size and SHA-256. Its source hash includes every product module, package metadata,
the lockfile, build script and Node pin. Unsupported source formats fail closed
instead of being omitted. Adding TypeScript or assets requires updating this
build contract first.

Packing verifies actual output bytes against the source inventory and build
manifest, then checks those same bytes inside the real `npm pack --ignore-scripts`
archive. The package allowlist admits built distribution files and public metadata,
not source, tests, scripts or research. Dirty local builds are diagnostic and use
`commit: unknown`; release candidates require a clean checkout, full expected SHA
and matching build commit. Changing source, package or lock bytes invalidates an
existing build.

The distribution test installs the real archive outside the checkout and runs its
CLI on inert local archives. The release smoke additionally verifies a planted
lifecycle-script difference produces the expected review finding and exit code 3.
Target package lifecycle scripts are never run. These checks do not call a model.

## Checks on branches and PRs

Repository checks install locked dependencies without lifecycle scripts, check
formatting, explicitly build before artifact tests, run product/tooling tests and
inspect the packed distribution. With publishing disabled, readiness prints its
blockers and product publication remains skipped. Configure branch protection
separately to require `Repository checks`.

Once configured readiness is true, PR and push checks also build the candidate's
Linux AMD64 image and run `test:release` against its exact tarball and image. These
jobs have only `contents: read`, commit-pinned actions and no registry login, push
or secrets. There is no `pull_request_target`. Build or smoke failure fails the
checks before a main publication attempt. Smoke therefore needs to work without
fork secrets. Docker orchestration tests use fake process adapters; HTTP contract
tests use a recorded transport. Neither establishes live image acceptance.

## Exact artifact image and smoke contract

Candidate construction first verifies a fresh build at the clean expected SHA,
then packs the actual product. It stages six files in a private temporary context:
`artifact.tgz`, its extracted `package.json`, the matching root `package-lock.json`,
`Dockerfile`, `.dockerignore` and digest-bound `candidate.json`. Repository source,
separate `dist/`, credentials and unrelated files are absent. Context contents and
hashes are checked before and after image construction and cleaned on failure.

The Dockerfile uses the pinned Node 24.22.2 bookworm-slim image digest, validates
the supplied archive and lock digests, extracts that archive and runs
`npm ci --omit=dev --ignore-scripts`. It never independently rebuilds product
source. The image runs as `node` on `0.0.0.0:8080`. Image labels bind version,
commit, tarball SHA-256 and lock SHA-256. `/version` must return the same version,
commit and `tarballSha256`; health alone is insufficient.

Wire `test:release` to `node scripts/smoke-candidate.mjs`. Both candidate and
release workflows supply:

- `RELEASE_PACKAGE` and `RELEASE_LOCKFILE`: exact tested archive and matching lock.
- `RELEASE_PACKAGE_SHA256` and `RELEASE_LOCKFILE_SHA256`: raw 64-character hex hashes.
- `RELEASE_VERSION` and `RELEASE_COMMIT`: expected stable version and full SHA.
- `RELEASE_IMAGE`: locally loaded exact image, or `RELEASE_CANDIDATE_URL`: an
  already running authorized candidate origin.
- `RELEASE_SMOKE_MODE=live-public` and `RELEASE_SMOKE_PACKAGE=is-number@7.0.0`:
  an explicit, exact public reference for the representative core check.

The smoke installs locked production dependencies offline in an isolated directory,
runs the inert CLI lifecycle check, and requires HTTP verification as well. When
an image is supplied, it runs a temporary read-only container with bounded `/tmp`,
a loopback port and `UNMASK_MODEL=off`, then removes it on success or failure.
It compares `/version`, uses the normal form POST, polls persisted report JSON,
checks the submitted package identity, verifies rendered HTML and repeats the JSON
request to check persistence. Candidate orchestration rechecks the original archive,
clean build and local image ID afterward. No replacement source build qualifies.

`recorded` transport is available for explicit diagnostic tests and is labeled as
such. Only an authorized `live-public` run of the exact candidate provides the
representative core runtime evidence. Both modes report model acceptance as
`not-tested`; hosted Google Gemma quota, credentials, countTokens support and
meaningful inference acceptance require a separate authorized test. No model key
is needed or exposed by these core checks.

## Opening the publication gate

Before enabling publication, configure the authorized public npm identity and
`publishConfig`, a positive stable version, matching lock identity and actual
CLI/server/website source and output paths. Configure meaningful `build`,
`test:product` and `test:release` commands. Keep these settings disabled until
reviewed product and runtime prerequisites are satisfied.

The main workflow requires checks, product build, exact image smoke and a clean
matching SHA before publishing. It inventories GitHub stable tags/releases and
rejects any candidate less than or equal to the maximum existing stable version,
using BigInt segments. Exact collisions also fail. Prerelease and unrelated tags
are excluded. Unchanged-version pushes do not publish. Never overwrite a version
or delete partial artifacts to make a rerun pass; review failures and use a new
version.

Release runs use `queue: max` without cancellation. GitHub permits up to 100
pending runs, and queue order follows when runs start waiting. A later version
published first causes an older candidate to fail the monotonic version gate.
Preparation checks release immutability and GHCR tag availability before npm
publication. Both are checked again immediately before GitHub/GHCR mutations.
Existing version and full-SHA image tags are refused. The immutability endpoint requires
authorized Administration-read `RELEASE_SETTINGS_TOKEN`; the publication job's
normal token has Contents write and Packages write. No token was retrieved or
configured by this change.

The workflow reserves the Git tag, pushes version and full-SHA image tags,
requires both registry digests to agree, uploads the archive and manifest to a
draft release, checks uploaded digest/size and tag SHA, and publishes while
confirming immutability. Failures can leave partial reserved artifacts. Deployment
uses a digest because GHCR tags remain mutable references.

`release-manifest.json` binds stable version, tag, commit, workflow URL, package
name/archive size/archive digest/lock digest/source hash, and Linux AMD64 image
digest. Attaching a tarball to GitHub does not publish it to npm. When
`npmPublishEnabled` is false the manifest reports `package.registryPublished: false`.

With `npmPublishEnabled: true`, the main-push workflow injects the existing
`NPM_TOKEN` secret only into the npm publication step after exact candidate smoke.
It publishes the prepared archive with `--ignore-scripts --access public` to the
public npm registry, without rebuilding or repacking. The single configured npm
gate is sufficient; the automatic route needs no additional repository variable.
PR/shared checks receive no npm credential. No token value belongs in source,
arguments, logs or release receipts.

Before marking npm publication successful, the adapter checks the public version's
identity and SHA-512 integrity, downloads its canonical public-registry tarball
without authentication, and compares its size and SHA-256 with the tested archive.
An identical existing version is verified without publishing it again; conflicting
bytes fail. An uncertain command result is resolved by bounded read-only lookups,
not repeated publication commands. The saved non-secret receipt binds version,
commit and archive hashes. GitHub publication verifies that receipt and public
bytes again before reporting `registryPublished: true`. A successful publish
command alone is insufficient.

First publication requires write access to the `@xagents_in` namespace and a
publish-capable granular token with bypass 2FA enabled. A stage-only token cannot
perform this direct route; staging would require a separate maintainer approval
and is not silently substituted. The user's reported secret presence does not
establish its permissions, validity or npm ownership. A missing or rejected token
fails publication without exposing provider output. Bootstrap token publication
does not claim trusted-publisher provenance.

Trusted publishing can be configured after the package exists. npm's current
[trust prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/#prerequisites)
require package write access, account 2FA and npm CLI 11.15.0 or newer for trust
configuration; a bypass-2FA token cannot perform that governance operation.
The [publishing workflow](https://docs.npmjs.com/trusted-publishers/) itself needs
npm CLI 11.5.1 or newer, Node 22.14.0 or newer, a supported hosted runner,
`id-token: write`, and exact repository/workflow configuration. New trust must
complete its first successful publication within two days. Configure direct
`npm publish` permission when automatic direct releases are intended. See npm's
[current authentication rules](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification/).

The existing GitHub immutability check requires Administration read, which the
workflow's ordinary Contents/Packages token does not grant. Configure the authorized
`RELEASE_SETTINGS_TOKEN` and enable repository release immutability before the first
release. GHCR initially creates a private package; public image visibility and
anonymous digest pull remain operator prerequisites for the public-image deployment.
Publication across npm, Git tags, GHCR and GitHub assets is not atomic. A later
failure may leave partial artifacts. Review the failed run, preserve existing
artifacts and use the documented recovery rules. Keep named reviewer protections.

This local change used synthetic transport/process adapters and real inert npm
archives. No credential was retrieved, token authentication attempted, registry
package published, image pushed or server deployed while preparing it. Real npm
installation and the exact deployed image's normal HTTP flow remain release-time
acceptance checks. Deterministic functionality can ship while hosted Gemma quality
remains explicitly unverified.

## Deploy a selected release in DigitalOcean App Platform

The deployment portal is the existing App Platform dashboard. This change creates
no resources or custom portal and does not auto-deploy branch pushes or GHCR
publication. Select a verified GitHub release and its manifest. In
**Settings → App Spec → Edit**, set its recorded `image.digest` and omit
`image.tag`. Roll back by selecting a previously verified release's digest through
the same editor. Do not deploy a source branch or floating `latest` tag.

Make the initial GHCR image public manually and verify anonymous pull access.
Configure the Web Service port, `/healthz` and any separately authorized model
secret references. Use one app instance while reports are held in memory; scaling
requires shared report storage or an explicit routing design to avoid report 404s.

```yaml
image:
  registry_type: GHCR
  registry: <GitHub-owner>
  repository: <repository-name>
  digest: sha256:<digest-from-release-manifest>
```

This excerpt is a contract, not a deployable app spec. Account, budget, region,
instance size, visibility/pull access and runtime configuration remain operator
prerequisites. After a separately authorized deployment, verify the serving digest
and `/version`, then repeat the normal website/API smoke against that exact
release. Temporal is not involved. Local tests, recorded HTTP tests and source
inspection do not establish deployment or model acceptance.

## Official references

- [GitHub concurrency queues](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
- [GitHub workflow permissions](https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions#permissions)
- [GitHub immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
- [GitHub immutability settings endpoint](https://docs.github.com/en/rest/repos/repos#check-if-immutable-releases-are-enabled-for-a-repository)
- [GitHub release assets](https://docs.github.com/en/rest/releases/assets)
- [npm pack and ignore-scripts](https://docs.npmjs.com/cli/v12/commands/npm-pack/)
- [DigitalOcean dashboard App Spec editing](https://docs.digitalocean.com/products/app-platform/how-to/update-app-spec/)
- [DigitalOcean container image deployment](https://docs.digitalocean.com/products/app-platform/how-to/deploy-from-container-images/)
