import { describe, it, expect, vi, beforeEach } from "vitest";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("openai", () => ({
  default: class {
    embeddings = { create };
  },
}));

const {
  chunkText,
  embedTexts,
  embeddingModel,
  embeddingDimensions,
  EMBED_BATCH_SIZE,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_EMBEDDING_DIMENSIONS,
} = await import("./embeddings");

/**
 * Every mocked response below returns one-element vectors, so the tests declare
 * a one-dimensional database. Stating it beats making the guard tolerant: a
 * width check that let short vectors through would pass every test here and
 * still let a 768-dimension model reach a 1536-wide column in production.
 */
const env = (extra: Record<string, string> = {}) => ({
  OPENAI_API_KEY: "sk-test",
  EMBEDDING_DIMENSIONS: "1",
  ...extra,
});

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

/**
 * Braces, not a bare arrow. `mockReset()` returns the mock, an arrow body
 * returns it, and Vitest treats anything a `beforeEach` returns as a teardown
 * function — so `() => create.mockReset()` quietly registers the mock itself as
 * a cleanup hook and calls it with no arguments after every test. Harmless
 * while every implementation ignores its arguments, and a TypeError from inside
 * a cleanup hook the moment one destructures them.
 */
describe("embedTexts", () => {
  beforeEach(() => {
    create.mockReset();
  });

  it("returns vectors in input order, however the API orders them", async () => {
    create.mockResolvedValue({
      data: [
        { index: 1, embedding: [0.2] },
        { index: 0, embedding: [0.1] },
      ],
      usage: { total_tokens: 42 },
    });

    const { vectors } = await embedTexts(env(), ["first", "second"]);

    expect(vectors).toEqual([[0.1], [0.2]]);
  });

  // Indexing a document is real spend. A counter that ignored it would make
  // uploads free, which is the cheapest way to run up someone else's bill.
  it("reports what the call cost", async () => {
    create.mockResolvedValue({
      data: [{ index: 0, embedding: [0.1] }],
      usage: { total_tokens: 42 },
    });

    await expect(embedTexts(env(), ["hello"])).resolves.toMatchObject({ tokens: 42 });
  });

  it("reports zero when the API omits usage", async () => {
    create.mockResolvedValue({ data: [{ index: 0, embedding: [0.1] }] });

    await expect(embedTexts(env(), ["hello"])).resolves.toMatchObject({ tokens: 0 });
  });

  it("costs nothing and calls nothing for an empty input", async () => {
    await expect(embedTexts(env(), [])).resolves.toEqual({ vectors: [], tokens: 0 });
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
    const res = await embedTexts(env(), texts);

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
      env(),
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

    const res = await embedTexts(env(), ["only one"]);

    expect(create).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ vectors: [[1]], tokens: 7 });
  });
});

describe("which model embeds", () => {
  beforeEach(() => {
    create.mockReset();
    create.mockResolvedValue({ data: [{ index: 0, embedding: [0.1] }], usage: {} });
  });

  it("is OpenAI's unless the operator names another", async () => {
    await embedTexts(env(), ["hello"]);
    expect(create.mock.calls[0][0].model).toBe(DEFAULT_EMBEDDING_MODEL);
  });

  it("is whatever the operator named", async () => {
    await embedTexts(env({ EMBEDDING_MODEL: "nomic-embed-text" }), ["hello"]);
    expect(create.mock.calls[0][0].model).toBe("nomic-embed-text");
  });

  it("treats an empty EMBEDDING_MODEL as unset, the way a .env line does", () => {
    // A variable declared and left blank arrives as "", not undefined, and ""
    // as a model name is a 400 from every endpoint there is.
    expect(embeddingModel({ EMBEDDING_MODEL: "" })).toBe(DEFAULT_EMBEDDING_MODEL);
    expect(embeddingModel({ EMBEDDING_MODEL: "  " })).toBe(DEFAULT_EMBEDDING_MODEL);
  });
});

describe("the width this database stores", () => {
  it("is 1536 unless the operator changed the column", () => {
    expect(embeddingDimensions({})).toBe(DEFAULT_EMBEDDING_DIMENSIONS);
    expect(embeddingDimensions({ EMBEDDING_DIMENSIONS: "" })).toBe(DEFAULT_EMBEDDING_DIMENSIONS);
  });

  it("is whatever they set it to", () => {
    expect(embeddingDimensions({ EMBEDDING_DIMENSIONS: "768" })).toBe(768);
    expect(embeddingDimensions({ EMBEDDING_DIMENSIONS: " 1024 " })).toBe(1024);
  });

  it.each(["nope", "768.5", "-1", "0"])("refuses %s rather than falling back", (value) => {
    // Falling back would be the dangerous kindness: a typo'd width silently
    // reverting to 1536 is how a 768-dimension model gets as far as the insert.
    expect(() => embeddingDimensions({ EMBEDDING_DIMENSIONS: value })).toThrow(
      /EMBEDDING_DIMENSIONS/,
    );
  });
});

/**
 * The guard the whole change hangs on.
 *
 * Without it a mismatched model does not fail at the request — it fails at the
 * insert, and both upload paths log an insert failure and still report the
 * document as saved. The operator's symptom is documents that upload cleanly
 * and answer nothing.
 */
describe("a model of the wrong width", () => {
  beforeEach(() => {
    create.mockReset();
  });

  it("is refused, naming both numbers and the endpoint", async () => {
    create.mockResolvedValue({
      data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
      usage: { total_tokens: 5 },
    });

    await expect(
      embedTexts(
        env({ EMBEDDING_DIMENSIONS: "1536", EMBEDDING_BASE_URL: "http://ollama:11434/v1" }),
        ["hello"],
      ),
    ).rejects.toThrow(/returned 3 dimensions, but this database stores 1536/);
  });

  it("says where the request went, because that is the setting to change", async () => {
    create.mockResolvedValue({ data: [{ index: 0, embedding: [0.1, 0.2] }], usage: {} });

    await expect(
      embedTexts(env({ EMBEDDING_BASE_URL: "http://ollama:11434/v1" }), ["hello"]),
    ).rejects.toThrow(/http:\/\/ollama:11434\/v1/);
  });

  it("names OpenAI when no endpoint was configured", async () => {
    create.mockResolvedValue({ data: [{ index: 0, embedding: [0.1, 0.2] }], usage: {} });

    await expect(embedTexts(env(), ["hello"])).rejects.toThrow(/api\.openai\.com/);
  });

  it("is caught on a later batch too, not just the first", async () => {
    // A server that serves two models behind one name, or truncates under load,
    // would otherwise put short vectors into a column that accepted the first
    // batch. Checking every vector costs nothing next to the request itself.
    create.mockImplementation(async ({ input }: { input: string[] }) => ({
      data: input.map((_, i) => ({ index: i, embedding: input[0] === "128" ? [1, 2] : [1] })),
      usage: { total_tokens: input.length },
    }));

    await expect(
      embedTexts(
        env(),
        Array.from({ length: 200 }, (_, i) => String(i)),
      ),
    ).rejects.toThrow(/returned 2 dimensions/);
    expect(create).toHaveBeenCalledTimes(2);
  });
});
