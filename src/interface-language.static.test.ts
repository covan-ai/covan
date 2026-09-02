import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The interface is in English, all of it.
 *
 * Two strings in the brainstorm pane shipped in Turkish — "Fikir Panosu" as the
 * idea board's heading, "Board'a ekle" on the button under each candidate idea —
 * and stayed there long enough for somebody to find them by using the product.
 * They are the residue of building a feature quickly in the language it was
 * being discussed in, which gives no signal at review time: both read as
 * deliberate to anyone who speaks Turkish, and neither is near the other in the
 * file.
 *
 * The obvious guard is to look for the letters Turkish has and English does not.
 * It does not work, and finding that out is the reason this comment is long:
 * **neither shipped string contains one.** "Fikir Panosu" and "Board'a ekle" are
 * pure ASCII. A letter check would have passed on the exact two strings it would
 * have been written to catch.
 *
 * So there are three passes, and the letters are the weakest of them:
 *
 * 1. The six letters Turkish has and English does not — dotless ı, dotted İ,
 *    ğ/Ğ, ş/Ş. Narrower than the full alphabet on purpose: ö, ü and ç are shared
 *    with several languages and turn up in names, and a check that fires on a
 *    person's name is a check people learn to override.
 * 2. A short list of Turkish words that are not also English words. Every entry
 *    is spelled in ASCII, because anything with a Turkish letter in it is
 *    already caught by the first pass.
 * 3. An apostrophe followed by a Turkish case suffix — the `Board'a` shape.
 *    English clitics after an apostrophe are a closed set (`'s`, `'t`, `'re`,
 *    `'ve`, `'ll`, `'d`, `'m`) and none of them collide.
 *
 * Tests are exempt, deliberately: `use-dictation.test.ts` transcribes "merhaba
 * dünya" and the export tests round-trip "toplantı-notları.md", because
 * non-ASCII input is exactly what those two exist to prove survives. The rule is
 * about what the product says, not about what it can carry.
 */

const SRC = join(import.meta.dirname ?? "src", ".");

const TURKISH_LETTERS = /[ığĞşŞİ]/;

const TURKISH_WORDS = new RegExp(
  `\\b(${[
    "fikir",
    "pano",
    "panosu",
    "panoya",
    "ekle",
    "ekleyin",
    "kaydet",
    "kapat",
    "iptal",
    "geri",
    "hata",
    "dosya",
    "belge",
    "mesaj",
    "sohbet",
    "tamam",
    "evet",
    "hayir",
    "merhaba",
    "bilgi",
    "listele",
    "olustur",
    "gonder",
    "duzenle",
    "yukle",
    "bekleyin",
    "kullanici",
    "sifre",
  ].join("|")})\\b`,
  "i",
);

/** `Board'a`, `Covan'da`, `panoya'yı` — a case ending hung off an apostrophe. */
const TURKISH_SUFFIX = /'(a|e|ya|ye|da|de|ta|te|dan|den|tan|ten|nin|nun|la|le|yi|yu)\b/i;

/**
 * Turkish that is correct where it stands, and would be wrong translated.
 *
 * Both come from the legal pages, and both are the same kind of thing: the
 * name of an institution, and a statutory term quoted beside its English
 * equivalent. Translating the authority's name would leave a reader unable to
 * find it, and paraphrasing `veri işleyen` would drop the exact word KVKK
 * assigns a meaning to. Neither is an untranslated interface string.
 *
 * By phrase rather than by file on purpose. A file-level exemption would make
 * the whole of `privacy.tsx` invisible to this check, including a heading
 * somebody adds in Turkish next year; naming the phrases keeps everything
 * around them covered, and the list is the record of what was decided.
 */
const ALLOWED = [
  // Turkey's data protection authority, named in the DPA and the privacy page.
  "Kişisel Verileri Koruma Kurumu",
  // The KVKK term for "processor", quoted alongside it in the DPA's definitions.
  "veri işleyen",
];

const SKIP_FILES = new Set(["routeTree.gen.ts"]);

/** Why this line looks Turkish, or null. Exported shape kept simple for the assertion below. */
function turkishHit(rawLine: string): string | null {
  const line = ALLOWED.reduce((rest, phrase) => rest.split(phrase).join(""), rawLine);
  if (TURKISH_LETTERS.test(line)) return "letter";
  const word = TURKISH_WORDS.exec(line);
  if (word) return `word: ${word[1]}`;
  const suffix = TURKISH_SUFFIX.exec(line);
  if (suffix) return `suffix: '${suffix[1]}`;
  return null;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (SKIP_FILES.has(entry.name)) return [];
    if (/\.test\.tsx?$/.test(entry.name)) return [];
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("interface language", () => {
  it("has no Turkish left in the shipped source", () => {
    const offenders = sourceFiles(SRC).flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .map((line, i) => ({ hit: turkishHit(line), line, n: i + 1 }))
        .filter(({ hit }) => hit !== null)
        .map(({ hit, line, n }) => `${path.slice(SRC.length + 1)}:${n} (${hit}): ${line.trim()}`),
    );

    expect(offenders).toEqual([]);
  });

  it("catches the two strings that shipped, which no letter check would", () => {
    expect(turkishHit(`<Sparkles /> Fikir Panosu`)).toBe("word: Fikir");
    expect(turkishHit(`Board'a ekle`)).toBe("word: ekle");

    // The replacements, and the English that has to keep passing around them.
    expect(turkishHit("Idea board")).toBeNull();
    expect(turkishHit("Add to board")).toBeNull();
    expect(turkishHit("Don't have an account?")).toBeNull();
    expect(turkishHit("the workspace's documents")).toBeNull();
  });

  it("lets the legal pages keep the Turkish that has to stay", () => {
    // Both of these are in the shipped source and both are correct there. The
    // exemption is the phrase, not the file, so a Turkish string that happens
    // to share a line with one is still caught.
    expect(turkishHit("complain to the Kişisel Verileri Koruma Kurumu in Türkiye")).toBeNull();
    expect(turkishHit("<strong>processor</strong> — <em>veri işleyen</em>")).toBeNull();
    expect(turkishHit("Kişisel Verileri Koruma Kurumu — Fikir Panosu")).toBe("word: Fikir");
  });
});
