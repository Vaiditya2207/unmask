# UNMASK PM scope addendum: npm package, hosted website, versioned releases, deploy portal

> **Working record, 31 Oct – 1 Nov 2026.** Kept as written during the hackathon, except that private identifiers were removed for publication. Statuses describe the moment of writing; the [product docs index](README.md#then-and-now) shows what shipped since.

Written 31 Oct 2026, 20:49 IST, by UNMASK PM.

Trigger: UNMASK EM relayed a user material update (#92076). This addendum supersedes the "hosted website = reject" and "npm publish = stretch" lines in `pm-product-recommendation.md`. Everything else in that memo stands.

These are decisions and risks, not new research. Items marked **[verify]** still need checking.

## Relayed scope (as received from EM; not seen directly from the user)

- The npm package is core.
- A hosted website for checking packages is core.
- CI creates correct, versioned releases.
- A deployment portal lets an operator pick a release number and deploy that exact artifact.
- DigitalOcean credits are available. EM's note says "5 credits"; the amount is ambiguous.
- A hosted Gemma model via the free Google API is proposed, so there's no local runtime.

## D1. One core, three surfaces

- **One analysis library.** The npm package `@<scope>/unmask` exports `analyze()` and ships the `unmask` CLI bin.
- **The website server imports that same library at the same version.** It has no website-only analysis logic.
- **One report renderer.** The website result page is the same `renderReport()` HTML that the CLI writes to disk.
- **Same deterministic output.** For a given input, the CLI and the website must produce byte-identical deterministic report sections. This is a cheap, strong acceptance test and a demo beat.
- **Every surface states its version.** The website footer and `GET /version` show the package version, git commit and container image digest. Each report records the analyzer version that produced it.

## D2. Hosted untrusted-input boundary (the main new risk)

Inputs the website accepts:

- `name@version`. The server fetches only from registry.npmjs.org and codeload.github.com, via the same parser as the CLI (v7).
- An uploaded `.tgz` plus a claimed identity.
- **It never accepts arbitrary URLs.** That rules out SSRF by construction.

Hosted limits, stricter than the CLI:

- Upload cap of about 10 MiB compressed (**[decide]** the exact number). The v7 expanded, entry and ratio caps still apply.
- One analysis worker process with a hard timeout and memory cap, plus a small bounded queue. Overflow gets an HTTP 429 with a retry hint.
- Per-IP rate limit. A global daily cap on model calls protects the free API quota.
- Nothing from the package is ever installed, run or built. This is the same rule as the CLI.

Storage and privacy:

- Uploads are held in memory or in a temp file deleted after analysis.
- Reports are kept briefly (**[decide]** for example 24 h) under an unguessable ID. There is no public listing of other people's reports.
- The upload page states that uploads are processed on our server. No accounts in core.

**Uploads and the model:**

- Uploaded tarballs may be private code, and model snippets would go to Google.
- **Default:** send snippets to the hosted model only for public registry inputs, or for uploads where the user ticks an explicit "send excerpts to Google's API" box. Otherwise that report records model status `not-sent (privacy)`.
- **[verify]** whether free-tier Gemini API terms allow Google to use submitted content. If they do, the checkbox is mandatory.

Report and viewer safety:

- The report page uses the v7 viewer escaping, a strict CSP and no remote loads.
- Package text never becomes HTML or a script.

Abuse posture:

- A visible kill switch in an environment variable disables uploads and keeps name@version checks working.
- Logs hold only digests and claimed identities, never file contents.

## D3. Hosted model (Gemma via Google API)

- **The model is Gemma** (open-weight) served through Google's API. That still meets "open-weight model doing meaningful work", but the report must name the exact hosted model ID and the provider. **[verify]** which Gemma IDs the API exposes, and their free-tier RPM/RPD limits. EM is doing this.
- **The v7 model gate still applies:** 5 fixed cases, schema and citation checks. Latency and rate limits are now the main risk, replacing local RAM.
- **API key handling:** the key lives only in the DigitalOcean app's encrypted environment and in a GitHub Actions secret, if CI needs one at all. It never goes in the repo, the logs, the reports or the npm package.
- **The CLI needs a model too.** Recommended: the CLI reads `UNMASK_MODEL_*` environment settings for the same hosted API (the user brings their own key), with an optional local Ollama setting. Without a key, the CLI runs model-off and says so. The local runtime becomes optional, not core.
- **If quota is exhausted,** the report shows the model as unavailable. Demo packages may use cached model output, labelled as replay with matching hashes, as v7 already requires.

## D4. npm package and CI versioned releases (minimum)

**Package name:** an unscoped `unmask` is likely taken (**[verify]**). Use a scope such as `@vaiditya2207/unmask` or `@cappybara/unmask`. **[decide]** which, owned by the user's npm account.

**The version lives in one place:** `package.json`. A release happens only from `main` through a reviewed PR that bumps the version.

Release workflow, triggered by a protected tag `vX.Y.Z` pushed from `main`:

1. CI checks that the tag equals the `package.json` version, then runs the full test suite and `npm run check`.
2. `npm publish --provenance --access public` via npm trusted publishing (GitHub OIDC). No long-lived npm token, if the user configures trusted publishing. **[decide]**
3. Build the website container from the same commit. Push it to DigitalOcean Container Registry tagged `X.Y.Z`, and record its **digest**.
4. Create a GitHub Release `vX.Y.Z` holding the commit SHA, the npm tarball sha512, the image digest and the changelog.

Rules:

- Tags are immutable and are never re-pushed. A failed release means bumping to the next patch.
- Pre-releases use `X.Y.Z-rc.N` with the npm dist-tag `next`.

**Dogfood demo beat:** UNMASK checks its own published npm release. It should show provenance pointing to our CI commit, with every file byte-identical or explained. If that holds, it is strong proof the release chain works; it is not a safety claim.

## D5. Deployment portal: minimum vs. unknown existing portal

The user's "deployment portal" is ambiguous. **[decide, user-only]** Is there an existing portal we must integrate with, or do we build the minimum?

**Recommended minimum (core):**

- A GitHub Actions `deploy` workflow with `workflow_dispatch`. The operator picks a version from an input or choice list of released tags.
- The workflow looks up that GitHub Release's recorded image digest and updates the DigitalOcean App Platform spec (or the droplet) to **that exact digest**, never `:latest`.
- It then polls `GET /version` until the live commit and digest match, and fails otherwise.
- **Rollback** means running the same workflow with an older version.
- **Auth:** GitHub permissions plus a GitHub Environment with required reviewers.
- **Deploy token:** the DigitalOcean token lives only in that Environment's secrets.

**Read-only status page (core, cheap):**

- An operator page at `/ops` that shows the deployed version, commit, digest and deploy time, plus a release list read from GitHub Releases.
- It links to the deploy workflow but holds **no deploy credentials**.

**Stretch:**

- A custom portal UI that triggers deploys itself.
- Avoid this for the hackathon: it puts DigitalOcean credentials behind our own auth on a public host, which is a high-value target.

## D6. DigitalOcean shape

- **Simplest option:** App Platform, one basic container service deployed from DigitalOcean Container Registry by digest, plus the free DOCR starter tier.
- **Alternative:** a droplet with a container runtime. It's cheaper but needs more ops work.
- **[decide]** These need the user: which DigitalOcean account or team, the actual credit amount, the region, a domain or the default app URL, and who holds the DigitalOcean API token.

## D7. Updated cut order (time is now 20:49 IST; freeze 06:30)

**Protected core:**

- the shared analysis core
- the CLI with local tarball input
- the hosted website (name@version, upload and report page)
- the hosted model gate
- npm publish via the release workflow
- the deploy-by-version workflow with `/version` check
- compact eval
- honest demo

**Cut first:**

- PyPI
- watch feed
- PR-bump Action
- custom portal UI
- transform stage
- full Sigstore verification
- parsed-provenance parser (label it not-assessed)
- visual polish

**Lane impact:** the C lane (viewer) now owns the web server and the upload page too, since the report renderer is shared. A release/deploy owner is needed: either an E lane, or the B lane after its core work stabilises.

## D8. Updated three-minute demo

1. **Website:** check a real pinned release by name. Show byte-identical correspondence, byte-first coverage and the version footer.
2. **Website:** upload the tampered local copy. Show the localized evidence, the live model hypothesis (or replay, labelled), and the exit-policy reason. Use the v7 wording: name whether exit 3 comes from the digest or from the lifecycle rule.
3. **CLI** on the same tampered file. Same deterministic report hash as the website.
4. **Release chain:** in the portal, pick `v0.1.1`. The deploy workflow deploys that exact digest, and `/version` matches. Then UNMASK checks its own npm release.
5. **Limit:** source-matching is not safe (keyv), and the generated bundle stays unresolved.

This is about 3.5 minutes of material. Trim step 5 to one sentence, or drop beat 3 from the earlier plan, if time is short.

## Top risks

1. **Scope:** five new deliverables arrive with about 9.5 hours left. Mitigation: keep the portal to a workflow plus a status page, and keep the website a thin shell over the core.
2. **Hosted untrusted uploads:** resource exhaustion and parser bugs on a public server. Mitigation: caps, a single worker, a queue, rate limits, a kill switch, and never executing anything.
3. **Free API quota, latency or terms** during judging, and the privacy of uploaded code. Mitigation: daily cap, cached labelled replay, privacy opt-in.
4. **Credentials:** npm publish rights, the DigitalOcean token and the Google key. These sit only in GitHub Environment or DigitalOcean secrets, with trusted publishing preferred.
5. **Release correctness:** the tag/version mismatch check, digest pinning and immutable tags. A wrong-version deploy would undermine the integrity story.
6. **Public website wording:** a public "package checker" may be read as giving safety verdicts. Every page must say it shows evidence for review and never declares a package safe.

## User-only decisions

1. npm scope and account. Configure trusted publishing, or provide a granular token?
2. DigitalOcean account/team, real credit amount, region, domain, and who holds the token.
3. Google API key owner, and acceptance of the free-tier terms. May uploaded tarball excerpts be sent to Google?
4. Is there an existing deployment portal to integrate with? If not, is the GitHub-workflow minimum acceptable?
5. Should the website be public, or limited to judges and the team (basic auth or an unlisted URL)?
6. The upload size cap and how long reports are kept.
