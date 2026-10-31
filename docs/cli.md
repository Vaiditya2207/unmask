# CLI configuration and data flow

Public `check name@exact-version` runs through the hosted UNMASK service. It sends
only the package spec, not local files, environment values or a provider key. The
service owns registry/source acquisition and any advisory model processing under
its published model/data disclosure. Read that service's disclosure before use.

The default service origin is
`https://unmask-386156642190.asia-south1.run.app`. Set `UNMASK_SERVER_URL` to
select a self-hosted service instead. This release configuration does not establish
public access, model usefulness or final installed-artifact acceptance; the release
owner verifies those through the deployed normal route before merging/releasing.

```bash
unmask check package-name@1.2.3 --out OUTPUT
UNMASK_SERVER_URL=http://127.0.0.1:3000 unmask check package-name@1.2.3 --out OUTPUT
```

The override must be a bare HTTPS origin; HTTP is accepted only for `localhost`,
`127.0.0.1` or `[::1]` local testing. Credentials, paths, queries and fragments are
rejected. Submission is one form `POST /check`, followed by same-origin
`GET /r/ID.json` polling. The client sends no cookies or Authorization header and
never follows a transport redirect. The POST's 303 Location must identify a
same-origin report. Hosted failure is visible; there is no local fallback.

Hosted mode requires `--out`; `--cache-dir` is optional and unused. It validates
the returned schema, requested name/version and policy against deterministic
report evidence before creating `report.json` and escaped `report.html`. Writes
are exclusive: existing report files are preserved. Exit codes are `0` completed,
`2` incomplete or request/configuration failure, `3` default policy finding, and
`1` internal error. A failed transport produces no completed report. Exit `0`
does not mean safe, and validation is not independent proof of hosted evidence.

Transport is bounded to 600 seconds total, covering up to 300 seconds queued plus
240 seconds executing with transport margin. Each request allows 15 seconds
including body reading, and each decoded JSON response is limited to 64 MiB.
Pending reports are polled every
three seconds. No automatic POST retry occurs; resubmitting after a failure is
an explicit new command. The service may reuse a completed report according to
its bounded cache policy, or expire/evict it earlier. Local output files are not a
service cache, and supplying `--cache-dir` does not make hosted results durable.

Local archives remain explicit offline inputs:

```bash
unmask check --tarball PACKAGE.tgz --offline --cache-dir CACHE --out OUTPUT
```

Offline mode keeps the existing archive/source options and requires both
`--cache-dir` and `--out`. It does no acquisition. Optional `--allow-model` applies
only to this local mode and permits selected evidence to leave the machine when
a local provider is configured. Without consent no local model client is built.
Hosted mode rejects `--allow-model`: its model policy belongs to the selected
service, and no local model configuration is read. Do not pass provider keys in
`UNMASK_SERVER_URL` or CLI arguments.

Localhost synthetic HTTP/CLI tests establish the adapter contract. They do not
establish deployed service availability, provider quotas or model usefulness.

## Preflight

`unmask preflight` compares exact npm lockfile identities (lockfileVersion 2
or 3) against a baseline lockfile and checks only the changed identities through
the hosted service. It reads both files and never runs git, installs or package
code.

```bash
git show origin/main:package-lock.json > /tmp/base-lock.json
unmask preflight --baseline /tmp/base-lock.json --lockfile package-lock.json --json
```

Options: `--lockfile FILE` (default `package-lock.json`), `--baseline FILE`
(required), `--max-checks N` (1-100, default 6 to match the hosted service's new
check limit, sequential), `--no-check` (diff only) and `--json`. A changed
identity is a new `name@version`, or an existing one whose recorded `resolved`
or `integrity` changed in any location, including removal of either field.
Lockfile parsing is shared with `unmask audit`: changed non-registry or
non-exact entries are listed under `coverage.unsupported`, and local workspaces
and links are not checked. A changed workspace entry that claims a `resolved` or
`integrity` artifact is listed as `workspace-artifact-claim`, as dependency
screening rejects it. A changed identity that is not bound (a
`registry.npmjs.org` tarball URL plus a sha512 integrity in every location) is
still checked by name and version, but counts under `coverage.unbound` and keeps
coverage incomplete, because the checked artifact is not tied to what npm will
install. The baseline itself is not audited; use `unmask audit` for that.

The `unmask-preflight-1` JSON document has `status`, `exitCode`, `changes`
(`added`, `removed`), per-identity `checks` (`completed` with policy exit and
finding rule IDs, `unavailable` with an error code, `not-checked` with reason, or
`cancelled`), a `cancelled` flag and `coverage` (`complete`, `required`,
`checked`, `unbound`, `unsupported`). A finding keeps status `findings` and exit
`3` even if a later check is cancelled.
Exit `3` means at least one checked change has a default-policy finding, `2`
means coverage is incomplete (unsupported, unbound, unavailable, limited, disabled or
hosted-incomplete checks) or the input is invalid, and `0` means every changed
identity was bound and checked with no default-policy finding. Exit `0` does not mean safe:
an advisory miss, a removed registry version or a hosted cache reuse can still
hide malware.

## Watch

`unmask watch` is an explicit, opt-in foreground watcher for one project
lockfile. It records the current valid lockfile as its baseline, then, after
changes settle for the debounce period, runs the same exact-identity preflight
against the last valid snapshot and prints each result. The baseline itself is
not audited; run `unmask audit` for it.

```bash
unmask watch --lockfile package-lock.json [--debounce-ms 750] [--max-checks 6] [--no-check] [--json]
```

Duplicate file events and byte-identical rewrites do not start a run. An
unreadable or invalid intermediate lockfile (for example a partial npm write) is
reported and no check is run; the last valid baseline is kept. Runs never
overlap: changes during a run are coalesced into one follow-up run. After each
run without a cancelled check its lockfile becomes the new baseline, so a finding is reported
once; rerun `unmask preflight` for a cumulative view. Ctrl-C cancels any
in-progress hosted check, reports that run as `cancelled` without a result, and
exits `130`. An unexpected run error is reported as `run-error`, claims no
result and keeps the baseline; watching continues. A watcher failure exits `2`. `--json` prints one JSON event per line.
Watch never installs packages or runs package code.
