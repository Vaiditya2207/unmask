# UNMASK

See what actually shipped.

UNMASK is a planned package integrity analyzer for **Problem 04: Published
Package vs Source Code Integrity Analyzer** at Hacktoberfest 2026, Hack Day
Sonipat. Team **Cappybara** will compare published packages with their source
repositories and explain differences using inspectable evidence.

## Current status

This repository contains the development scaffold. The analyzer, model
integration, and user interface will be implemented in subsequent pull requests.
The first target ecosystem is npm JavaScript packages. The website and report
viewer are a Next.js app in [`web/`](web/README.md); the analyzer stack has not
been selected.

See [HACKATHON.md](HACKATHON.md) for team details and the planned model.

## Repository layout

```text
.github/
  pull_request_template.md   Required hackathon PR sections
  workflows/ci.yml           Checks on PRs and main
docs/                       Technical documentation
examples/                   Guidance for future inputs and outputs
src/                        Application source, to be added
tests/                      Application tests, to be added
web/                        Next.js website and report viewer
CONTRIBUTING.md              Branch, review, and testing workflow
HACKATHON.md                 Team and problem statement
LICENSE                     MIT license
package.json                Repository tooling commands
package-lock.json           Pinned tooling dependencies
```

## Local setup

Use Node.js 24.22.2 (pinned in `.nvmrc`) and npm, then run from the repository root:

```bash
npm ci --ignore-scripts
npm run check
npm test
npm run check:package
```

To format changed documentation and configuration:

```bash
npm run format
```

CI checks formatting, release-policy behavior and actual npm archive contents.
These are tooling tests; the product has no analyzer/server tests yet. Releases
remain disabled until real CLI, website, server and Docker artifacts exist.
See [CI, releases and manual deployment](docs/releases.md) for versioned release
requirements and selecting an immutable image in DigitalOcean App Platform.

## Contributing

Work on a feature branch and open a pull request against `main`. Follow
[CONTRIBUTING.md](CONTRIBUTING.md) and complete all four sections of the PR
template. Wait for passing CI and approval from a designated reviewer other than the
author before merging. The designated group and repository enforcement setup
are pending; see the contribution guide. See the contribution guide for the distinction between this
workflow and configured required status checks.

## License

[MIT](LICENSE).
