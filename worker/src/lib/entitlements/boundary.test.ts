import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Prices stay out of this tree.
 *
 * The open build reports what was consumed (`Spend`) and the hosted build alone
 * knows what it costs. A price book is a file somebody will be tempted to
 * "share" with a route that wants to show a figure, so this fails on the names
 * the hosted price book uses, anywhere except in that price book itself.
 */
const SRC = join(__dirname, "..", "..");
const ALLOWED =
  /^lib\/entitlements\/(metered|pricebook)[^/]*\.ts$|^lib\/entitlements\/boundary\.test\.ts$/;
const PRICE_NAMES = /\b(MICRO_PER_CREDIT|CREDIT_USD|[A-Z_]*USD_PER[A-Z_]*)\b/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("the pricing boundary", () => {
  it("keeps price constants inside the hosted price book", () => {
    const leaks = walk(SRC)
      .map((path) => relative(SRC, path).split("\\").join("/"))
      .filter((rel) => !ALLOWED.test(rel))
      .filter((rel) => PRICE_NAMES.test(readFileSync(join(SRC, rel), "utf8")));
    expect(leaks).toEqual([]);
  });
});
