# UNMASK website

The Next.js website and report viewer. It follows the HTTP contract described on
the `feat/website-foundation` branch: `POST /check` takes an exact release, and
`/r/<id>` shows the job status or the finished report.

## Run it

Use Node.js 24.22.2 (see the repository `.nvmrc`):

```bash
cd web
npm ci --ignore-scripts
npm run dev        # http://localhost:3000
npm test           # sample-report and registry-parsing checks
npm run typecheck
npm run build && npm start
```

`next/font` downloads Libre Franklin, Source Serif 4 and JetBrains Mono from
Google Fonts at build time and serves them from this site.

## The analyzer connection

Set `UNMASK_API_URL` to the origin of the analysis server (`src/server`). The
site then forwards `POST /check` to `${UNMASK_API_URL}/check`, follows its `303`
to `/r/<id>`, and reads `${UNMASK_API_URL}/r/<id>.json`:

- While a check is queued, running, incomplete or failed, that JSON is the job
  (`Job` in `lib/analyzer.ts`), and this site shows its status, refreshing every
  three seconds while it is active.
- Once it completes, that JSON is the analyzer's schema 1 report. This site
  links to the analyzer's own report page and the JSON; rendering schema 1 in
  this viewer (mapping it onto `Report` in `lib/report.ts`) is not done yet.

Without `UNMASK_API_URL`, `/check` returns to the form with a notice, and only
the sample report exists.

## What is real and what is sample

- **Live:** the release lookup on the home page reads
  `registry.npmjs.org/<name>/<version>` (the version manifest only; nothing is
  downloaded or run). Without script, the same form works through
  `/?release=<name>@<version>`.
- **Sample:** `/r/sample` and the fragments on the home page use the viewer's
  own `Report` shape. File lists,
  sizes and SHA-256 hashes are computed from the real `clsx@2.1.1` tarball and
  its source at gitHead `925494c`. One synthetic change (152 bytes appended to
  `dist/clsx.js`) was added to show a finding. The explanations and the model
  hypothesis are written by hand; this site never calls the model.
  `npm test` checks that the sample's hashes and totals agree.
- **Incident list:** the five incidents link to public write-ups and advisories.
- **Server behavior described in copy:** the 30-minute report retention, the
  limit of six new checks per ten minutes and the Google disclosure follow
  `docs/website.md` and `src/server`; they are enforced by the server, not here.
