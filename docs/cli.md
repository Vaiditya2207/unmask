# CLI configuration and data flow

Public `check name@exact-version` runs through the hosted UNMASK service. It sends
only the package spec, not local files, environment values or a provider key. The
service owns registry/source acquisition and any advisory model processing under
its published model/data disclosure. Read that service's disclosure before use.

No deployed default URL is configured in this candidate. Before publication, the
release owner must configure the actual deployed HTTPS origin and repeat the
installed-package and normal deployed-route checks. Until then, set
`UNMASK_SERVER_URL` explicitly; do not infer a live domain from these examples.

```bash
UNMASK_SERVER_URL="$YOUR_UNMASK_HTTPS_ORIGIN" unmask check package-name@1.2.3 --out OUTPUT
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
