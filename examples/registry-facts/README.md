# Local registry facts example

Input is deliberately synthetic public-shaped npm metadata for `example@1.2.3`, not a real package assessment. No package code executes, no npm request is sent and no model is called. Requires Node 24.22.2 and `npm ci --ignore-scripts`. Feature base revision: `0ccc70f534c2be0b2749e39ee1977935a4bfd277` plus this feature commit.

From the repository root:

```sh
node examples/registry-facts/run.mjs > examples/registry-facts/output/facts.json
```

This starts the actual app on loopback and requests its metadata API with an injected registry response. `output/facts.json` is captured output; retrieval time changes on rerun. The SHA-256 covers the exact input bytes. The npm source URL describes the fixture's simulated acquisition target, not a live registry retrieval. No safety verdict or verified publisher identity is produced.
