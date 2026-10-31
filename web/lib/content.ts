// Public npm incidents where the published code was not in the project's repository.
export const incidents = [
  {
    name: "flatmap-stream 0.1.1",
    year: 2018,
    href: "https://tag-security.cncf.io/community/catalog/compromises/2018/event_stream/",
    what: "Payload only in the minified file on npm",
  },
  {
    name: "eslint-scope 3.7.2",
    year: 2018,
    href: "https://eslint.org/blog/2018/07/postmortem-for-malicious-package-publishes",
    what: "postinstall that sent .npmrc tokens away",
  },
  {
    name: "ua-parser-js 0.7.29",
    year: 2021,
    href: "https://github.com/advisories/GHSA-pjwm-rvh2-c87w",
    what: "Published from a hijacked account",
  },
  {
    name: "chalk and debug",
    year: 2025,
    href: "https://cycode.com/blog/npm-debug-chalk-supply-chain-attack-the-complete-guide/",
    what: "18 packages republished after a phish",
  },
  {
    name: "@ctrl/tinycolor 4.1.1",
    year: 2025,
    href: "https://truesec.com/hub/blog/500-npm-packages-compromised-in-ongoing-supply-chain-attack-shai-hulud",
    what: "bundle.js added by the Shai-Hulud worm",
  },
] as const;

export const questions = [
  {
    q: "Does UNMASK say a package is safe?",
    a: "No. It shows what differs and the evidence for each difference. A release whose bytes all match its source can still do harm, so the report never ends in a verdict of safe.",
  },
  {
    q: "Does it run the package?",
    a: "No. The tarball is read as files. Install scripts, build scripts and tests are never executed; a build is explained by reading the script that produces it.",
  },
  {
    q: "Which releases can it check?",
    a: "Public npm packages at an exact version, such as clsx@2.1.1. Tags, version ranges, URLs and uploaded files are not accepted.",
  },
  {
    q: "Where does the source come from?",
    a: "From the repository and the commit the registry records for the release (its gitHead). When no commit is recorded, the report says which source it used and marks the match uncertain.",
  },
  {
    q: "What does the model do?",
    a: "Gemma (gemma4:e4b) will propose explanations for transformed code. Each one is a hypothesis: a program checks every byte it cites before it is shown. The model is planned and not connected yet.",
  },
  {
    q: "How long is a report kept?",
    a: "Up to 24 hours, and a restart loses it. Download the JSON to keep the evidence. Checks of the same release reuse one report.",
  },
] as const;

export const team = [
  "Pranay Vishwakarma",
  "Vaiditya Tanwar",
  "Vishesh Rao",
  "Sayan Bhattacharya",
] as const;

export const repositoryHref = "https://github.com/Pranay0083/unmask";
