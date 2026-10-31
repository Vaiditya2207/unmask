# Contributing to UNMASK

## Start a change

Keep changes focused and work on a branch from the latest `main`:

```bash
git switch main
git pull --ff-only origin main
git switch -c feat/short-description
```

Use `feat/short-description` for features and `fix/short-description` for fixes.
All changes after the initial `HACKATHON.md` commit must go through a pull
request. Do not push directly to `main` or rewrite its history.

## Check and push

Use Node.js 24.22.2, as pinned in `.nvmrc`. The `check` script checks formatting; `test` and `check:package` validate
release tooling and archive contents. They do not validate product behavior.

```bash
npm ci --ignore-scripts
npm run check
npm test
npm run check:package
git add path/to/changed-file
git commit -m "docs: describe the change"
git push -u origin HEAD
```

Use a commit message that describes the actual change. Run `npm run format`
when formatting needs correction, review the resulting diff, and run checks
again. Add and run meaningful tests when executable functionality is introduced.

## Code comments

Use at most one single-line comment per logical block of code. Prefer clear names
and small functions; keep longer explanations in documentation, not block comments.

## Open the pull request

On GitHub, choose **Pull requests → New pull request**. Set the base branch to
`main` and the compare branch to your feature branch. Complete the template:

1. **What this PR does** — explain the change and its purpose.
2. **Models the product uses in this PR** — identify models actually integrated
   by the change, or state `None`. Distinguish a planned model from a working
   integration.
3. **AI coding assistants that helped write it** — disclose the assistants used
   for this change, or state `None`, as required by the event.
4. **How we tested it** — list the commands, observed results, and any remaining
   gaps. Do not report an unexecuted check as passing.

Use a draft PR while work is incomplete. Request review from a teammate with
write access. Every team member must be able to explain the implementation.

## Review and merge

Wait for CI and a teammate's approval before merging. Repository protection is
configured on GitHub, not by these files; verify the current rules there. This
scaffold does not configure required status checks. After the workflow has run,
a maintainer should configure its `Repository checks` job as a required check.
Product tests must become part of CI when implementation begins. See
[release prerequisites](docs/releases.md) before enabling publication.

## Model and example changes

Update `HACKATHON.md`, the README, and the PR's model section whenever the product
model or runtime changes. Problem 04 requires meaningful open-source or
open-weight AI use; the local-only rule for Problem 08 does not apply to this
project.

For working features, include public sample inputs, actual generated outputs,
and a reproducible command under `examples/`. Follow its
[guidance](examples/README.md). Never fabricate findings or test output.

## Data and event requirements

- Use public data only. Keep credentials, local environment files, and downloaded
  model weights out of Git.
- Inspect untrusted package contents without executing them on a developer's
  machine. Any execution approach needs an explicit isolation design.
- Do not publish automated issues or comments on real open-source projects.
- Keep CI passing on the final submitted commit.
- Finish commits before **1 November 2026, 6:30 AM IST**.

## Restrict required approval to the designated reviewers

The designated reviewers are `@pranay0083`, `@visheshrao17`, and `@Vaiditya2207`.
One approval from this group is intended; a fourth reviewer can be added later.
`.github/CODEOWNERS` assigns the group to every file and to CODEOWNERS itself.
The CODEOWNERS file on the PR's base branch governs review
requests; adding it only on the proposed branch does not establish that policy.

A maintainer must separately configure the `main` ruleset to require a PR, at
least one code-owner approval from that group, dismissal of stale approvals,
resolved conversations and passing `Repository checks`, with no bypass actors.
Confirm repository permissions and that the chosen owners have write access.
CODEOWNERS alone does not enforce approval or prevent merging. This change adds
the file but does not change permissions or configure repository rules. At the
31 October check, both teammates had read access; they must receive and accept
Write access before GitHub can recognize them as code owners. The active main
ruleset required one approval but had code-owner review disabled, no required
status check, and an administrator PR bypass. Those settings must be updated
before claiming this reviewer restriction is enforced. Other users can still
submit reviews; their approvals cannot satisfy the required code-owner review.
