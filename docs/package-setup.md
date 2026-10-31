# Package setup

The package identity is **`@xagents_in/unmask`**, in the personal npm scope
`@xagents_in`. An npm organization or placeholder package is not needed for this
setup. The source repository is
[Vaiditya2207/unmask](https://github.com/Vaiditya2207/unmask).

The current source candidate is public version `0.1.1`, with npm registry
`https://registry.npmjs.org/` and public access. Release `0.1.0` was published and
verified; `0.1.1` publication and deployment acceptance remain pending.
`release.config.json` enables versioned releases and npm publication through the
CI checks and exact-artifact contract. See the dated [deployment evidence](README.md)
for runtime versions and commits. Authentication remains outside the repository;
no placeholder package is needed.

For a product release, CI must check the exact candidate commit and pinned
dependencies, build one npm tarball, test that installed tarball, and build the
deployment image from those same tarball bytes. The versioned release manifest
binds the package version, source commit, tarball hashes, and image digest;
deployment selects that exact digest. Attaching a tarball to a GitHub release
is separate from publishing it to npm. See the [release contract](releases.md)
for the remaining gates and runtime verification requirements.
