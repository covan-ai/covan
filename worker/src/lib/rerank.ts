import { complete, type CompletionEnv } from "./completion";
import { completionSpend, type Spend } from "./entitlements";
import type { RetrievedChunk } from "./rag";

/**
 * A second look at what the search found, by a model that reads the question
 * and every candidate together.
 *
 * The search ranks by two cheap signals — how close a passage's vector is,
 * and whether it shares words with the question — fused by position. Neither
 * reads the passage. So a Turkish question whose answer is in an English
 * document loses to a Turkish passage that merely shares its words, and a
 * question the documents cannot answer still gets its nearest neighbours cited.
 * The retrieval benchmark (`eval/retrieval/`) measured both.
 *
 * This only ever reorders and trims the list it is given. Postgres decided what
 * the caller may read before any of it got here; nothing is added.
 */

/** How many candidates the search hands over when a reranker will read them. */
export const RERANK_CANDIDATES = 30;

/**
 * How much of each passage the reranker reads. Enough to judge relevance;
 * passages are ~1000 characters, and thirty of them whole is most of the cost.
 */
const PASSAGE_CHARS = 700;

/**
 * Generous for a list of thirty small numbers, and short enough that a hung
 * call does not hold the turn: retrieval runs before the reply starts.
 */
const RERANK_TIMEOUT_MS = 8_000;

const RERANK_MAX_TOKENS = 200;

export function buildRerankMessages(
  query: string,
  passages: RetrievedChunk[],
): { role: "system" | "user"; content: string }[] {
  const numbered = passages
    .map((p, i) => `[${i + 1}] ${p.documentName}\n${p.content.slice(0, PASSAGE_CHARS).trim()}`)
    .join("\n\n");
  return [
    {
      role: "system",
      content:
        "You judge whether passages from a team's documents help answer a question. " +
        "The question and the passages may be in different languages (often Turkish and English); " +
        "judge meaning, not shared words. Score every passage: " +
        "3 = answers the question, 2 = partly answers it, 1 = on the topic but does not answer, " +
        "0 = unrelated. Respond ONLY with JSON of the exact shape " +
        '{"scores":{"<passage number>":<score>}}, listing only passages scored 1 or higher ' +
        '— for example {"scores":{"4":3,"11":1}}, or {"scores":{}} when none helps.',
    },
    { role: "user", content: `Question: ${query}\n\nPassages:\n\n${numbered}` },
  ];
}

/**
 * The model's scores as one number per passage, or null for a reply that is
 * not the shape asked for.
 *
 * Keyed by passage number, listing only the ones that bear on the question,
 * because a model asked for a list of thirty numbers miscounts it: in the
 * benchmark gpt-5-nano returned the wrong length on most cases. A passage it
 * does not name is unrelated; a number outside the list is ignored rather
 * than costing the whole answer.
 */
export function parseRerankScores(raw: string, count: number): number[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const named = (parsed as { scores?: unknown } | null)?.scores;
  if (typeof named !== "object" || named === null || Array.isArray(named)) return null;
  const scores = new Array<number>(count).fill(0);
  for (const [key, value] of Object.entries(named)) {
    if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 3) return null;
    const n = Number(key);
    if (Number.isInteger(n) && n >= 1 && n <= count) scores[n - 1] = value as number;
  }
  return scores;
}

export type Reranked = {
  /** At most `keep`, best first; unrelated ones dropped. */
  passages: RetrievedChunk[];
  /** What the call cost, whether or not its answer was usable. */
  spend: Spend | null;
  /** False when the search's own order was kept because the reranker failed. */
  reranked: boolean;
};

/**
 * Never throws. A reranker that fails leaves the search's order, cut to
 * `keep` — exactly what retrieval returned before there was a reranker.
 */
export async function rerankPassages(
  env: CompletionEnv,
  model: string,
  query: string,
  passages: RetrievedChunk[],
  keep: number,
): Promise<Reranked> {
  const fallback = (spend: Spend | null): Reranked => ({
    passages: passages.slice(0, keep),
    spend,
    reranked: false,
  });
  if (passages.length === 0) return { passages: [], spend: null, reranked: false };

  try {
    const { text, usage } = await complete(
      env,
      {
        model,
        messages: buildRerankMessages(query, passages),
        json: true,
        reasoningEffort: "minimal",
        maxTokens: RERANK_MAX_TOKENS,
      },
      { signal: AbortSignal.timeout(RERANK_TIMEOUT_MS) },
    );
    const spend = completionSpend(model, usage, "rerank");
    const scores = parseRerankScores(text, passages.length);
    if (!scores) {
      console.error("rerank reply unusable (keeping the search's order)", text.slice(0, 200));
      return fallback(spend);
    }
    const ordered = passages
      .map((p, i) => ({ p, i, score: scores[i] }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .slice(0, keep)
      .map((x) => x.p);
    return { passages: ordered, spend, reranked: true };
  } catch (err) {
    console.error("rerank failed (keeping the search's order)", err);
    return fallback(null);
  }
}
