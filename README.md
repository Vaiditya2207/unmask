# UNMASK

See what actually shipped.

UNMASK is a planned package integrity analyzer for **Problem 04: Published
Package vs Source Code Integrity Analyzer** at Hacktoberfest 2026, Hack Day
Sonipat. Team **Cappybara** will compare published packages with their source
repositories and explain differences using inspectable evidence.

## Current status

This repository contains the development scaffold. The analyzer, model
integration, and user interface will be implemented in subsequent pull requests.
The first target ecosystem is npm JavaScript packages. The application stack
has not been selected; Node.js currently runs repository formatting tools only.

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
```

To format changed documentation and configuration:

```bash
npm run format
```

The scaffold CI workflow installs the locked tooling dependency and checks
formatting of supported files. This is not semantic validation, product testing,
or proof that package analysis works. Product tests and runnable examples must
be added with the implementation.

## Contributing

Work on a feature branch and open a pull request against `main`. Follow
[CONTRIBUTING.md](CONTRIBUTING.md) and complete all four sections of the PR
template. Wait for passing CI and approval from a teammate other than the author
before merging. See the contribution guide for the distinction between this
workflow and configured required status checks.

## License

[MIT](LICENSE).
