import type { SupabaseClient } from "@supabase/supabase-js";
import type { EmbeddingConfig } from "./embeddings";
import { embedTexts } from "./embeddings";
import {
  buildContextBlock,
  citable,
  DEFAULT_RAG_MIN_SIMILARITY,
  RAG_BLOCK_CHARS,
  ragMinSimilarity,
  retrievalQuery,
} from "./rag";
import type { RetrievedChunk } from "./rag";
import { nearestPassages, passageIndex, type PassageEnv } from "./passages";
import { refersToDocuments, namesDocument } from "./doc-question";
import { lexicalSearchEnabled, searchTerms } from "./search-terms";

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
 * How many chunks to *consider*. What reaches the prompt is decided after this,
 * by `buildContextBlock`'s char budget.
 *
 * That distinction is why this went from 6 to 10 without costing a token. The
 * block is re-sent every turn and rides after the cacheable prefix, so it never
 * caches, and keeping it tight cuts recurring input directly — but the thing
 * keeping it tight is the 4000-char budget, not this number. Six candidates
 * frequently could not fill that budget while a seventh, perfectly relevant
 * passage sat just outside the list; and now that near-duplicates are dropped
 * rather than admitted (see `buildContextBlock`), a short list could be spent
 * entirely on two copies of one passage.
 *
 * The cost of the four extra candidates is one wider `limit` in a query that
 * already ran, over an HNSW index. The floor that goes with it is
 * `ragMinSimilarity`, which is configurable because it is a property of the
 * embedding model rather than of this code.
 */
const RAG_MATCH_COUNT = 10;

/**
 * How much of a named document's stored text may sit in front of the passages
 * that matched.
 *
 * Half of `buildContextBlock`'s 4000-char budget. The document is admitted for
 * being named rather than for being relevant to the sentence, so it earns a
 * place at the front and not the whole room: uncapped, one 8000-character
 * document would fill the budget and break out of the loop before a single
 * matched passage was read.
 */
const STORED_SHARE = 2000;

/**
 * The budget when the question is about one document by name and no passage
 * matched it — "summarise handbook.md", "what does the contract say".
 *
 * The ordinary budget (`RAG_BLOCK_CHARS`) is kept small on purpose, because it
 * is paid on every turn; this one is paid only when somebody asks for a
 * document by name, which is exactly when reading more of it is the answer.
 * It used to be the 8,000-character excerpt cut to 4,000: "summarise the
 * contract" summarised its first two pages.
 */
const NAMED_DOCUMENT_CHARS = 12_000;

/** How many documents the no-match fallback reads, newest first. */
const FALLBACK_DOCUMENTS = 20;

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

/**
 * Whose knowledge this answer may stand on (0106).
 *
 * A private bundle grounds its owner's turns and nobody else's. Through a
 * person's own client the policies already hide everybody else's private
 * bundles; what has to be said here is the rest:
 *
 * - `sharedOnly` — shared bundles only, for a reply other people can read: a
 *   shared conversation, a Slack thread, a shared routine's report. The
 *   asker's own private bundles are left out too, or one person's private file
 *   would be quoted to everybody reading along.
 * - `viewer` — shared bundles and this person's own, for the service-role
 *   paths that act for one person (a private routine). Without it the service
 *   role, which no policy filters, would read everybody's.
 */
export type KnowledgeScope = { viewer?: string; sharedOnly?: boolean };

export type RetrievalConfig = EmbeddingConfig &
  PassageEnv & {
    RAG_MIN_SIMILARITY?: string;
    RAG_LEXICAL?: string;
  };

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
  scope: KnowledgeScope = {},
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
   * it, and only the first means a passage actually matched the question,
   * either because the vector arm found it close in meaning or because the
   * lexical arm found it close in wording (0049) — either arm firing is enough.
   * covan#44 reports on the difference.
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
   * (`refersToDocuments`), which leaves an ordinary question that matched no
   * passage, by meaning or by wording, recording `none`. That is what `none`
   * should have meant all along: nothing the team wrote matched this. The two
   * populations it now mixes — no usable documents at all, and no match at all
   * — are told apart by whether the agent has any documents, which the report
   * can ask separately.
   */
  let grounding: "chunks" | "documents" | "none" = "none";
  /** Passages `match_chunks` returned, before the char budget has had a say. */
  let matched: RetrievedChunk[] = [];
  /** Whole-document text admitted alongside them, if any. */
  let storedUsed: RetrievedChunk[] = [];
  // Embedding the question costs tokens too. Carried to the end of the turn and
  // recorded with the completion's, so one reply means one counter write.
  let embeddingTokens = 0;
  /** What the block may hold. Raised only for a document asked for by name. */
  let budget = RAG_BLOCK_CHARS;

  // Load only the agent's document *names* here (newest first) — that's all the
  // manifest needs so the agent knows what it can see and never denies having
  // files. Stored `content` is deliberately NOT fetched on the hot path: it is
  // only used by the no-match fallback below, so we load it lazily there and
  // avoid pulling every document's full body on every single turn.
  let docNames: string[] = [];

  const { data: bundleRows, error: bundleError } = await db
    .from("agent_bundles")
    .select("bundle_id")
    .eq("agent_id", agentId);
  const attached = bundleError
    ? []
    : (bundleRows ?? []).map((r: { bundle_id: string }) => r.bundle_id);
  const bundleIds = await readableBundles(db, attached, scope);

  if (bundleIds.length > 0) {
    // Without the trashed ones. Through a person's own client the policy
    // hides them; Slack and routines read with the service role, and a
    // document in Recently Deleted was still named to the model there.
    const { data: docRows, error: docError } = await db
      .from("documents")
      .select("name")
      .in("bundle_id", bundleIds)
      .is("deleted_at", null)
      .order("created_at", { ascending: false });
    if (!docError) docNames = (docRows ?? []).map((r: { name: string }) => r.name);
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
      //
      // With no history the question is the only turn there is. The agent's
      // own `search_documents` call and a routine's retrieval both pass none,
      // and `retrievalQuery([])` is "" — so both used to embed an empty string
      // and send no terms, and every search they ran came back with whatever
      // sat nearest to nothing.
      const turns: HistoryTurn[] =
        history.length > 0 ? history : [{ role: "user", content: question }];
      const query = retrievalQuery(
        turns.map((m: { role: string; content: string }) => ({
          role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
          content: m.content,
        })),
      );
      const embedded = await embedTexts(env, [query]);
      embeddingTokens += embedded.tokens;
      const [queryEmbedding] = embedded.vectors;
      if (queryEmbedding) {
        const shared = {
          p_agent_id: agentId,
          p_match_count: RAG_MATCH_COUNT,
          p_min_similarity: ragMinSimilarity(env),
          p_query_terms: lexicalSearchEnabled(env) ? searchTerms(query) : [],
          // Only when there is something to narrow by, so a call through a
          // person's own client sends exactly what it always did.
          ...(scope.viewer ? { p_viewer: scope.viewer } : {}),
          ...(scope.sharedOnly ? { p_shared_only: true } : {}),
        };
        const index = passageIndex(env);
        const { data: matches, error: matchError } = index
          ? await db.rpc("match_passages_ranked", {
              ...shared,
              ...(await nearestFromIndex(index, queryEmbedding, bundleIds)),
            })
          : await db.rpc("match_chunks", { ...shared, p_query_embedding: queryEmbedding });
        if (matchError) {
          console.error("match_chunks failed", matchError);
        } else if (matches && matches.length > 0) {
          const typed = matches as Array<{
            document_id: string;
            document_name: string;
            content: string;
            similarity: number | null;
          }>;
          // Held rather than built into a block here. A document the question
          // named by name may still have to be merged in below, and one block
          // assembled once is the only way the char budget can weigh the two
          // against each other.
          matched = typed.map((m) => ({
            documentId: m.document_id,
            documentName: m.document_name,
            content: m.content,
            // `null` from the lexical arm alone; see `citable`.
            similarity: typeof m.similarity === "number" ? m.similarity : null,
          }));
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
  // A document the question named that no passage of came back.
  //
  // Which is not only the "retrieval found nothing" case. A document can have no
  // chunks at all — a report, which is written without embeddings on purpose,
  // and an upload whose embedding failed — and then no question can ever match
  // a passage of it. While this branch ran only on a total miss, such a document
  // was reachable exactly as long as nothing *else* matched, which on an agent
  // that has documents is almost never. Asked about by name, it answered "the
  // excerpt did not come" and was right: it had been named in the manifest and
  // was the one thing that could not get in.
  const matchedNames = new Set(matched.map((m) => m.documentName));
  const namedAndUnmatched = docNames.some(
    (name) => namesDocument(question, name) && !matchedNames.has(name),
  );

  if (
    hasKnowledge &&
    (matched.length === 0 || namedAndUnmatched) &&
    refersToDocuments(question, docNames)
  ) {
    // The trashed ones excluded here too, for the reason the name list gives:
    // with the service role nothing else would, and this hands the model a
    // deleted document's whole text.
    //
    // Bounded: an agent with five hundred files used to load every excerpt —
    // four megabytes — to use the first few. The named ones are fetched by
    // name, so an old file asked for by name is never behind the newest twenty.
    const named = docNames.filter((name) => namesDocument(question, name));
    const [newest, byName] = await Promise.all([
      db
        .from("documents")
        .select("id,name,content")
        .in("bundle_id", bundleIds)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(FALLBACK_DOCUMENTS),
      named.length > 0
        ? db
            .from("documents")
            .select("id,name,content")
            .in("bundle_id", bundleIds)
            .is("deleted_at", null)
            .in("name", named)
        : Promise.resolve({ data: [], error: null }),
    ]);
    const seen = new Set<string>();
    const withContent = [
      ...((byName.error ? [] : byName.data) ?? []),
      ...((newest.error ? [] : newest.data) ?? []),
    ]
      .filter((d: { id: string }) => (seen.has(d.id) ? false : (seen.add(d.id), true)))
      .filter(
        (d: { content: string | null }) => d.content && d.content.trim().length > 0,
      ) as Array<{
      id: string;
      name: string;
      content: string;
    }>;
    // Newest-first is the right default and the wrong answer when the user
    // named a file: the budget fills from the front, so "what does handbook.md
    // say?" against a dozen documents could ground on the three most recent
    // uploads and never reach the one that was asked about. A document the
    // question names goes first.
    const ordered = [
      ...withContent.filter((d) => namesDocument(question, d.name)),
      ...withContent.filter((d) => !namesDocument(question, d.name)),
    ];

    // With passages in hand, only the named document is added — the rest of the
    // library is not more relevant than a passage that actually matched, and
    // dumping it here would be the newest-few-thousand-characters behaviour this
    // branch's guard exists to prevent. With no passages, nothing else is on
    // offer, so the whole ordered list stands as it always has.
    const storedDocs =
      matched.length === 0 ? ordered : ordered.filter((d) => namesDocument(question, d.name));

    const stored: RetrievedChunk[] = storedDocs.map((d) => ({
      documentId: d.id,
      documentName: d.name,
      // A whole document alongside relevance-ranked passages is capped, because
      // the budget fills from the front and one 8000-character document placed
      // first would leave nothing for the passages behind it. Uncapped when it
      // is the only thing there is, which is where this branch started.
      content:
        matched.length === 0 ? (d.content as string) : (d.content as string).slice(0, STORED_SHARE),
    }));

    // One document asked for by name, and nothing matched: read it in order,
    // from its passages, rather than from the excerpt on the row.
    const subject =
      matched.length === 0 ? storedDocs.filter((d) => namesDocument(question, d.name)) : [];
    if (subject.length === 1) {
      const fuller = await orderedText(db, subject[0].id, NAMED_DOCUMENT_CHARS);
      if (fuller.length > stored[0].content.length) {
        stored[0] = { ...stored[0], content: fuller };
      }
      budget = NAMED_DOCUMENT_CHARS;
    }

    if (stored.length > 0) storedUsed = stored;
  }

  // One block, assembled once, so the budget can weigh a named document against
  // the passages that matched. Stored text goes first: being named by the person
  // asking is the strongest relevance signal there is, stronger than a
  // similarity score, and it is capped above so going first cannot starve the
  // rest.
  const entries = [...storedUsed, ...matched];
  if (entries.length > 0) {
    const block = buildContextBlock(entries, budget);
    ragBlock = block.text;
    if (ragBlock) {
      // Truthful for the mixed case too: `chunks` answers "did a passage
      // actually match this question", and if any admitted entry came from
      // `matched`, one did. covan#44 reads it that way.
      const matchedSet = new Set(matched);
      grounding = block.used.some((u) => matchedSet.has(u)) ? "chunks" : "documents";
    }
    // What the model read and what the answer is shown as coming from are two
    // lists. The block holds everything above the floor that fit; the chips
    // hold only what clearly bears on the question (`citable`).
    for (const u of citable(block.used, citationFloor(env))) {
      addSource(u.documentId ?? null, u.documentName);
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

/**
 * The vector arm, from the passage index (0116), as `match_passages_ranked`
 * takes it. Postgres decides what of it the caller may read.
 *
 * An index that cannot be reached is an empty arm, not a failed search: the
 * words still find what they find, which is what a deployment without
 * embeddings at all gets.
 */
async function nearestFromIndex(
  index: NonNullable<ReturnType<typeof passageIndex>>,
  queryEmbedding: number[],
  bundleIds: string[],
): Promise<{ p_vector_ids: string[]; p_vector_similarities: number[] }> {
  try {
    const near = await nearestPassages(index, queryEmbedding, bundleIds, RAG_MATCH_COUNT * 4);
    return {
      p_vector_ids: near.map((n) => n.id),
      p_vector_similarities: near.map((n) => n.similarity),
    };
  } catch (err) {
    console.error("passage index query failed (searching by words alone)", err);
    return { p_vector_ids: [], p_vector_similarities: [] };
  }
}

/**
 * The attached bundles this answer may read, by `scope`.
 *
 * The manifest of document names and the stored-text fallback read documents
 * by bundle, so they need the same narrowing `match_chunks` does in SQL: a
 * private bundle's file names are as much its contents as its passages are.
 * With no scope, every attached bundle the client can see — the policies have
 * already decided for a person's own client.
 */
async function readableBundles(
  db: SupabaseClient,
  attached: string[],
  scope: KnowledgeScope,
): Promise<string[]> {
  if (attached.length === 0 || (!scope.viewer && !scope.sharedOnly)) return attached;
  const { data, error } = await db
    .from("knowledge_bundles")
    .select("id,scope,created_by")
    .in("id", attached);
  // Unreadable is nothing, not everything: the failure that grounds a shared
  // reply on somebody's private file is the one this exists to prevent.
  if (error) return [];
  return ((data ?? []) as Array<{ id: string; scope: string; created_by: string | null }>)
    .filter(
      (b) =>
        b.scope === "workspace" ||
        (!scope.sharedOnly && scope.viewer !== undefined && b.created_by === scope.viewer),
    )
    .map((b) => b.id);
}

/**
 * A document's text in order, from its newest passages, up to `limit`
 * characters. Overlap between neighbouring passages is not removed — it costs
 * a few hundred characters and saves guessing where one ends.
 */
async function orderedText(db: SupabaseClient, documentId: string, limit: number): Promise<string> {
  const { data, error } = await db
    .from("document_chunks")
    .select("content,chunk_index,generation")
    .eq("document_id", documentId)
    .order("generation", { ascending: false })
    .order("chunk_index", { ascending: true })
    .limit(Math.ceil(limit / 600));
  if (error || !data || data.length === 0) return "";
  const rows = data as Array<{ content: string; generation: number }>;
  const newest = rows[0].generation;
  let text = "";
  for (const row of rows) {
    if (row.generation !== newest) break;
    if (text.length + row.content.length > limit) break;
    text += (text ? "\n\n" : "") + row.content;
  }
  return text;
}

/**
 * The retrieval floor, for deciding what to cite. A misconfigured
 * `RAG_MIN_SIMILARITY` already fell back to an ungrounded answer above; here it
 * falls back to the default rather than throwing after the block is built.
 */
function citationFloor(env: RetrievalConfig): number {
  try {
    return ragMinSimilarity(env);
  } catch {
    return DEFAULT_RAG_MIN_SIMILARITY;
  }
}
