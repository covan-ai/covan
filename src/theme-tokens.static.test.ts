import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every colour the interface paints with exists in both themes.
 *
 * `.dark` does not derive from `:root` — it restates the whole ladder by hand,
 * which is what lets it be a warm near-black rather than an inverted cream. The
 * cost of that is a token added to one block and forgotten in the other, and
 * that failure is invisible on a developer's laptop: the light theme is the
 * default, the missing variable resolves to nothing, and `bg-<token>` paints
 * transparent on a screen nobody was looking at.
 *
 * Read statically rather than rendered because jsdom evaluates no cascade, so
 * there is no honest way to ask a component what colour it came out.
 */

const CSS = readFileSync(join(import.meta.dirname, "styles.css"), "utf8");

/** A value that is a colour, as opposed to a length or an easing curve. */
const COLOUR = /^\s*(#|oklch\(|rgb|hsl|color-mix\()/;

function declarations(selector: string): Map<string, string> {
  const open = CSS.indexOf(`${selector} {`);
  expect(open, `${selector} block exists`).toBeGreaterThan(-1);
  const body = CSS.slice(open, CSS.indexOf("\n}", open));

  const found = new Map<string, string>();
  for (const line of body.split("\n")) {
    const match = /^\s*(--[a-z0-9-]+):([^;]*);/.exec(line);
    if (match) found.set(match[1], match[2]);
  }
  return found;
}

describe("theme tokens", () => {
  const light = declarations(":root");
  const dark = declarations(".dark");

  it("declares every light colour again in the dark theme", () => {
    const missing = [...light]
      .filter(([, value]) => COLOUR.test(value))
      .map(([name]) => name)
      .filter((name) => !dark.has(name));

    expect(missing).toEqual([]);
  });

  it("invents no colour that only the dark theme has", () => {
    // The other direction is the same bug wearing a different hat: a dark-only
    // token paints nothing for the readers who never turn the theme on, which
    // is most of them.
    const orphans = [...dark]
      .filter(([, value]) => COLOUR.test(value))
      .map(([name]) => name)
      .filter((name) => !light.has(name));

    expect(orphans).toEqual([]);
  });

  it("exposes each surface token to Tailwind, so a class name can reach it", () => {
    // A token nothing maps in `@theme inline` is unreachable from markup: the
    // declaration is fine, `bg-<token>` simply is not a class.
    for (const name of ["--surface", "--surface-hover", "--surface-muted", "--bubble"]) {
      expect(CSS).toContain(`--color-${name.slice(2)}: var(${name});`);
    }
  });
});
