export type RetrievedChunk = { documentName: string; content: string };

/**
 * The cosine-similarity floor, below which a chunk is treated as irrelevant.
 *
 * 0.25 is not a universal constant — it was chosen against
 * `text-embedding-3-small`, which scores on-topic content well above it and
 * clearly-unrelated content below it. Another model's scores are distributed
 * differently: too high a floor starves genuine matches, too low a one puts the
 * six nearest-but-irrelevant chunks into every prompt. Neither shows up as an
 * error. Both look like "the answers got worse", which is the hardest kind of
 * regression to attribute, so an operator who moves the model is given the dial
 * that goes with it.
 *
 * `0` is a legitimate value and means no floor at all — the behaviour before
 * migration 0005 added the argument.
 */
export const DEFAULT_RAG_MIN_SIMILARITY = 0.25;

export function ragMinSimilarity(env: { RAG_MIN_SIMILARITY?: string }): number {
  const raw = (env.RAG_MIN_SIMILARITY ?? "").trim();
  if (raw === "") return DEFAULT_RAG_MIN_SIMILARITY;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error(
      `RAG_MIN_SIMILARITY must be a number between 0 and 1 (got ${JSON.stringify(raw)}). ` +
        `It is a cosine similarity, not a percentage.`,
    );
  }
  return n;
}

const HEADER =
  "The team has shared the following knowledge. Use it to ground your answers. " +
  "Answer naturally in your own words — do not cite, quote, or mention the document " +
  "names, filenames, or that these documents were provided; the interface shows " +
  "sources separately:\n\n";

/**
 * Assembles retrieved chunks into a system-prompt context block under a total
 * char budget. Chunks are added newest-relevance-first (caller passes them in
 * similarity order); once the budget is exhausted, remaining chunks are dropped.
 * Returns "" when there is nothing to add (caller then skips the block).
 */
export function buildContextBlock(chunks: RetrievedChunk[], budget = 4000): string {
  if (chunks.length === 0) return "";
  let remaining = budget;
  const blocks: string[] = [];
  for (const ch of chunks) {
    if (remaining <= 0) break;
    const body = ch.content.slice(0, remaining);
    remaining -= body.length;
    blocks.push(`Document: ${ch.documentName}\n${body}`);
  }
  if (blocks.length === 0) return "";
  return HEADER + blocks.join("\n\n---\n\n");
}
