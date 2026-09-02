import type { SupabaseClient } from "@supabase/supabase-js";
import type { EmbeddingConfig } from "./embeddings";
import { embedTexts } from "./embeddings";
import { buildContextBlock, ragMinSimilarity, retrievalQuery } from "./rag";
import { refersToDocuments, namesDocument } from "./doc-question";

/**
 * What an agent knows, assembled for one question.
 *
 * This was inline in `routes/chat.ts` until something else needed to ask an
 * agent a question — a Slack thread, in the first instance. Two copies of
 * retrieval would not have failed loudly; they would have drifted, and the
 * symptom would be the same agent answering the same question well in one
 * surface and badly in the other, with nothing in either place to explain it.
 *
 * Deliberately returns material rather than a prompt. What to do with the
 * block, which model to spend, whether to stream — those belong to the surface,
 * and the two surfaces genuinely differ.
 *
 * The body below is the chat route's, moved rather than rewritten. Every
 * comment in it is about a decision that route made and still makes; what
 * changed is only that the values it reads are now parameters.
 */

/**
 * How many chunks to retrieve.
 *
 * The block is re-sent every turn and rides after the cacheable prefix, so it
 * never caches — keeping the count tight cuts recurring input directly. The
 * floor that goes with it is `ragMinSimilarity`, which is configurable because
 * it is a property of the embedding model rather than of this code.
 */
const RAG_MATCH_COUNT = 6;

export type RetrievedSource = { id: string | null; name: string };

/** One turn of the conversation so far, oldest first. */
export type HistoryTurn = { role: "user" | "assistant"; content: string };

export type Retrieval = {
  /** Every document the agent can see, newest first — the manifest. */
  docNames: string[];
  /** The bundles attached to this agent. */
  bundleIds: string[];
  /** The grounding block, or "" when there is nothing to ground on. */
  ragBlock: string;
  /** What actually grounded it, deduped in relevance order. */
  sources: RetrievedSource[];
  /** Which path produced the block. See the comment on it below. */
  grounding: "chunks" | "documents" | "none";
  /** Embedding tokens spent asking. The caller records them. */
  embeddingTokens: number;
};

export type RetrievalConfig = EmbeddingConfig & { RAG_MIN_SIMILARITY?: string };

/**
 * Retrieve for one question, best-effort.
 *
 * Any failure falls back to persona-only rather than raising: an ungrounded
 * answer beats no answer. That includes a misconfigured EMBEDDING_DIMENSIONS or
 * RAG_MIN_SIMILARITY, which land here as a throw and are logged — `loadEnv` is
 * where a bad value is meant to be caught, at boot, before anybody asks
 * anything.
 *
 * `history` is the whole conversation so far, oldest first, and it is not the
 * same input as `question`: `retrievalQuery` reads the turns before the last
 * one, because a follow-up carries its subject in them.
 */
export async function retrieveForAgent(
  db: SupabaseClient,
  env: RetrievalConfig,
  agentId: string,
  question: string,
  history: HistoryTurn[],
): Promise<Retrieval> {
  // Documents that actually grounded this reply, deduped in relevance order.
  // Persisted with the assistant message so the UI can show real citations.
  /**
   * The documents that grounded this reply, by id as well as by name.
   *
   * Names alone were what the column held until now, and a name is not a link:
   * two documents can share one, a rename detaches every answer that cited it,
   * and a delete leaves a string pointing at nothing. `match_chunks` has
   * returned `document_id` since 0005 and this route was discarding it — so the
   * chat screen could say which file an answer came from and never how old it
   * was. Keyed by id here so a document retrieved through two chunks is cited
   * once.
   */
  const sources = new Map<string, { id: string | null; name: string }>();
  const addSource = (id: string | null, name: string) => {
    if (!name) return;
    const key = id ?? `name:${name}`;
    if (!sources.has(key)) sources.set(key, { id, name });
  };
  // Retrieved knowledge for this turn. Kept OUT of the persona/system prefix and
  // the persisted history so that prefix stays byte-identical across turns and
  // OpenAI's automatic prompt cache can discount the bulk of the input.
  let ragBlock = "";
  /**
   * Which of the two grounding paths below produced `ragBlock`, persisted with
   * the reply (0039) because `sources` cannot tell them apart — both paths fill
   * it, and only the first means a passage the team wrote was close to what was
   * asked. covan#44 reports on the difference.
   *
   * Starts at `"none"` and is narrowed on the way down, so every exit — an
   * agent with no documents, a retrieval that threw, a fallback that found
   * nothing with content — lands on the truthful value without needing its own
   * assignment.
   *
   * `"none"` covers one more case than it did when 0039 landed, and the report
   * should read it as the wider fact rather than as a setup problem. The
   * fallback used to run on *every* miss, so "thanks" and "merhaba" were
   * recorded as `documents` — grounded, by a path that had fired on a turn
   * about nothing. It now runs only when the question is about the documents
   * (`refersToDocuments`), which leaves an ordinary question that cleared no
   * passage recording `none`. That is what `none` should have meant all along:
   * nothing the team wrote was close to this. The two populations it now mixes
   * — no usable documents at all, and none close enough — are told apart by
   * whether the agent has any documents, which the report can ask separately.
   */
  let grounding: "chunks" | "documents" | "none" = "none";
  // Embedding the question costs tokens too. Carried to the end of the turn and
  // recorded with the completion's, so one reply means one counter write.
  let embeddingTokens = 0;

  // Load only the agent's document *names* here (newest first) — that's all the
  // manifest needs so the agent knows what it can see and never denies having
  // files. Stored `content` is deliberately NOT fetched on the hot path: it is
  // only used by the no-match fallback below, so we load it lazily there and
  // avoid pulling every document's full body on every single turn.
  let docNames: string[] = [];
  let bundleIds: string[];
  {
    const { data: bundleRows, error: bundleError } = await db
      .from("agent_bundles")
      .select("bundle_id")
      .eq("agent_id", agentId);
    bundleIds = bundleError
      ? []
      : (bundleRows ?? []).map((r: { bundle_id: string }) => r.bundle_id);
    if (bundleIds.length > 0) {
      const { data: docRows, error: docError } = await db
        .from("documents")
        .select("name")
        .in("bundle_id", bundleIds)
        .order("created_at", { ascending: false });
      if (!docError) {
        docNames = (docRows ?? []).map((r: { name: string }) => r.name);
      }
    }
  }
  const hasKnowledge = docNames.length > 0;

  // Semantic retrieval over the bundles attached to this agent. Best-effort:
  // any failure falls back to persona-only so the reply is never blocked. That
  // includes a misconfigured EMBEDDING_DIMENSIONS or RAG_MIN_SIMILARITY, which
  // land here as a throw and are logged rather than 500'd — an ungrounded
  // answer beats no answer, and `loadEnv` is where a bad value is meant to be
  // caught, at boot, before anybody asks anything.
  if (hasKnowledge) {
    try {
      // Not `question` alone: a follow-up carries its subject in the
      // turn before it, and a pasted wall of text is longer than the embedding
      // model's own context window. See `retrievalQuery`.
      const query = retrievalQuery(
        history.map((m: { role: string; content: string }) => ({
          role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
          content: m.content,
        })),
      );
      const embedded = await embedTexts(env, [query]);
      embeddingTokens += embedded.tokens;
      const [queryEmbedding] = embedded.vectors;
      if (queryEmbedding) {
        const { data: matches, error: matchError } = await db.rpc("match_chunks", {
          p_agent_id: agentId,
          p_query_embedding: queryEmbedding,
          p_match_count: RAG_MATCH_COUNT,
          p_min_similarity: ragMinSimilarity(env),
        });
        if (matchError) {
          console.error("match_chunks failed", matchError);
        } else if (matches && matches.length > 0) {
          const typed = matches as Array<{
            document_id: string;
            document_name: string;
            content: string;
          }>;
          // Cited from `used`, not from `typed`: the block has a char budget and
          // drops what does not fit, and a document whose passage was dropped
          // did not ground anything.
          const block = buildContextBlock(
            typed.map((m) => ({
              documentId: m.document_id,
              documentName: m.document_name,
              content: m.content,
            })),
          );
          ragBlock = block.text;
          if (ragBlock) grounding = "chunks";
          for (const m of block.used) addSource(m.documentId ?? null, m.documentName);
        }
      }
    } catch (e) {
      console.error("retrieval failed (continuing persona-only)", e);
    }
  }

  // Fallback: no chunk matched, the agent does have documents, and the question
  // is about them — "summarize the file", "what's in the doc", or anything that
  // names one. Those don't embed close to any single passage, so retrieval
  // misses them however the floor is set; grounding on the documents' stored
  // text directly is what stops the agent claiming it can't read a file it was
  // just handed.
  //
  // `refersToDocuments` is the guard, and it is the whole point of the branch.
  // Without it every miss landed here — "thanks", "merhaba", "say that again" —
  // and each one pulled the agent's files into the prompt, paid for them, and
  // hung a row of source chips under an answer they had nothing to do with.
  if (!ragBlock && hasKnowledge && refersToDocuments(question, docNames)) {
    const { data: docRows, error: docError } = await db
      .from("documents")
      .select("id,name,content")
      .in("bundle_id", bundleIds)
      .order("created_at", { ascending: false });
    const withContent = docError
      ? []
      : ((docRows ?? []) as Array<{ id: string; name: string; content: string | null }>).filter(
          (d) => d.content && d.content.trim().length > 0,
        );
    // Newest-first is the right default and the wrong answer when the user
    // named a file: the budget fills from the front, so "what does handbook.md
    // say?" against a dozen documents could ground on the three most recent
    // uploads and never reach the one that was asked about. A document the
    // question names goes first.
    const ordered = [
      ...withContent.filter((d) => namesDocument(question, d.name)),
      ...withContent.filter((d) => !namesDocument(question, d.name)),
    ];
    if (ordered.length > 0) {
      const block = buildContextBlock(
        ordered.map((d) => ({
          documentId: d.id,
          documentName: d.name,
          content: d.content as string,
        })),
      );
      ragBlock = block.text;
      if (ragBlock) grounding = "documents";
      for (const d of block.used) addSource(d.documentId ?? null, d.documentName);
    }
  }


  return {
    docNames,
    bundleIds,
    ragBlock,
    sources: [...sources.values()],
    grounding,
    embeddingTokens,
  };
}
