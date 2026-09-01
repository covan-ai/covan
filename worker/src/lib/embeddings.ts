import { createEmbeddingClient } from "./openai";

/**
 * What an install that has never thought about this gets: OpenAI's model, at
 * the width `public.document_chunks.embedding` is declared with in migration
 * 0004. Both are defaults rather than constants now, because a self-hosted
 * Covan that keeps its completions in-house and ships every uploaded document
 * to OpenAI anyway has only solved the smaller half of the problem.
 */
export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
export const DEFAULT_EMBEDDING_DIMENSIONS = 1536;

/** Everything `embedTexts` reads off the environment. */
export type EmbeddingConfig = {
  OPENAI_API_KEY: string;
  EMBEDDING_BASE_URL?: string;
  EMBEDDING_MODEL?: string;
  EMBEDDING_DIMENSIONS?: string;
};

/** Which model embeds. Unset means OpenAI's, whatever the endpoint is. */
export function embeddingModel(env: { EMBEDDING_MODEL?: string }): string {
  return env.EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL;
}

/**
 * How wide a vector this database can store.
 *
 * Not a preference — a fact about the schema. `document_chunks.embedding` is
 * `vector(N)` and the HNSW index and `match_chunks` are both declared at that
 * same N, so this number and the SQL have to agree or nothing works. It is a
 * variable rather than a constant only because the operator can change the SQL:
 * `supabase/optional/embedding_width.sql`.
 *
 * Throws rather than falling back, and `lib/env.ts` calls it at boot so a
 * Docker stack fails on startup instead of on somebody's first upload. A
 * typo'd width that silently reverted to 1536 would let a 768-dimension model
 * through as far as the insert, which is exactly the failure this whole change
 * exists to remove.
 */
export function embeddingDimensions(env: { EMBEDDING_DIMENSIONS?: string }): number {
  const raw = (env.EMBEDDING_DIMENSIONS ?? "").trim();
  if (raw === "") return DEFAULT_EMBEDDING_DIMENSIONS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `EMBEDDING_DIMENSIONS must be a positive whole number (got ${JSON.stringify(raw)}). ` +
        `It has to match the width public.document_chunks.embedding was declared with — ` +
        `see supabase/optional/embedding_width.sql.`,
    );
  }
  return n;
}

// Return the index just past the latest occurrence of `sep` in [from, hardEnd),
// or -1 if it doesn't occur there. Breaking *after* the separator keeps it with
// the preceding chunk (the piece is trimmed later).
function lastSepEnd(text: string, sep: string, from: number, hardEnd: number): number {
  const at = text.lastIndexOf(sep, hardEnd - sep.length);
  if (at >= from && at + sep.length <= hardEnd) return at + sep.length;
  return -1;
}

// Return the index just past the latest sentence terminator (. ! ?) that is
// followed by whitespace, within [from, hardEnd), or -1.
function lastSentenceEnd(text: string, from: number, hardEnd: number): number {
  for (let i = hardEnd - 2; i >= from; i--) {
    const ch = text[i];
    if ((ch === "." || ch === "!" || ch === "?") && /\s/.test(text[i + 1] ?? "")) {
      return i + 1;
    }
  }
  return -1;
}

// Choose where to end a chunk that starts at `start`. Prefer the strongest
// natural boundary (paragraph > sentence > line > word) in the back half of the
// window, so we don't cut mid-sentence/mid-word. Falls back to a hard cut only
// when no boundary exists (e.g. a single unbroken token).
function findBreakEnd(text: string, start: number, hardEnd: number): number {
  const floor = start + Math.floor((hardEnd - start) / 2);
  const para = lastSepEnd(text, "\n\n", floor, hardEnd);
  if (para > start) return para;
  const sentence = lastSentenceEnd(text, floor, hardEnd);
  if (sentence > start) return sentence;
  const line = lastSepEnd(text, "\n", floor, hardEnd);
  if (line > start) return line;
  const word = lastSepEnd(text, " ", floor, hardEnd);
  if (word > start) return word;
  return hardEnd;
}

// Where the next chunk begins: roughly `overlap` chars before `end`, snapped
// back to a word boundary so the shared context starts on a whole word. Always
// advances past `start` so chunking terminates.
function nextStart(text: string, start: number, end: number, overlap: number): number {
  const target = Math.max(start + 1, end - overlap);
  let s = target;
  while (s > start && !/\s/.test(text[s - 1] ?? "")) s--;
  if (s <= start) s = target;
  return Math.max(start + 1, s);
}

/**
 * Structure-aware chunking (no tokenizer dependency). Produces chunks up to
 * `size` chars that break on natural boundaries — paragraphs, then sentences,
 * then lines, then words — instead of slicing blindly mid-word. Consecutive
 * chunks share ~`overlap` chars of context, snapped to a word boundary. Trims
 * input; empty -> [].
 */
export function chunkText(text: string, size = 1000, overlap = 150): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length <= size) return [trimmed];

  const chunks: string[] = [];
  let start = 0;
  while (start < trimmed.length) {
    const hardEnd = Math.min(start + size, trimmed.length);
    const end = hardEnd < trimmed.length ? findBreakEnd(trimmed, start, hardEnd) : hardEnd;
    const piece = trimmed.slice(start, end).trim();
    if (piece.length > 0) chunks.push(piece);
    if (end >= trimmed.length) break;
    start = nextStart(trimmed, start, end, overlap);
  }
  return chunks;
}

export type EmbeddingResult = {
  /** Vectors in input order. */
  vectors: number[][];
  /** What the call cost, for usage accounting. */
  tokens: number;
};

/**
 * How many chunks go in one embeddings request.
 *
 * OpenAI caps a single call at 2,048 array items AND 300,000 tokens, and the
 * second limit binds first: `chunkText` emits ~1,000-char chunks, so 2,048 of
 * them is roughly 512k tokens. 128 chunks is about 32k tokens — an order of
 * magnitude inside both ceilings, which leaves room for a caller that raises
 * the chunk size without having to think about this number.
 *
 * Before this existed, a 1 MB document produced ~1,454 chunks in one request,
 * the request 400'd, and `bundles.ts` swallowed the error and reported the
 * upload as successful. The document was listed, named to the model, and
 * unretrievable.
 */
export const EMBED_BATCH_SIZE = 128;

/**
 * Embeds each input string. Returns vectors in input order (OpenAI guarantees
 * response ordering by `index`; we sort defensively within each batch, and
 * batches are appended in order). Throws on API error.
 *
 * The token count comes back alongside the vectors because embedding is real
 * spend — a large document costs more to index than a long conversation costs
 * to answer — and a usage counter that ignored it would leave uploads free.
 * Batches are summed, so the caller still records one total.
 *
 * Takes the environment rather than a bare key, which is the whole point: the
 * key alone cannot say where the request goes, and "where the request goes" is
 * the difference between a self-hosted Covan that keeps its documents and one
 * that only keeps its conversations.
 */
export async function embedTexts(env: EmbeddingConfig, texts: string[]): Promise<EmbeddingResult> {
  if (texts.length === 0) return { vectors: [], tokens: 0 };
  const openai = createEmbeddingClient(env);
  const model = embeddingModel(env);
  const dimensions = embeddingDimensions(env);

  const vectors: number[][] = [];
  let tokens = 0;

  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
    const res = await openai.embeddings.create({ model, input: batch });
    for (const d of res.data.slice().sort((a, b) => a.index - b.index)) {
      const vector = d.embedding as number[];
      // Checked here, where the endpoint is still nameable, rather than left to
      // Postgres. A vector of the wrong width does not fail at the request — it
      // fails at the insert, and both callers that upload treat an insert
      // failure as "document saved, just not indexed". So the operator's real
      // symptom would be documents that upload fine and answer nothing, with a
      // constraint error in a log they have no reason to be reading.
      if (vector.length !== dimensions) {
        throw new Error(
          `Embedding model ${model} at ${env.EMBEDDING_BASE_URL || "api.openai.com"} returned ` +
            `${vector.length} dimensions, but this database stores ${dimensions}. ` +
            `Either point EMBEDDING_MODEL at a model of that width, or change the width — ` +
            `supabase/optional/embedding_width.sql, then set EMBEDDING_DIMENSIONS to match ` +
            `and re-embed via POST /admin/backfill-embeddings.`,
        );
      }
      vectors.push(vector);
    }
    tokens += res.usage?.total_tokens ?? 0;
  }

  return { vectors, tokens };
}
