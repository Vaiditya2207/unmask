# Frontend PR previews implementation plan

Goal: every open frontend PR from an explicitly allowed head repository gets a temporary, independently addressable website for review. Closing the PR removes its preview. Production releases retain their existing flow.

Architecture: a read-only `pull_request` build uploads a Linux AMD64 image artifact without cloud credentials. A trusted workflow_run deployment validates the successful build, current PR head and repository before loading and pushing the image, then assigns a PR tag on a dedicated Cloud Run preview service. A trusted pull_request_target closed-event workflow removes only that PR tag and unserved preview revisions. Privileged jobs run only main-branch tooling and never execute PR code.

Tech stack: existing JavaScript ESM tooling, pinned Node and Next.js Docker build, GitHub Actions and keyless Google workload identity federation.

## Constraints

- Project unmask-513319, region asia-south1; a separate unmask-web-preview service, preview Artifact Registry repository, preview runtime/deploy identities and separate WIF pool.
- Preview runtime has zero IAM roles, no provider secrets, request-based CPU, 512Mi memory and min 0/max 1. It calls the existing public API.
- Automatic deployment is restricted to the base repository and two explicitly pinned contributor forks; all builds receive no deployment credentials. Unknown forks are skipped.
- Preview tags are pr-N; production service and production WIF identities cannot be modified by preview credentials.
- Every deployment rechecks open PR and exact current head, binds image/version/commit and reports the observed HTTPS tag URL in the workflow summary and deployment output.
- Serialize preview mutations across workflows. Never promote preview revisions to normal production traffic.
- No version bump or npm publication is required for preview builds.

## Tasks and verification

- [x] Add build, trusted deployment and closed-PR cleanup workflows with pinned actions and least permissions. Test rejection of forks, failed runs, mismatched runs/PRs and stale heads.
- [x] Add trusted JavaScript preview controller and tests for artifact bounds, regular files, image identity, safe command arguments, exact tagged URL observation, preserved unrelated tags, closed-PR cleanup and no production mutations.
- [ ] Bootstrap isolated GCP resources and verify scoped IAM/WIF bindings without exposing credentials. Exercise a real frontend PR preview, verify its exact head through /version and normal site route, and verify cleanup on the matching closed test PR.

Readiness requires the actual preview URL and cleanup evidence. Unit tests and a prepared workflow alone do not establish deployed previews.

## Implemented contract

Three workflows separate untrusted builds from privileged operations:

- [`web-preview-build.yml`](../.github/workflows/web-preview-build.yml) checks out the exact PR head and builds `web/Dockerfile` for `linux/amd64`. The root package version and exact head become image labels/build arguments. It uploads `image.tar`, `preview.json` and `SHA256SUMS` under a run-and-attempt-specific artifact name, retained for one day. Build permissions are only `contents: read`; it receives no deployment secrets, cloud credentials or OIDC permission.
- [`web-preview-deploy.yml`](../.github/workflows/web-preview-deploy.yml) runs on a successful build completion, checks out **main tooling only**, validates the build workflow/run/repository through GitHub REST, and downloads the exact artifact ID from that run. Fork workflow-run events can omit PR associations: bounded artifact metadata supplies a PR number, which trusted REST queries bind to the current open PR, exact head SHA and pinned head repository identity. It independently reads the version from that exact head's root package JSON. PR artifacts are data; privileged jobs never run their scripts or containers. Docker load/inspection occurs before cloud authentication.
- [`web-preview-cleanup.yml`](../.github/workflows/web-preview-cleanup.yml) uses only the closed `pull_request_target` event and main tooling. It rechecks that the PR remains closed, removes only `pr-N`, and deletes only revisions with that PR's name prefix, ownership labels, dedicated runtime identity and preview image namespace that have neither baseline traffic nor any remaining tag. Unrelated tags and fixed baseline traffic are compared before and after every mutation.

The [preview controller](../scripts/web-preview.mjs) fails closed on failed/wrong runs, wrong workflows, unknown repositories, stale/reopened heads, expired/ambiguous artifacts, extra/nonregular/hard-linked files, checksum mismatches, unsafe TAR headers, unexpected image IDs/platform/labels, runtime configuration drift and serving-identity mismatches. The Docker save archive is capped at 1 GiB and 20,000 top-level entries; metadata at 16 KiB. Classic config-digest saves and containerd OCI-index saves are supported. The latter must bind the exact index digest through one Linux AMD64 runtime manifest to the Docker manifest config and layer hashes; optional attestation descriptors are not treated as verified provenance. At most 128 JSON descriptors of 16 KiB each are retained. Image platform and release labels are checked again after load. GitHub/Cloud Run observations are bounded. Docker commands use argument arrays, never shell interpolation of PR data. The deployment is an immutable preview-GAR digest tagged `pr-N` on a new zero-traffic revision; the observed tag URL must return the exact head/version at `/version` and HTTP 200 at `/`. Only then is the URL written to the job summary and GitHub `preview` environment.

Builds use per-PR cancellation of superseded builds. Both privileged workflows share the global `web-preview-mutations` concurrency group, `queue: max`, `cancel-in-progress: false`. They recheck PR state/head immediately before remote push/service mutation or deletion. This serializes these workflows; changes outside them can still cause a fail-closed routing check. Preview revisions use the public production API when a reviewer submits a check; this preview workflow itself only reads the website home/version and submits no package/model request.

### Pinned repository identities

| Head repository     | Repository ID | Owner ID  |
| ------------------- | ------------- | --------- |
| Vaiditya2207/unmask | 1440901935    | 145288107 |
| Pranay0083/unmask   | 1441129169    | 149870314 |
| visheshrao17/unmask | 1441129131    | 151499332 |

Every PR must target `main` in base repository `Vaiditya2207/unmask` (ID 1440901935, owner 145288107). Fork names alone grant no authority. Changes to this allowlist require a reviewed main-branch change. Fork build execution may still require GitHub's normal contributor approval; this automation does not bypass it.

### Required isolated cloud configuration

| Setting                 | Exact value                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------ |
| Project / region        | `unmask-513319` / `asia-south1`                                                                  |
| Service                 | `unmask-web-preview` (must already exist with a ready, explicitly pinned 100% baseline revision) |
| Preview image namespace | `asia-south1-docker.pkg.dev/unmask-513319/unmask-preview/web`                                    |
| Runtime identity        | `unmask-web-preview@unmask-513319.iam.gserviceaccount.com`                                       |
| Deployment identity     | `unmask-preview-deploy@unmask-513319.iam.gserviceaccount.com`                                    |
| WIF provider            | `projects/386156642190/locations/global/workloadIdentityPools/unmask-preview/providers/github`   |
| GitHub environment      | `preview`                                                                                        |
| Runtime environment     | Only `UNMASK_API_URL=https://unmask-386156642190.asia-south1.run.app`                            |
| Runtime limits          | 1 CPU, 512 MiB, request-based CPU, min 0, max 1, no secrets/volumes or runtime IAM roles         |

The separate WIF pool must require the base repository/owner numeric IDs, main ref, `preview` environment and exactly `web-preview-deploy.yml` with `workflow_run` or `web-preview-cleanup.yml` with `pull_request_target`. The deployer needs Cloud Run developer permissions scoped to this service, Artifact Registry writer scoped to `unmask-preview`, and actAs only the preview runtime identity. It must have no production-service, production-registry or project-wide deployment authority. No account keys or new GitHub secrets are required. Cloud bootstrap, scoped IAM verification and real workflow execution are separate authorized operations, not performed by this code change.

Action pins were checked against their public tags: [upload-artifact v6](https://github.com/actions/upload-artifact/tree/b7c566a772e6b6bfb58ed0dc250532a479d7789f), [download-artifact v7](https://github.com/actions/download-artifact/tree/37930b1c2abaa49bbe596cd826c3c89aef350131). Existing checkout/setup-node/auth/setup-gcloud pins and gcloud 591.0.0 are retained.

### Acceptance boundary and retention

Local injected tests establish trust checks, artifact handling, command targets, baseline/tag preservation, stale-head refusal and cleanup selection. They do not establish a live preview. A real allowed frontend PR must build through these workflows, expose its exact version/head and normal home at the observed tag URL, and lose its tag/owned unserved revisions after that same PR closes before preview readiness is claimed. Runtime evidence must identify the candidate commit, workflow runs, URL and cleanup outcome.

Build artifacts expire after one day. Closing a PR removes its tag and eligible owned revisions, not the shared service or GAR images. Cloud Run forbids deleting its latest created revision, so cleanup retains that revision without a tag or baseline traffic and with min instances zero. Untagged older revisions and preview-GAR images are not automatically garbage-collected by every build; repository retention and cost monitoring remain separate operations. Failed smoke checks leave a zero-baseline-traffic candidate and fail the workflow; a successful replacement or close event controls the tag lifecycle. Branches with merge conflicts may not receive GitHub `pull_request` build events. Unknown forks require an explicit allowlist change rather than credential escalation.

### Automatic PR message

After the deploy step has observed the exact preview version/head and home response, the trusted deploy workflow runs a separate `comment` step. It publishes one marked `github-actions[bot]` PR comment containing the clickable preview URL, complete tested head SHA, version and deployment Actions run link. The stable marker is `<!-- unmask:web-preview:v1 -->`. Rebuilds update only that bot's marked comment; human comments, other bots and unrelated bot comments are left alone. An identical message needs no write.

Only the trusted deploy job has `pull-requests: write`; builds remain read-only and cleanup does not gain comment permissions. Publication uses main-branch tooling and the locally saved verified deployment receipt, rechecks the current open same-base/allowlisted-head PR and exact tested SHA, and accepts only its own `pr-N` tag on the dedicated preview service. Comment lookup stops after five pages of 100 comments; overflow, ambiguous marked comments or changed ownership fail closed without another message.

Comment publication is distinct from deployment verification. Its status is reported in step outputs and the job summary; publication failure or uncertainty fails that separate step while preserving the already verified deployment URL and receipt. POST/PATCH requests are never automatically retried, including a lost response after a possible successful write. A later workflow invocation first reads the marked comments again. No raw GitHub error body is printed. Closing the PR removes the preview tag through the existing cleanup workflow; comment retirement is not part of this increment.
