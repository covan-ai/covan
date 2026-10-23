import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What the two catalogues promise each other.
 *
 * Read from disk rather than through i18next, because every failure here is
 * one i18next hides: a Turkish key with no English behind it is never shown,
 * a missing Turkish value falls back to English without a word, and a
 * placeholder spelled differently in the translation renders as its own
 * braces. Each is a review miss that only a reader of both files would
 * catch, so this is that reader.
 *
 * `en.json` is written by `bun run i18n:extract` from the source, so it is
 * the list of strings that already go through `t()`. Requiring a Turkish
 * value for every one of them is therefore the per-file contract of the
 * phased rollout: a file is either untouched, or translated in full.
 */

const dir = join(import.meta.dirname, "locales");

type Catalogue = Record<string, string>;

function read(name: string): Catalogue {
  return JSON.parse(readFileSync(join(dir, name), "utf8")) as Catalogue;
}

const PLURAL = /^(.*)_(ordinal_)?(zero|one|two|few|many|other)$/;
const CONTEXT = /^(.*)_([a-z][a-zA-Z0-9]*)$/;
const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

function placeholders(value: string): Set<string> {
  return new Set([...value.matchAll(PLACEHOLDER)].map((m) => m[1]!));
}

/** The pairs this tree has: (en, tr), plus (en.cloud, tr.cloud) in the hosted tree. */
function pairs(): Array<{ suffix: string; en: Catalogue; tr: Catalogue }> {
  return readdirSync(dir)
    .filter((f) => /^en(\.[a-z]+)?\.json$/.test(f))
    .map((f) => {
      const suffix = f.slice("en".length, -".json".length);
      return { suffix, en: read(f), tr: read(`tr${suffix}.json`) };
    });
}

describe("the catalogues", () => {
  it("exist as JSON, and nothing else lives beside them", () => {
    expect(existsSync(join(dir, "en.json"))).toBe(true);
    expect(existsSync(join(dir, "tr.json"))).toBe(true);
    // A `tr.ts` would be Turkish in a file the interface-language guard
    // scans; a stray file here would be one the glob in resources.ts loads.
    expect(readdirSync(dir).filter((f) => !/^(en|tr)(\.[a-z]+)?\.json$/.test(f))).toEqual([]);
  });

  for (const { suffix, en, tr } of pairs()) {
    describe(`en${suffix} and tr${suffix}`, () => {
      it("say the English in the key, so the English interface is the source", () => {
        const wrong: string[] = [];
        for (const [key, value] of Object.entries(en)) {
          const plural = PLURAL.exec(key);
          if (plural) {
            const base = plural[1]!;
            const form = plural[3]!;
            if (form === "one" && !plural[2] && value !== base) {
              wrong.push(
                `${key}: the _one form must read as the key itself, got ${JSON.stringify(value)}`,
              );
            }
            if (!value) wrong.push(`${key}: empty`);
            continue;
          }
          const context = CONTEXT.exec(key);
          const isContextKey = context !== null && context[1]! in en;
          if (isContextKey) {
            // `t("Done", { context: "status" })` extracts as `Done_status`,
            // and without a `defaultValue: "Done"` in the call the English
            // interface would show the key.
            if (value === key)
              wrong.push(`${key}: a context call needs defaultValue (it would show as "${key}")`);
            continue;
          }
          if (value !== key) wrong.push(`${key}: value ${JSON.stringify(value)} is not the key`);
        }
        expect(wrong).toEqual([]);
      });

      it("has a Turkish value for every English key", () => {
        const missing = Object.keys(en).filter((key) => !tr[key]);
        expect(missing).toEqual([]);
      });

      it("has no Turkish for a key the English does not have", () => {
        const orphans = Object.keys(tr).filter((key) => !(key in en));
        expect(orphans).toEqual([]);
      });

      it("keeps every placeholder the English has, and invents none", () => {
        const wrong: string[] = [];
        for (const [key, value] of Object.entries(tr)) {
          const expected = placeholders(en[key] ?? "");
          for (const name of placeholders(value)) {
            if (!expected.has(name)) wrong.push(`${key}: {{${name}}} is not in the English`);
          }
        }
        expect(wrong).toEqual([]);
      });

      it("never hangs a Turkish suffix off a placeholder", () => {
        // `{{name}}'ın` reads right for one name and wrong for the next;
        // the noun after the placeholder takes the suffix instead.
        const suffixed = Object.entries(tr)
          .filter(([, value]) => /\}\}\s*'/.test(value))
          .map(([key]) => key);
        expect(suffixed).toEqual([]);
      });

      it("has both plural forms wherever it has one", () => {
        const incomplete: string[] = [];
        for (const catalogue of [en, tr]) {
          for (const key of Object.keys(catalogue)) {
            const plural = PLURAL.exec(key);
            if (!plural || plural[2]) continue;
            const base = plural[1]!;
            for (const form of ["one", "other"]) {
              if (!(`${base}_${form}` in catalogue)) incomplete.push(`${base}_${form}`);
            }
          }
        }
        expect([...new Set(incomplete)]).toEqual([]);
      });
    });
  }

  it("keeps the hosted tree's own keys apart from the shared ones", () => {
    const all = pairs();
    const shared = all.find((p) => p.suffix === "");
    for (const extra of all.filter((p) => p.suffix !== "")) {
      const overlap = Object.keys(extra.en).filter((key) => key in (shared?.en ?? {}));
      expect(overlap, `en${extra.suffix}.json repeats shared keys`).toEqual([]);
    }
  });
});
