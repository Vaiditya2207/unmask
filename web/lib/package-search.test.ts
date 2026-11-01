import assert from "node:assert/strict";
import { test } from "node:test";
import { packageSuggestions } from "./package-search.ts";

test("suggestions pin valid scoped and unscoped releases and deduplicate", () => {
  const objects = ["react", "@scope/pkg", "react"].map((name) => ({
    package: { name, version: "1.2.3" },
  }));
  assert.deepEqual(packageSuggestions({ objects }), [
    "react@1.2.3",
    "@scope/pkg@1.2.3",
  ]);
});
test("suggestions reject malformed responses, URLs and mutable versions", () => {
  for (const value of [
    null,
    {},
    {
      objects: [
        null,
        {},
        { package: { name: "https://evil.test", version: "1.2.3" } },
        { package: { name: "react", version: "latest" } },
      ],
    },
  ])
    assert.deepEqual(packageSuggestions(value), []);
});
test("suggestions stay bounded", () => {
  assert.equal(
    packageSuggestions({
      objects: Array.from({ length: 30 }, (_, i) => ({
        package: { name: `pkg-${i}`, version: "1.0.0" },
      })),
    }).length,
    8,
  );
});
