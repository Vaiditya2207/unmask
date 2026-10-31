import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../public/fonts/", import.meta.url);
const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

test("bundled fonts preserve the exact asset bytes, declared faces and four Latin preloads", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("manifest.json", root), "utf8"),
  );
  assert.equal(manifest.schemaVersion, "1");
  assert.equal(manifest.assets.length, 23);
  assert.equal(
    manifest.assets.reduce(
      (sum: number, item: { bytes: number }) => sum + item.bytes,
      0,
    ),
    531464,
  );
  assert.equal(
    manifest.assets.filter((item: { preload: boolean }) => item.preload).length,
    4,
  );
  const css = readFileSync(
    new URL("../app/fonts.css", import.meta.url),
    "utf8",
  );
  const faces = [...css.matchAll(/@font-face\s*\{([^}]+)\}/gu)].map((match) =>
    Object.fromEntries(
      match[1]
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const at = part.indexOf(":");
          return [part.slice(0, at).trim(), part.slice(at + 1).trim()];
        }),
    ),
  );
  const normalize = (items: Record<string, string>[]) =>
    items.map((face) =>
      Object.fromEntries(
        Object.entries(face).map(([key, value]) => [
          key,
          value
            .replace(/\s+/gu, " ")
            .replace(/,\s*/gu, ",")
            .replace(/^0\.0+%$/u, "0%"),
        ]),
      ),
    );
  assert.deepEqual(normalize(faces), normalize(manifest.faces));
  assert.equal(faces.length, 59);
  assert.equal(faces.filter((face) => face.src.startsWith("local(")).length, 3);
  const cssFiles = new Set(
    [...css.matchAll(/url\(\/fonts\/([a-f0-9]{64}\.woff2)\)/gu)].map(
      (match) => match[1],
    ),
  );
  assert.equal(cssFiles.size, 23);
  for (const item of manifest.assets) {
    const bytes = readFileSync(new URL(item.file, root));
    assert.equal(bytes.subarray(0, 4).toString(), "wOF2");
    assert.equal(bytes.length, item.bytes);
    assert.equal(sha256(bytes), item.sha256);
    assert.equal(item.file, `${item.sha256}.woff2`);
    assert.ok(cssFiles.has(item.file));
    assert.match(item.sourceURL, /^https:\/\/fonts\.gstatic\.com\//u);
  }
  assert.deepEqual(
    readdirSync(root)
      .filter((name) => name.endsWith(".woff2"))
      .sort(),
    manifest.assets.map((item: { file: string }) => item.file).sort(),
  );
});

test("font license records, layout preloads and Docker packaging remain local", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("manifest.json", root), "utf8"),
  );
  assert.equal(manifest.licenses.length, 3);
  for (const item of manifest.licenses) {
    const bytes = readFileSync(new URL(item.file, root));
    assert.equal(sha256(bytes), item.sha256);
    assert.match(bytes.toString(), /SIL OPEN FONT LICENSE Version 1.1/u);
  }
  const layout = readFileSync(
    new URL("../app/layout.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(layout, /next\/font\/google/u);
  assert.match(layout, /rel="preload"/u);
  assert.match(layout, /manifest\.assets\s*\.filter/u);
  assert.match(layout, /crossOrigin="anonymous"/u);
  assert.match(
    readFileSync(new URL("../Dockerfile", import.meta.url), "utf8"),
    /COPY --from=build --chown=node:node \/app\/public \.\/public/u,
  );
});
