# Automatic production deployment contract

User-authorized production deployment follows a completed release in the same
`release.yml` run. The deployment job depends on `publish`; it does not depend on
a second `release: published` event. GitHub suppresses many workflow-triggering
events produced by `GITHUB_TOKEN`, so that separate trigger is unsuitable here.

The npm route is commit `1ab5215`. This separate change adds verified release
outputs, the automatic production job, image-only Cloud Run runner and strict
HTTP/model acceptance checks. All local tests use synthetic providers; this change
has performed no cloud authentication, IAM mutation or deployment.

Root confirmed project `unmask-513319`, service `unmask` and Mumbai region
`asia-south1`. Root bootstraps the service with its runtime SA, secret-version refs
and intended model configuration. The workflow uses confirmed variables, derives
its URL from Cloud Run, and has no dummy live URL or model override.

## Completed release handoff

`publish` exposes `complete`, `npm_published`, `image`, `commit`, `version`,
`tarball_sha256` and `release_id` only after GitHub returns a published immutable
release and a second tag read confirms its commit. Npm publication is true only
when the exact prepared archive and downloaded public registry bytes were verified.
The image is the tested Linux AMD64 GHCR digest, never a floating tag or a rebuild.

The deployment policy requires the supplied GitHub repository and owner numeric
IDs, main push, exact release workflow ref and production environment. The WIF
provider must enforce these claims too. Application checks do not replace cloud
IAM enforcement. Current GitHub repositories can use an immutable OIDC subject
format, so do not assume a legacy name-based `sub` string.

## Production configuration and job

Root supplies the confirmed, non-secret production variables:

| Variable                         | Purpose                                                       |
| -------------------------------- | ------------------------------------------------------------- |
| `GCP_PROJECT_ID`                 | Confirmed deployment project ID                               |
| `GCP_REGION`                     | Mumbai region, `asia-south1`                                  |
| `GCP_SERVICE_ACCOUNT`            | Dedicated deployment SA email, distinct from runtime identity |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | Full WIF provider resource name                               |
| `GCP_CLOUD_RUN_SERVICE`          | Fixed workflow value `unmask`, confirmed by root              |

The workflow fixes the service name to `unmask`; the four GCP variables are
non-secret production configuration. Also set `CLOUD_RUN_SMOKE_PACKAGE` to the
exact validated public package and `CLOUD_RUN_MODEL_EXPECTATIONS` to a JSON
`{ "routes": [...] }` record. Root's current candidate is `zod@4.6.7`; live
eligibility is still unverified. Approved ordered routing is `gemini-3.5-flash` with high thinking, then
`gemini-3-flash-preview` minimal, then `gemma-4-26b-a4b-it` minimal; no `MODEL_ID`
is overridden. Model generations are bounded to three attempts/135 seconds by
the app; deployment HTTP smoke allows 240 seconds including acquisition.
Root supplies the actual successful model/configuration records after bootstrap.

Each route record contains only `provider`, `endpointHost`, `modelId`, `configHash`
and the full `generationConfig` projected from the successful report and checked
against the approved intended profile. Up to three ordered approved routes are supported. No API
key or raw model input belongs in that variable. Missing configuration fails a
validation step before WIF authentication. It is a runtime contract check, not an
additional approval prompt.

The initial service must already carry the intended runtime SA, Secret Manager
version references, model configuration and resource settings. Automated releases
update its image and route production traffic to the verified new revision.
They preserve runtime identity, environment, secret references, resource limits,
ports, commands, volumes and other runtime configuration. The policy requires
instance-based CPU, min/max one instance, one vCPU and 2Gi memory for async jobs.

The active `deploy` job is in `release.yml`, requires completed GitHub and npm
publication, runs in environment `production`, and alone receives
`id-token: write`. It checks out the exact release commit, installs locked tooling
without lifecycle scripts, validates references, authenticates through WIF and
runs the cloud runner. Google auth is pinned to
`7c6bc770dae815cd3e89ee6cdf493a5fab2cc093`; setup-gcloud is pinned to
`aa5489c8933f4cc7a4f7d45035b3b1440c9c10db`. Cloud SDK is fixed at `591.0.0`,
verified in Google's public rapid-channel component manifest.

Both Google action commits were verified against their official public `v3` refs
and exact `action.yml` files, which use Node 24. The GitHub API attempt was rate
limited; the successful verification used the public Git ref advertisement.
There is no JSON service-account key. The eventual auth step can create temporary
WIF credentials; exclude `gha-creds-*.json` from commits/artifacts and keep them
out of logs. Only the deploy job receives `id-token: write`.

The provider condition must restrict repository ID `1440901935`, owner ID
`145288107`, `refs/heads/main`, the exact main release workflow, and environment
`production`. Map claims before using them in IAM attribute conditions. Root
creates and verifies those bindings; this code does not provision cloud IAM.

## Verification required after mutation

The runner first verifies anonymous GHCR digest pull, then snapshots the service
configuration privately. It updates only the exact image with `--no-traffic`,
waits for that revision's ready digest and verifies preserved configuration before
routing production with `--to-latest`. A private first image fails before a Cloud
Run mutation; make it public and rerun the deploy job after verifying access.

Snapshot the service configuration privately before updating it. Compare a
canonical fingerprint afterward, excluding the selected image and documented
controller bookkeeping only. Keep raw service JSON out of logs because it may
contain environment values. The policy returns only a fingerprint and public
release identity.

After updating the image, inspect the actual revision, controller generation,
ready status and resolved digest. Confirm all production traffic points to that
revision and no old tagged/serving route remains. Derive the HTTPS origin from
Cloud Run's observed service URL. Compare `/version` version, commit and tarball
hash with the completed release. A Ready flag or image tag alone is insufficient.
Public GHCR images can be deployed directly by digest; an additional mirror is
optional. Root must make the first GHCR image publicly pullable before this path.

Run the normal form POST, poll persisted JSON, inspect rendered HTML and repeat
the JSON request through the actual service route. Root must supply an exact,
model-eligible public package and intended provider/model/configuration expectation.
The model-proof guard requires completed preflight/generation metadata, matching
model/config/prompt identity, nonempty hypotheses, known evidence citations and
exact quoted substrings. Transformation claims need paired artifact/source
citations. Disabled, not-sent, unavailable or empty model output fails AI-path
acceptance. Core-only smoke remains separate and cannot substitute for that test.

The pure guards and synthetic model records test acceptance logic; they are not
live cloud or model evidence. Even a verified model path does not establish general
Gemma quality. The runner rechecks serving state after smoke and saves only public proof to
`artifacts/deployment-receipt.json`, job outputs and the GitHub step summary:
release/digest, project/service/revision, serving URL, report URL and model trace
metadata. Provider bodies, service JSON and secrets are omitted.
Reports remain in memory and can be lost on restart or deployment. The Next.js
website is owned separately and is untouched by this work.

## Official references

- [Cloud Run supports public GHCR images](https://docs.cloud.google.com/run/docs/deploying#supported-container-registries-and-images)
- [Cloud Run image update command](https://docs.cloud.google.com/sdk/gcloud/reference/run/services/update)
- [Cloud Run revision readiness and resolved digest](https://docs.cloud.google.com/run/docs/reference/rest/v1/namespaces.revisions#RevisionStatus)
- [Google WIF numeric identity guidance](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines)
- [Google GitHub auth action](https://github.com/google-github-actions/auth)
- [GitHub OIDC claims and subject formats](https://docs.github.com/en/actions/concepts/security/openid-connect)
- [GitHub token event recursion behavior](https://docs.github.com/en/actions/how-tos/writing-workflows/choosing-when-your-workflow-runs/triggering-a-workflow)

The actual nonsecret GCP identities are committed in `deployment.config.json`.
No extra GitHub GCP variables are required. `modelExpectation` is deliberately
null pending root's actual successful three-tier report/configuration; root fills
that nonsecret record before enabling release. Validation fails clearly while it
is pending. Cloud Run liveness uses `/version`, since hosted paths ending in `z`
can be reserved by the Google frontend. An OCI index is hash-verified from public
GHCR bytes and resolved to exactly one Linux AMD64 child; the service template
pins the original index while serving verification checks the resolved child.
