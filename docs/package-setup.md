# Package setup

The package identity is **`@xagents_in/unmask`**, in the personal npm scope
`@xagents_in`. An npm organization or placeholder package is not needed for this
setup. The source repository is
[Vaiditya2207/unmask](https://github.com/Vaiditya2207/unmask).

This change records the intended identity only. The package stays at `0.0.0`
with `private: true`, and `release.config.json` keeps publishing disabled.
`approvedPackageName` identifies the intended package; it does not enable a
release or prove registry ownership. No placeholder is published or package
name reserved by this change. Account authentication stays outside the repo.

The repository currently contains tooling and a closed product release gate.
Product implementation and publication configuration belong in later changes.
JavaScript and the pinned Node.js 24.22.2 toolchain remain unchanged.

For a later product release, CI must check the exact candidate commit and pinned
dependencies, build one npm tarball, test that installed tarball, and build the
deployment image from those same tarball bytes. The versioned release manifest
binds the package version, source commit, tarball hashes, and image digest;
deployment selects that exact digest. Attaching a tarball to a GitHub release
is separate from publishing it to npm. See the [release contract](releases.md)
for the remaining gates and runtime verification requirements.
