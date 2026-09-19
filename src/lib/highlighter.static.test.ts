import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The highlighter asks the bundler for fifteen grammars, not for every grammar
 * Shiki ships.
 *
 * Read statically rather than exercised, because the failure is invisible from
 * inside the app. Importing from `shiki` — the package root, which is
 * `bundle/full` — gives the same `highlight()` behaviour, the same output, the
 * same passing tests. What changes is the build: the root entry carries a
 * dynamic import map over every language Shiki knows, so the bundler emits a
 * chunk per language. That was 373 chunks and 8.4 MB of grammars this app can
 * never request, because `resolveLang` below turns away anything outside
 * `LANGS`, plus a 607 KB oniguruma WASM chunk that it very much did request.
 *
 * Nobody would notice the regression from the browser. A `git revert`, a merge
 * that resolves in favour of the older file, an editor auto-import writing
 * `from "shiki"` at the top — each puts it back in one line, and the only
 * symptom is that the deploy is nine megabytes heavier than it was.
 */

const source = readFileSync(join(import.meta.dirname, "highlighter.ts"), "utf8");

// `import ... from "shiki"` or `from "shiki/bundle/full"` — the entries that
// pull the whole language set in. Subpaths like `shiki/core` are the point of
// this file and must stay allowed.
const FULL_BUNDLE = /from\s+["']shiki(\/bundle\/(full|web))?["']/;

describe("the code highlighter", () => {
  it("does not import Shiki's full bundle", () => {
    expect(source).not.toMatch(FULL_BUNDLE);
  });

  it("builds its highlighter from the core entry", () => {
    expect(source).toMatch(/createHighlighterCore/);
    expect(source).toMatch(/from\s+["']shiki\/core["']/);
  });

  it("uses the JavaScript regex engine, so no WASM is shipped", () => {
    expect(source).toMatch(/createJavaScriptRegexEngine/);
    expect(source).toMatch(/from\s+["']shiki\/engine\/javascript["']/);
    // The oniguruma engine is the one that drags in the WASM chunk.
    expect(source).not.toMatch(/engine\/oniguruma|shiki\/wasm/);
  });

  it("loads one module per supported language, and only when asked", () => {
    // Every name in LANGS has to be reachable as its own module, and the import
    // has to be dynamic — a static one would put all fifteen grammars, `cpp`'s
    // 767 KB included, into the chunk that renders the first code block.
    expect(source).toMatch(/import\(\s*["'`]@shikijs\/langs/);
    expect(source).not.toMatch(/^import .* from ["']@shikijs\/langs/m);
  });
});
