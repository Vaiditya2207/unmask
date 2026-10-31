# Bundled interface fonts

These 23 WOFF2 files are the exact bytes previously emitted by the pinned Next.js 16.4.2 Google-font loader for this interface: Libre Franklin (400/500/600/700), Source Serif 4 (400/600, normal/italic) and JetBrains Mono (400/500). Their combined size is 531,464 bytes. No font was modified or substituted.

The [manifest](manifest.json) records the upstream CSS requests and font URLs, byte sizes and SHA-256 digests, three license sources/digests and all 59 existing face declarations. Each font filename is its full content SHA-256. The source snapshot's exact asset bytes were verified against the successful existing build before bundling. The upstream CSS endpoints are provenance, not build dependencies.

[The stylesheet](../../app/fonts.css) retains all 56 real face declarations, Unicode ranges and requested weights/styles, plus the three existing fallback metric faces and CSS variables. The layout preloads the same four Latin resources. A `subsets: ["latin"]` option previously selected preloads; it did not remove other scripts from the Google CSS. Those other subsets remain bundled.

This removes build-time Google Fonts requests and the pinned loader's assumption that every successful download URL ends in a font filename extension. All assets are served from this application's `/fonts/` path. Content-addressed WOFF2 URLs have immutable one-year cache headers. The Docker image explicitly copies `public/` into its runtime stage; no package or toolchain pins changed.

Each family retains its upstream copyright notice and SIL Open Font License 1.1: [Libre Franklin](librefranklin-OFL.txt), [Source Serif 4](sourceserif4-OFL.txt) and [JetBrains Mono](jetbrainsmono-OFL.txt). These font files remain under their included licenses, separate from the application's license.

`npm test` in `web/` validates every binary hash/header/size, the exact face properties, coverage, licenses and preload/packaging contract. To update fonts, obtain the intended upstream bytes, review their notices, update the hash-addressed files and provenance/face records together, and verify a fresh build without Google network access. Do not replace this with production font mocks or dependency-file patches.
