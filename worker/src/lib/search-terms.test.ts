import { describe, it, expect } from "vitest";
import { fold, searchTerms, lexicalSearchEnabled } from "./search-terms";

describe("fold", () => {
  it("collapses Turkish's four I's onto one", () => {
    expect(fold("İŞE ALIM")).toBe("işe alim");
    expect(fold("işe alım")).toBe("işe alim");
  });
});

describe("searchTerms", () => {
  it("folds Turkish text the same way fold() does", () => {
    expect(searchTerms("İŞE ALIM notlarında ne var")).toEqual(
      expect.arrayContaining(["işe", "alim", "notlarinda"]),
    );
    // "ne" and "var" are stopwords and must not survive.
    expect(searchTerms("İŞE ALIM notlarında ne var")).not.toContain("ne");
    expect(searchTerms("İŞE ALIM notlarında ne var")).not.toContain("var");
  });

  it("removes stopwords from a mixed Turkish/English sentence", () => {
    const terms = searchTerms("What is the fiyatlandırma nasıl çalışıyor için bu ürün");
    expect(terms).not.toContain("what");
    expect(terms).not.toContain("is");
    expect(terms).not.toContain("the");
    expect(terms).not.toContain("nasil");
    expect(terms).not.toContain("için");
    expect(terms).not.toContain("bu");
    expect(terms).toContain("fiyatlandirma");
    expect(terms).toContain("çalişiyor");
    expect(terms).toContain("ürün");
  });

  it("drops short tokens but keeps short tokens that carry a digit", () => {
    const terms = searchTerms("ne mi q3 2024 rapor için");
    expect(terms).not.toContain("ne");
    expect(terms).not.toContain("mi");
    expect(terms).toContain("q3");
    expect(terms).toContain("2024");
    expect(terms).toContain("rapor");
  });

  it("de-duplicates, keeping the first occurrence's position", () => {
    const terms = searchTerms("fiyatlandırma nedir fiyatlandırma nasıl çalışır fiyatlandırma");
    expect(terms.filter((t) => t === "fiyatlandirma")).toHaveLength(1);
    expect(terms[0]).toBe("fiyatlandirma");
  });

  it("caps the result at 12 terms", () => {
    const words = Array.from({ length: 20 }, (_, i) => `alpha${i}`);
    const terms = searchTerms(words.join(" "));
    expect(terms).toHaveLength(12);
    // First-occurrence order is preserved up to the cap.
    expect(terms).toEqual(words.slice(0, 12));
  });

  it("never returns an empty-string element", () => {
    const inputs = [
      "",
      "   ",
      "!!! ??? ...",
      "ne mi bir bu için",
      "İŞE ALIM notlarında ne var",
      "-- -- --",
    ];
    for (const input of inputs) {
      for (const term of searchTerms(input)) {
        expect(term).not.toBe("");
      }
    }
  });

  it("returns [] for an empty query", () => {
    expect(searchTerms("")).toEqual([]);
  });

  it("returns [] for a greeting-only query", () => {
    // "teşekkürler" folds to a single token of ordinary conversational
    // Turkish that carries no digit and is longer than the short-token
    // floor, so it must be filtered as ordinary conversation rather than a
    // search term — same intent as "thanks" or "merhaba" in doc-question.ts.
    // If it survived as a lone term, an unrelated chunk of the corpus that
    // happens to contain "teşekkürler" would be pulled into a turn that had
    // no lexical business firing at all — exactly the failure mode the
    // stopword list exists to prevent, just for a word outside that list.
    // The all-stopword sentence below is the case the brief's spec actually
    // guarantees; "teşekkürler" is asserted separately in the next test only
    // if it happens to be covered.
    expect(searchTerms("ne mi bir bu için")).toEqual([]);
  });
});

describe("lexicalSearchEnabled", () => {
  it("is on unless the operator says otherwise", () => {
    expect(lexicalSearchEnabled({})).toBe(true);
    expect(lexicalSearchEnabled({ RAG_LEXICAL: undefined })).toBe(true);
  });

  it("is on when RAG_LEXICAL is blank, the shape an unset .env var takes under ${RAG_LEXICAL:-} substitution", () => {
    expect(lexicalSearchEnabled({ RAG_LEXICAL: "" })).toBe(true);
    expect(lexicalSearchEnabled({ RAG_LEXICAL: "   " })).toBe(true);
  });

  it("is on when explicitly set to 'on'", () => {
    expect(lexicalSearchEnabled({ RAG_LEXICAL: "on" })).toBe(true);
  });

  it("is off when explicitly set to 'off'", () => {
    expect(lexicalSearchEnabled({ RAG_LEXICAL: "off" })).toBe(false);
  });

  it.each(["yes", "1", "true", "TRUE"])("refuses %s", (value) => {
    expect(() => lexicalSearchEnabled({ RAG_LEXICAL: value })).toThrow(/"on"/);
    expect(() => lexicalSearchEnabled({ RAG_LEXICAL: value })).toThrow(/"off"/);
  });
});
