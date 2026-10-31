# Diagnose a CLI installation

Run with Node 24.22.2 from a directory containing no project guard configuration:

```sh
node src/cli/main.mjs doctor --offline --json
```

The generated `offline.json` is actual diagnostic output from this command. It
contains no environment values or credentials. `--offline` skips the service;
without it, doctor makes a bounded GET to the fixed hosted service `/version`.
`--server-url https://service.example` explicitly selects another origin, and
loopback HTTP is supported for local tests. Credentials, paths, queries and
fragments in the origin are rejected. No package analysis or model is invoked.

`--project DIR` selects the project `.unmask.json` configuration location. When
the guard configuration module is installed, doctor uses its full safe schema
inspector. A standalone diagnostic build checks bounded JSON and the profile,
labeling full validation unknown. Doctor reports missing or malformed config,
but active shell interception remains unknown: a
child process cannot prove which function the invoking shell uses. Diagnostics
do not assess whether a package is safe. Exit 0 means no diagnostic errors;
warnings, unknown checks and explicit skips remain visible. Exit 1 means a
failed check; exit 2 means invalid CLI arguments.
