# Engineering documentation

UNMASK compares the bytes in an npm package with a selected source archive and
presents differences as reviewable evidence. It does not certify package safety.

## Implementation status

These pages describe the design and locally implemented code in **pending
implementation branches**. The documentation branch starts from main revision
`2cbdbee16abf34864d0ef3a290fcea6e664c4672`, which contains repository tooling,
not an analyzer or running website. Module paths below describe the pending
layout; this documentation change does not add those modules to main.

The pending local implementation revision inspected for these pages is
`e847e386b323078eaf3859165241a767cdd5d0c7`. It is not yet public; the identifier
records local source review, not a publicly inspectable remote reference. That
review establishes the interfaces described here, not a successful deployment,
public npm publication, provider-backed model result, or production resource
guarantee.

The hosted model gate has not passed and no human usefulness review has taken place.

## Read the design

| Page                                              | Contents                                                                                       |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [Architecture](architecture.md)                   | User flows, process boundaries, components, data objects, sequences and job states             |
| [Contracts](contracts.md)                         | Inputs, archive and report shapes, exit codes, HTTP behavior and shared distribution           |
| [Stack and decisions](stack.md)                   | Pinned dependencies, implementation choices, resource limits and unresolved operational checks |
| [CI, releases and manual deployment](releases.md) | Existing scaffold release gates and the intended artifact/deployment workflow                  |

The release page describes the scaffold and future gates. The selected pending
package identity is now `@xagents_in/unmask`; identity selection does not establish
publication. Release and deployment prerequisites still require their own checks.

For repository setup and contribution rules, see the [project overview](../README.md)
and [contribution guide](../CONTRIBUTING.md). This branch changes documentation
only; its tooling checks do not execute the pending product implementation.
