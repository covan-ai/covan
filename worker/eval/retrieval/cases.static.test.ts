import { describe, expect, it } from "vitest";
import { CASES, loadCorpus, type Category } from "./cases";
import { preparePassages } from "../../src/lib/bearings";

/**
 * The benchmark's own tripwires. No model call and no database, so this runs
 * with the rest of the suite.
 *
 * Each check is for a mistake that is silent at run time: a marker split across
 * two passages can never be found however good the search gets, and the case
 * would sit at rank "none" looking like a retrieval failure.
 */
describe("the retrieval benchmark's cases", () => {
  const corpus = loadCorpus();
  const passages = corpus.flatMap((doc) => preparePassages(doc.name, doc.text));

  it("has enough cases, each with a unique id", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(48);
    const ids = CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers every category", () => {
    const categories: Category[] = [
      "exact-term",
      "paraphrase",
      "morphology",
      "cross-language",
      "table",
      "follow-up",
      "versions",
      "negative",
    ];
    for (const category of categories) {
      const count = CASES.filter((c) => c.category === category).length;
      expect(count, category).toBeGreaterThanOrEqual(category === "negative" ? 6 : 5);
    }
  });

  it("asks in both languages", () => {
    for (const lang of ["tr", "en"] as const) {
      const share = CASES.filter((c) => c.lang === lang).length / CASES.length;
      expect(share, lang).toBeGreaterThanOrEqual(0.3);
    }
  });

  it("gives every answerable case a marker and no negative case one", () => {
    for (const c of CASES) {
      if (c.category === "negative") {
        expect(c.expect, c.id).toEqual([]);
        expect(c.absent, c.id).toBeTruthy();
      } else {
        expect(c.expect.length, c.id).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("puts every marker whole inside at least one passage", () => {
    for (const c of CASES) {
      for (const marker of c.expect) {
        const found = passages.some((p) => p.content.includes(marker));
        expect(found, `${c.id}: "${marker}" is in no single passage`).toBe(true);
      }
    }
  });

  it("asks negative cases about something the corpus never mentions", () => {
    const everything = corpus.map((d) => d.text.toLocaleLowerCase("tr")).join("\n");
    for (const c of CASES.filter((c) => c.category === "negative")) {
      const absent = (c.absent ?? "").toLocaleLowerCase("tr");
      expect(everything.includes(absent), `${c.id}: "${c.absent}" is in the corpus`).toBe(false);
    }
  });

  it("is big enough for wrong answers to be plausible", () => {
    expect(passages.length).toBeGreaterThanOrEqual(150);
  });

  it("holds no email address outside a .test domain", () => {
    const text = [...corpus.map((d) => d.text), JSON.stringify(CASES)].join("\n");
    const emails = text.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? [];
    for (const email of emails) expect(email, email).toMatch(/\.test$/);
  });
});
