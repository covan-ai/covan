import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  embeddingDimensions,
  embeddingModel,
  embedTexts,
  type EmbeddingConfig,
} from "../../src/lib/embeddings";

export type Embedder = (texts: string[]) => Promise<number[][]>;

/**
 * `embedTexts`, remembered on disk. Corpus vectors are cached so that two runs
 * being compared were matched against the same vectors, and so a rerun costs
 * nothing. The key carries the model and the width: a run under another model
 * must never read this one's vectors.
 */
export function cachedEmbedder(
  env: EmbeddingConfig,
  dir: string,
  embed: typeof embedTexts = embedTexts,
): Embedder {
  const model = embeddingModel(env);
  const dimensions = embeddingDimensions(env);
  const fileFor = (text: string) =>
    join(
      dir,
      `${createHash("sha256").update(`${model}\0${dimensions}\0${text}`).digest("hex")}.json`,
    );

  return async (texts) => {
    mkdirSync(dir, { recursive: true });
    const vectors: (number[] | null)[] = texts.map((t) => {
      const file = fileFor(t);
      return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as number[]) : null;
    });
    const misses = texts.filter((_, i) => vectors[i] === null);
    if (misses.length > 0) {
      const fresh = (await embed(env, misses)).vectors;
      let next = 0;
      texts.forEach((text, i) => {
        if (vectors[i] !== null) return;
        vectors[i] = fresh[next++];
        writeFileSync(fileFor(text), JSON.stringify(vectors[i]));
      });
    }
    return vectors as number[][];
  };
}
