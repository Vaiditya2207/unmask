## UNMASK check: @unmask\-example/requested@1.0.0 \(claimed; artifact declares @unmask\-example/declared@2.0.0\)

| Item | Value |
| --- | --- |
| Exit code | 3 |
| Policy findings | 1 |
| Coverage complete | yes |
| Identity | claim\-conflicts\-with\-manifest |
| Advisory check | incomplete \(for requested identity\) |
| Results | 2 error, 0 warning, 5 note |
| Artifact sha256 | `8e3577c4e728d0fae8edc2dd8a02d20845d9f33d0379982a474f129e78183635` |

### Results

- **error** `policy/identity-claim-conflict`: Artifact manifest differs from the claimed identity in: name, version. \[artifact package.json bytes 0\-136\]
- **error** `advisory/known-malware`: GHSA\-0000\-0000\-0001 \(alias MAL\-0000\-0001\): Synthetic advisory whose only MAL id is an alias \(OSV exact\-version query for @unmask\-example/requested@1.0.0\).
- **note** `advisory/withdrawn`: MAL\-0000\-0002: Synthetic withdrawn malicious\-package advisory \(OSV exact\-version query for @unmask\-example/requested@1.0.0\).
- **note** `cue/manifest-artifact-runtime-observation`: Artifact declaration observed; source comparison is unavailable. \(field /dependencies\) \[artifact package.json bytes 0\-136\]
- **note** `cue/manifest-artifact-runtime-observation`: Artifact declaration observed; source comparison is unavailable. \(field /bundledDependencies\) \[artifact package.json bytes 0\-136\]
- **note** `cue/manifest-artifact-runtime-observation`: Artifact declaration observed; source comparison is unavailable. \(field /name\) \[artifact package.json bytes 0\-136\]
- **note** `cue/manifest-artifact-runtime-observation`: Artifact declaration observed; source comparison is unavailable. \(field /version\) \[artifact package.json bytes 0\-136\]

### Limitations

- warning: No source archive was compared; artifact files have no source correspondence.
- note: 4 of 4 artifact files are not byte\-identical to selected source \(4 not compared\).
- warning: OSV advisory check is incomplete \(page\-cap\); missing advisories do not mean none exist.
- warning: Advisories were queried for the requested identity @unmask\-example/requested@1.0.0, which conflicts with the artifact manifest @unmask\-example/declared@2.0.0; the declared identity was not screened.
- note: Absence of results does not establish that the package is safe; only recorded evidence, deterministic policy rules and the supplied advisory snapshot are reported.

