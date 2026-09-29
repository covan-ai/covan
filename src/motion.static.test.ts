import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Everything that moves can be told to stop.
 *
 * `prefers-reduced-motion` is not a preference in the sense a theme is. For
 * some readers an animation is nausea or a migraine, and for one of them a
 * chat screen is the worst possible place to put an unstoppable one — it is
 * where they will spend every minute of using this product.
 *
 * This repo does it by listing the animated classes explicitly rather than by
 * a blanket `* { animation: none !important }`, which is the right choice —
 * the blanket also kills the animations that ARE the content — and it has the
 * failure mode that goes with it: a new animation is one class added in one
 * place, and the list is somewhere else. Nothing catches the omission, because
 * the screen looks correct to whoever wrote it.
 *
 * So: read the stylesheet as text, find every class that animates, and check
 * each one against the list. jsdom evaluates no media query, so there is no
 * honest way to ask a rendered component whether it would hold still.
 */

// Comments go first. This file's are long, prose-shaped, and full of commas
// and braces, all of which a selector splitter would read as structure.
const CSS = readFileSync(join(import.meta.dirname, "styles.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** The body of a `{ … }` starting at `open`, brace-matched. */
function block(source: string, open: number): { body: string; end: number } {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return { body: source.slice(open + 1, i), end: i };
    }
  }
  throw new Error("unbalanced braces in styles.css");
}

const tidy = (selector: string) => selector.trim().replace(/\s+/g, " ");

/** Every rule in a stretch of CSS, as `[selector, declarations]`. */
function rules(source: string): [string, string][] {
  const found: [string, string][] = [];
  let i = 0;
  while (i < source.length) {
    const open = source.indexOf("{", i);
    if (open === -1) break;
    const head = source.slice(i, open);
    const { body, end } = block(source, open);
    // An at-rule's body holds rules of its own rather than declarations.
    if (head.trimStart().startsWith("@")) found.push(...rules(body));
    else for (const selector of head.split(",")) found.push([tidy(selector), body]);
    i = end + 1;
  }
  return found;
}

/** The whole file, split into the reduced-motion blocks and everything else. */
function split() {
  let reduced = "";
  let rest = "";
  let i = 0;
  while (i < CSS.length) {
    const at = CSS.indexOf("@media (prefers-reduced-motion: reduce)", i);
    if (at === -1) {
      rest += CSS.slice(i);
      break;
    }
    rest += CSS.slice(i, at);
    const { body, end } = block(CSS, CSS.indexOf("{", at));
    reduced += body;
    i = end + 1;
  }
  return { reduced, rest };
}

describe("reduced motion", () => {
  const { reduced, rest } = split();

  const animated = rules(rest)
    .filter(([, decls]) => /(^|[;{\s])animation(-name)?\s*:/.test(decls))
    .map(([selector]) => selector);

  const stopped = rules(reduced)
    .filter(([, decls]) => /animation(-name)?\s*:\s*none/.test(decls))
    .map(([selector]) => selector);

  it("finds the animations it is meant to be checking", () => {
    // Without this, a regex that matched nothing would report perfect
    // compliance — the quietest way for a guard like this to become a comment.
    expect(animated).toContain(".typing-dot");
    expect(animated.length).toBeGreaterThanOrEqual(3);
  });

  it("switches off every class that animates", () => {
    expect([...new Set(animated)].filter((s) => !stopped.includes(s))).toEqual([]);
  });

  it("switches off nothing that does not animate", () => {
    // The other direction catches a rename: the class moves on, its entry in
    // the list stays behind, and the list slowly stops describing the file.
    expect(stopped.filter((s) => !animated.includes(s))).toEqual([]);
  });
});
