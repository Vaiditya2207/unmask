# Local release history example

This is a synthetic public-shaped registry snapshot for `example`, with three metadata records and a date-only release. It is not a live npm observation. No target code executes and no model runs. Requires Node 24.22.2 and `npm ci --ignore-scripts`. Base revision: `8cd9422cc3fbb37b763c4225c2e5e0914132e23e` plus this history feature commit.

From the repository root:

```sh
node examples/registry-history/run.mjs > examples/registry-history/output/history.json
```

The command starts the actual HTTP app on loopback with an injected registry fixture and requests its history route. The checked-in output was captured from this command. Source URL denotes the simulated acquisition target; retrieval time changes on rerun and the document hash covers the exact fixture bytes. The newest version demonstrates recorded publisher, license and engine changes. The absent middle version's metadata makes adjacent comparisons partial. No ownership transfer, safety verdict or historical metadata edit is inferred.
