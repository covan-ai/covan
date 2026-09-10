import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The interface asks nobody else for anything to paint itself.
 *
 * Read statically rather than rendered, because every failure here is silent.
 * A `@font-face` pointing at a file nobody committed falls back to a system
 * face and looks merely a little off; a reintroduced Google `<link>` works
 * perfectly on the developer's laptop and only misbehaves on an air-gapped
 * install, or in the privacy of somebody else's users.
 *
 * /privacy states there is no third-party script or stylesheet of any kind.
 * That sentence is the reason this file is a test and not a comment.
 */

const root = join(import.meta.dirname, "..");

function source(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

const THIRD_PARTY_FONTS = /fonts\.googleapis\.com|fonts\.gstatic\.com/;

describe("web fonts", () => {
  it("are declared locally, with a weight range per family", () => {
    const css = source("src/fonts.css");

    // Two families. The range is what makes one variable file serve 400–600
    // rather than three copies of itself.
    expect(css).toMatch(/font-family:\s*"DM Sans"/);
    expect(css).toMatch(/font-family:\s*"Geist"/);
    expect(css).toMatch(/font-weight:\s*400 600/);

    // Without swap, the fallback is invisible text while the file arrives.
    expect(css).toMatch(/font-display:\s*swap/);
  });

  it("point at files that are actually committed", () => {
    const referenced = [...source("src/fonts.css").matchAll(/url\("(\/fonts\/[^"]+)"\)/g)].map(
      (match) => match[1],
    );

    expect(referenced.length, "fonts.css referenced nothing — was it regenerated?").toBeGreaterThan(
      0,
    );

    for (const file of referenced) {
      expect(
        existsSync(join(root, "public", file)),
        `${file} is declared in fonts.css but missing from public/ — run \`node scripts/fetch-fonts.mjs\``,
      ).toBe(true);
    }
  });

  it("are preloaded as CORS requests, or the browser fetches them twice", () => {
    // A font is always fetched in CORS mode. A preload without crossOrigin
    // lands in a different cache entry than the one @font-face then asks for.
    const markup = source("src/routes/__root.tsx");

    for (const block of markup.split('rel: "preload"').slice(1)) {
      const entry = block.slice(0, block.indexOf("}"));
      if (!entry.includes("/fonts/")) continue;
      expect(entry, `a font preload is missing crossOrigin:\n${entry}`).toContain("crossOrigin");
    }
  });

  it("are not fetched from Google anywhere in the tree", () => {
    // Named explicitly rather than swept, so the failure message says which
    // page started phoning home again. privacy.tsx is here because it is the
    // page that makes the promise.
    for (const path of ["src/routes/__root.tsx", "src/fonts.css", "src/routes/privacy.tsx"]) {
      expect(source(path), path).not.toMatch(THIRD_PARTY_FONTS);
    }
  });
});
