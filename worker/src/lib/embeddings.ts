import OpenAI from "openai";

export const EMBEDDING_MODEL = "text-embedding-3-small";

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
 */
export async function embedTexts(apiKey: string, texts: string[]): Promise<EmbeddingResult> {
  if (texts.length === 0) return { vectors: [], tokens: 0 };
  const openai = new OpenAI({ apiKey });

  const vectors: number[][] = [];
  let tokens = 0;

  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
    const res = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: batch });
    for (const d of res.data.slice().sort((a, b) => a.index - b.index)) {
      vectors.push(d.embedding as number[]);
    }
    tokens += res.usage?.total_tokens ?? 0;
  }

  return { vectors, tokens };
}
