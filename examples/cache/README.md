# Manage local report snapshots

A completed `unmask check ... --out ./out` produces `out/report.json`. Cache
import explicitly copies that validated JSON report; it does not run a package,
submit a hosted check, or request a model. The checked-in `report.json` is a
synthetic incomplete report generated through the real report factory, with
`model.status: disabled`. It contains no real package or vulnerability claim.

From the repository root, use Node 24.22.2:

```sh
node src/cli/main.mjs cache import --report examples/cache/report.json
node src/cli/main.mjs cache inspect --json
node src/cli/main.mjs cache prune --older-than-days 0 --limit 1
node src/cli/main.mjs cache prune --older-than-days 0 --limit 1 --apply
```

Without `--cache-dir`, the base is `.unmask-cache` in the working directory.
`--cache-dir DIR` explicitly selects another base. Only its dedicated
`unmask-reports-v1` subdirectory, created privately with an ownership marker,
is managed. Existing unmarked directories are refused rather than adopted.
Input archive blobs, report output directories, hosted caches and other base
files are outside the deletion scope. Source report files are never deleted.

Each cached report is content-addressed JSON with its import time and ownership
metadata. Inspect lists exact package identity when valid, artifact SHA-256,
size, age and the recorded model status. Reimporting the same snapshot preserves
its original age. Cache contents are historical snapshots, not a fresh check.

Prune defaults to a preview. It requires an explicit age in whole days (0 through 36500) and a deletion limit (1 through 100). `--apply` enables deletion of at most
that many oldest eligible report files; no directories are recursively removed.
The complete bounded scan validates ownership, hashes and report schemas before
any deletion begins. Unrecognized files, corrupt reports, linked files, linked
ancestors, shared roots and malformed ownership markers cause refusal. Use a
canonical path on systems where `/tmp` or `/var` is a symlink. Concurrent UNMASK
writers use an exclusive lock; readers report `cache-busy` even while that
lock is still being initialized. A stale lock after a crash needs manual local
inspection. Errors for a valid hex-named corrupt or future-dated entry identify
that filename and suggest checking the local clock before retrying. Displayed
C1 and bidirectional controls are escaped; stored report data is preserved. A hostile process running as the same OS user can still race path
operations; this cache is not an isolation boundary against that user.

Cache capacity is 500 reports / 64 MiB total, with at most 16 MiB per entry.
Prune explicitly before importing beyond those limits. Future-dated entries
fail closed until the local clock catches up or the files are reviewed locally.
Exit 0 means the requested operation completed; exit 2 reports invalid input or
a refused operation. Deletion is bounded, but a filesystem error during apply
can leave some selected files deleted; inspect again after resolving the error.

`inspect.json` and `prune.json` were produced by the CLI from the supplied report
using a fixed test clock. Absolute root paths are replaced with `<CACHE_ROOT>`
for a portable example; all entry data and results are actual command output.
