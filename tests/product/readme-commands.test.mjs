import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { commandCatalog } from "../../src/cli/discovery.mjs";

test("README command index lists exactly the commands available in this build", async () => {
  const readme = await readFile(
    new URL("../../README.md", import.meta.url),
    "utf8",
  );
  const section = readme.slice(
    readme.indexOf("**Commands in this build.**"),
    readme.indexOf("**Run the website locally:**"),
  );
  assert.ok(section.length > 0, "README command index is present");
  const listed = [...section.matchAll(/^\| `([a-z]+)` +\|/gm)].map(
    (match) => match[1],
  );
  const available = commandCatalog()
    .filter((command) => command.available)
    .map((command) => command.name);
  assert.deepEqual([...listed].sort(), [...available].sort());
});
