import { describe, it, expect, vi, beforeEach } from "vitest";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("openai", () => ({
  default: class {
    embeddings = { create };
  },
}));

const { chunkText, embedTexts, EMBED_BATCH_SIZE } = await import("./embeddings");

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

describe("embedTexts", () => {
  beforeEach(() => create.mockReset());

  it("returns vectors in input order, however the API orders them", async () => {
    create.mockResolvedValue({
      data: [
        { index: 1, embedding: [0.2] },
        { index: 0, embedding: [0.1] },
      ],
      usage: { total_tokens: 42 },
    });

    const { vectors } = await embedTexts("sk-test", ["first", "second"]);

    expect(vectors).toEqual([[0.1], [0.2]]);
  });

  // Indexing a document is real spend. A counter that ignored it would make
  // uploads free, which is the cheapest way to run up someone else's bill.
  it("reports what the call cost", async () => {
    create.mockResolvedValue({
      data: [{ index: 0, embedding: [0.1] }],
      usage: { total_tokens: 42 },
    });

    await expect(embedTexts("sk-test", ["hello"])).resolves.toMatchObject({ tokens: 42 });
  });

  it("reports zero when the API omits usage", async () => {
    create.mockResolvedValue({ data: [{ index: 0, embedding: [0.1] }] });

    await expect(embedTexts("sk-test", ["hello"])).resolves.toMatchObject({ tokens: 0 });
  });

  it("costs nothing and calls nothing for an empty input", async () => {
    await expect(embedTexts("sk-test", [])).resolves.toEqual({ vectors: [], tokens: 0 });
    expect(create).not.toHaveBeenCalled();
  });
});

describe("embedTexts batching", () => {
  beforeEach(() => {
    create.mockReset();
  });

  it("splits large inputs across requests, preserving order and summing tokens", async () => {
    // Each vector encodes its own input string, so a reordering bug is visible.
    create.mockImplementation(async ({ input }: { input: string[] }) => ({
      data: input.map((t, i) => ({ index: i, embedding: [Number(t)] })),
      usage: { total_tokens: input.length },
    }));

    const texts = Array.from({ length: 300 }, (_, i) => String(i));
    const res = await embedTexts("key", texts);

    expect(create).toHaveBeenCalledTimes(3); // 128 + 128 + 44
    expect(res.vectors).toHaveLength(300);
    expect(res.vectors[0]).toEqual([0]);
    expect(res.vectors[128]).toEqual([128]); // first item of the second batch
    expect(res.vectors[299]).toEqual([299]);
    expect(res.tokens).toBe(300);
  });

  it("never exceeds the batch size in a single request", async () => {
    create.mockImplementation(async ({ input }: { input: string[] }) => ({
      data: input.map((t, i) => ({ index: i, embedding: [Number(t)] })),
      usage: { total_tokens: input.length },
    }));

    await embedTexts(
      "key",
      Array.from({ length: 1500 }, (_, i) => String(i)),
    );

    for (const call of create.mock.calls) {
      expect(call[0].input.length).toBeLessThanOrEqual(EMBED_BATCH_SIZE);
    }
  });

  it("still makes exactly one request when the input fits in one batch", async () => {
    create.mockResolvedValue({
      data: [{ index: 0, embedding: [1] }],
      usage: { total_tokens: 7 },
    });

    const res = await embedTexts("key", ["only one"]);

    expect(create).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ vectors: [[1]], tokens: 7 });
  });
});
