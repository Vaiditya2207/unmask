import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../public/fonts/", import.meta.url);
const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

test("bundled fonts preserve the exact asset bytes, declared faces and two Latin preloads", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("manifest.json", root), "utf8"),
  );
  assert.equal(manifest.schemaVersion, "1");
  assert.deepEqual(
    manifest.source.cssRequests.map((item: { family: string }) => item.family),
    ["Bricolage Grotesque", "IBM Plex Mono"],
  );
  assert.equal(manifest.assets.length, 13);
  assert.equal(
    manifest.assets.reduce(
      (sum: number, item: { bytes: number }) => sum + item.bytes,
      0,
    ),
    186080,
  );
  assert.equal(
    manifest.assets.filter((item: { preload: boolean }) => item.preload).length,
    2,
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
  assert.equal(faces.length, 15);
  assert.equal(faces.filter((face) => face.src.startsWith("local(")).length, 2);
  assert.match(
    css,
    /:root\s*\{[^}]*--font-sans:\s*"Bricolage Grotesque",\s*"Bricolage Grotesque Fallback";/u,
  );
  assert.match(
    css,
    /:root\s*\{[^}]*--font-mono:\s*"IBM Plex Mono",\s*"IBM Plex Mono Fallback";/u,
  );
  const cssFiles = new Set(
    [...css.matchAll(/url\(\/fonts\/([a-f0-9]{64}\.woff2)\)/gu)].map(
      (match) => match[1],
    ),
  );
  assert.equal(cssFiles.size, 13);
  assert.deepEqual(
    [...cssFiles].sort(),
    manifest.assets.map((item: { file: string }) => item.file).sort(),
  );
  for (const item of manifest.assets) {
    const bytes = readFileSync(new URL(item.file, root));
    assert.equal(bytes.subarray(0, 4).toString(), "wOF2");
    assert.equal(bytes.length, item.bytes);
    assert.equal(sha256(bytes), item.sha256);
    assert.equal(item.file, `${item.sha256}.woff2`);
    assert.ok(cssFiles.has(item.file));
    assert.match(item.sourceURL, /^https:\/\/fonts\.gstatic\.com\//u);
  }
  const preloaded = manifest.assets
    .filter((item: { preload: boolean }) => item.preload)
    .map((item: { file: string }) =>
      faces
        .filter((face) => face.src.includes(item.file))
        .map(
          (face) =>
            `${face["font-family"]} ${face["font-weight"]} ${face["unicode-range"].split(",")[0]}`,
        ),
    );
  assert.deepEqual(preloaded, [
    ["Bricolage Grotesque 200 800 u+00??"],
    ["IBM Plex Mono 400 u+00??"],
  ]);
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
  assert.equal(manifest.licenses.length, 2);
  for (const item of manifest.licenses) {
    const bytes = readFileSync(new URL(item.file, root));
    assert.equal(sha256(bytes), item.sha256);
    assert.match(bytes.toString(), /SIL OPEN FONT LICENSE Version 1.1/u);
    assert.doesNotMatch(bytes.toString(), /\r|[ \t]$/mu);
  }
  assert.deepEqual(
    readdirSync(root)
      .filter((name) => name.endsWith(".txt"))
      .sort(),
    manifest.licenses.map((item: { file: string }) => item.file).sort(),
  );
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
