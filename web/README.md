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

Bricolage Grotesque and IBM Plex Mono are bundled in `public/fonts/` and served
from this site, so builds need no network access. See
[the font notes](public/fonts/README.md) before changing them.

## The analyzer connection

Set `UNMASK_API_URL` to the origin of the analysis server (`src/server`). The
site then forwards `POST /check` to `${UNMASK_API_URL}/check`, follows its `303`
to `/r/<id>`, and reads `${UNMASK_API_URL}/r/<id>.json`:

- While a check is queued, running, incomplete or failed, that JSON is the job,
  and this site shows its status, refreshing every three seconds while active.
- Once it completes, that JSON is the server's schema 1 report, which the
  viewer renders in full (`lib/report.ts` builds the view from it).

Without `UNMASK_API_URL`, `/check` returns to the form with a notice, and only
the example reports exist.

## What is real and what is illustrative

- **Live:** the release lookup on the home page reads
  `registry.npmjs.org/<name>/<version>` (the version manifest only; nothing is
  downloaded or run). Without script, the same form works through
  `/?release=<name>@<version>`.
- **Example reports:** `/r/sample` (esbuild@0.28.2) and `/r/sample-no-source`
  (left-pad@1.0.0) are real schema 1 reports produced by the analysis server
  with the model off, stored in `lib/examples/`. Maintainer and publisher email
  addresses in their manifests are replaced with `redacted@example.invalid`;
  nothing else is changed. `npm test` checks the view built from them.
- **Hero strip (illustrative):** the code in the hero is the real CommonJS
  build of clsx@2.1.1 followed by an appended block that no source contains. It
  names no package and is defined in `lib/content.ts`.
- **Pipeline bar:** the byte amounts are what one real check of esbuild@0.28.2
  read, from the server's run observations.
- **Incident list:** the five incidents link to public write-ups and advisories.
- **Server behaviour described in copy:** the 30-minute report retention, the
  limit of six new checks per ten minutes and the Google disclosure follow
  `docs/website.md` and `src/server`; they are enforced by the server, not here.
