import { describe, it, expect } from "vitest";
import { chunkText } from "./embeddings";

describe("chunkText", () => {
  it("returns [] for empty or whitespace-only text", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n  ")).toEqual([]);
  });

  it("returns a single chunk when text is shorter than the window", () => {
    expect(chunkText("hello world", 1000, 150)).toEqual(["hello world"]);
  });

  it("splits into overlapping windows", () => {
    const text = "a".repeat(2500);
    const chunks = chunkText(text, 1000, 150);
    // step = 850 -> starts at 0, 850, 1700, 2550(>=len stop)
    expect(chunks.length).toBe(3);
    expect(chunks[0].length).toBe(1000);
    expect(chunks[1].length).toBe(1000);
    // overlap: chunk[1] starts 150 chars before chunk[0] ends
    expect(chunks[0].slice(850)).toBe(chunks[1].slice(0, 150));
  });

  it("never loops forever when overlap >= size (guards step >= 1)", () => {
    const chunks = chunkText("a".repeat(50), 10, 20);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.length).toBeLessThan(100);
  });

  // --- structure-aware behavior ---

  it("keeps every chunk within the size budget", () => {
    const text = Array.from({ length: 60 }, (_, i) => `sentence number ${i}.`).join(" ");
    const chunks = chunkText(text, 100, 20);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
  });

  it("never cuts a word in half on spaced prose", () => {
    const words = Array.from({ length: 200 }, (_, i) => `word${i}`);
    const known = new Set(words);
    const chunks = chunkText(words.join(" "), 80, 15);
    for (const c of chunks) {
      for (const w of c.split(/\s+/).filter(Boolean)) {
        expect(known.has(w)).toBe(true);
      }
    }
  });

  it("preserves every word in order across chunks (no data loss)", () => {
    const words = Array.from({ length: 150 }, (_, i) => `w${i}`);
    const chunks = chunkText(words.join(" "), 60, 12);
    const flat = chunks.join(" ").split(/\s+/).filter(Boolean);
    let idx = 0;
    for (const w of words) {
      const found = flat.indexOf(w, idx);
      expect(found).toBeGreaterThanOrEqual(idx);
      idx = found + 1;
    }
  });

  it("overlaps consecutive chunks with shared context", () => {
    const words = Array.from({ length: 120 }, (_, i) => `token${i}`);
    const chunks = chunkText(words.join(" "), 90, 25);
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 0; i < chunks.length - 1; i++) {
      const prevWords = chunks[i].split(/\s+/).filter(Boolean);
      const nextHead = new Set(chunks[i + 1].split(/\s+/).slice(0, 6));
      expect(nextHead.has(prevWords[prevWords.length - 1])).toBe(true);
    }
  });

  it("breaks on a paragraph boundary when one is available", () => {
    const p1 = "Alpha ".repeat(15).trim();
    const p2 = "Bravo ".repeat(15).trim();
    const text = `${p1}\n\n${p2}`;
    const chunks = chunkText(text, 110, 10);
    expect(chunks.length).toBeGreaterThan(1);
    // The first chunk ends at the paragraph break, so it holds only Alpha.
    expect(chunks[0]).toContain("Alpha");
    expect(chunks[0]).not.toContain("Bravo");
  });
});
