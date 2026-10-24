import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cachedEmbedder } from "./embed-cache";
import type { EmbeddingConfig } from "../../src/lib/embeddings";

/**
 * Corpus vectors are cached so two runs being compared were matched against
 * the same vectors — and a change of model or width must never read the old
 * ones, or a comparison of two models would compare one model with itself.
 */
describe("cachedEmbedder", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "embed-cache-"));
    dirs.push(dir);
    const calls: string[][] = [];
    const embed = async (_env: EmbeddingConfig, texts: string[]) => {
      calls.push(texts);
      return { vectors: texts.map((t) => [t.length, 1]), tokens: texts.length };
    };
    return { dir, calls, embed };
  }

  const env: EmbeddingConfig = { OPENAI_API_KEY: "k" };

  it("embeds a text once however many times it is asked for", async () => {
    const { dir, calls, embed } = setup();
    await cachedEmbedder(env, dir, embed)(["a", "bb"]);
    await cachedEmbedder(env, dir, embed)(["a", "bb"]);
    expect(calls).toEqual([["a", "bb"]]);
  });

  it("embeds again under a different model", async () => {
    const { dir, calls, embed } = setup();
    await cachedEmbedder(env, dir, embed)(["a"]);
    await cachedEmbedder({ ...env, EMBEDDING_MODEL: "other" }, dir, embed)(["a"]);
    expect(calls).toEqual([["a"], ["a"]]);
  });

  it("embeds again at a different width", async () => {
    const { dir, calls, embed } = setup();
    await cachedEmbedder(env, dir, embed)(["a"]);
    await cachedEmbedder({ ...env, EMBEDDING_DIMENSIONS: "768" }, dir, embed)(["a"]);
    expect(calls).toEqual([["a"], ["a"]]);
  });

  it("sends only the misses and answers in input order", async () => {
    const { dir, calls, embed } = setup();
    await cachedEmbedder(env, dir, embed)(["bb"]);
    const vectors = await cachedEmbedder(env, dir, embed)(["a", "bb", "ccc"]);
    expect(calls).toEqual([["bb"], ["a", "ccc"]]);
    expect(vectors).toEqual([
      [1, 1],
      [2, 1],
      [3, 1],
    ]);
  });
});
