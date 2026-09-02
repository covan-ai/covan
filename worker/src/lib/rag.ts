export type RetrievedChunk = {
  /**
   * The document this passage came from. Optional only because one caller
   * (the whole-document fallback) has the row rather than a chunk; when it is
   * absent the citation falls back to the name, which is what pre-0005 replies
   * already do.
   */
  documentId?: string | null;
  documentName: string;
  content: string;
};

/**
 * What went into the prompt, and what may therefore be cited.
 *
 * `used` is the point of this type. The block has a char budget and drops
 * whatever does not fit, so the list of candidates and the list of documents
 * that actually grounded the answer are different lists — and the caller was
 * citing the first one. An agent with a dozen files answered every question
 * with a dozen source chips, most of them naming text the model never saw.
 */
export type ContextBlock = { text: string; used: RetrievedChunk[] };

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

/**
 * Below this length a question is treated as a follow-up rather than a question
 * that stands on its own. "peki ikinci maddesi?" is 20 characters and means
 * nothing to an embedding model; the turn before it is where its subject is.
 */
const FOLLOW_UP_CHARS = 80;

/** How much of the preceding question to carry, when one is carried. */
const ANTECEDENT_CHARS = 400;

/**
 * Hard cap on what is embedded. The embedding models have a context window of
 * their own (8k tokens for text-embedding-3-small), and a pasted contract sails
 * past it — the call 400s, `chat.ts` catches it as "retrieval failed", and the
 * answer comes back ungrounded with nothing on screen to say why. The first
 * few thousand characters of a question are the question anyway.
 */
const QUERY_CHARS = 4000;

/**
 * The text to embed for this turn's retrieval.
 *
 * The latest message alone is the obvious choice and it is wrong for exactly
 * the questions people ask most in a conversation: "and the second one?",
 * "peki ya maliyeti?", "why?". They carry no nouns, so they embed near nothing,
 * so retrieval returns nothing, so the agent loses the thread halfway through a
 * conversation about a document it had been reading correctly. Short turns get
 * the previous question prepended to supply the missing subject; long ones
 * stand on their own and are left alone, since padding them would only dilute
 * the vector.
 *
 * `turns` arrive oldest-first, ending with the message being answered.
 */
export function retrievalQuery(turns: { role: "user" | "assistant"; content: string }[]): string {
  const latest = turns[turns.length - 1];
  if (!latest) return "";
  const question = latest.content.trim();
  if (question.length >= FOLLOW_UP_CHARS) return question.slice(0, QUERY_CHARS);

  const antecedent = turns
    .slice(0, -1)
    .reverse()
    .find((t) => t.role === "user" && t.content.trim().length > 0);
  if (!antecedent) return question.slice(0, QUERY_CHARS);

  return `${antecedent.content.trim().slice(0, ANTECEDENT_CHARS)}\n${question}`.slice(
    0,
    QUERY_CHARS,
  );
}

const HEADER =
  "The team has shared the following knowledge. Use it to ground your answers. " +
  "Answer naturally in your own words — do not cite, quote, or mention the document " +
  "names, filenames, or that these documents were provided; the interface shows " +
  "sources separately:\n\n";

const SEPARATOR = "\n\n---\n\n";
const TRUNCATION_MARK = "\n…[truncated]";

/**
 * The least amount of a passage worth sending. Below this a chunk is a
 * sentence fragment: it cannot answer anything, it still costs its framing,
 * and — the part that actually mattered — it still put the document's name in
 * the citations, so an answer claimed a source on the strength of forty
 * characters the model could not use.
 */
const MIN_USEFUL_EXCERPT = 200;

/**
 * Assembles retrieved chunks into a system-prompt context block under a total
 * char budget, and reports which of them fitted.
 *
 * Chunks are added most-relevant-first (the caller passes them in similarity
 * order) and the budget covers the whole block — header, per-document framing
 * and separators included, which it did not before, so a block asked for 4000
 * chars no longer returns 4300. Once what is left cannot hold a useful excerpt
 * the rest are dropped rather than admitted as fragments; they are the least
 * relevant ones by construction.
 *
 * `text` is "" when nothing fits, and `used` is empty with it — the caller
 * skips the block and cites nothing.
 */
export function buildContextBlock(chunks: RetrievedChunk[], budget = 4000): ContextBlock {
  const empty: ContextBlock = { text: "", used: [] };
  if (chunks.length === 0) return empty;

  let remaining = budget - HEADER.length;
  const blocks: string[] = [];
  const used: RetrievedChunk[] = [];

  for (const ch of chunks) {
    const content = ch.content.trim();
    if (!content || !ch.documentName) continue;

    const frame =
      `Document: ${ch.documentName}\n`.length + (blocks.length > 0 ? SEPARATOR.length : 0);
    const room = remaining - frame;
    // A short document is admitted whole whenever there is room for it; a long
    // one only when enough of it survives to be worth reading.
    if (room < Math.min(MIN_USEFUL_EXCERPT, content.length)) break;

    let body: string;
    if (content.length <= room) {
      body = content;
    } else {
      const keep = Math.max(0, room - TRUNCATION_MARK.length);
      if (keep < MIN_USEFUL_EXCERPT) break;
      body = content.slice(0, keep) + TRUNCATION_MARK;
    }

    remaining -= frame + body.length;
    blocks.push(`Document: ${ch.documentName}\n${body}`);
    used.push(ch);
  }

  if (blocks.length === 0) return empty;
  return { text: HEADER + blocks.join(SEPARATOR), used };
}
