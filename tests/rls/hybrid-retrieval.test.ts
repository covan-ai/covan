/**
 * Proof that `match_chunks` fuses vector and lexical search
 * (`0049_the_words_as_well_as_the_meaning.sql`), not just that the migration
 * applies cleanly.
 *
 * Before this migration, `match_chunks` walked `document_chunks` ordered by
 * embedding distance and stopped at `p_min_similarity` — a verbatim string
 * (a contract number, a SKU, an inflected Turkish word) that sits under the
 * similarity floor was invisible no matter how literally it appeared in a
 * chunk. 0049 adds a second, floor-free arm that matches `search_tsv`
 * (`to_tsvector('simple', rag_fold(context || ' ' || content))`) against a
 * `tsquery` built from `p_query_terms`, and fuses the two arms with
 * Reciprocal Rank Fusion. This file is the only place that SQL runs at all —
 * everything else in the migration's plan is either the SQL itself or a unit
 * test of the worker's pure functions (`fold`/`searchTerms` in
 * `worker/src/lib/search-terms.ts`).
 *
 * A fixture gap worth naming so it is not repeated: `seedWorkspace`
 * (`tests/rls/fixtures.ts`) creates an agent and a bundle but never links them
 * in `agent_bundles`. `match_chunks`'s bundle-scoping clause
 * (`dc.bundle_id in (select ab.bundle_id from agent_bundles ab where
 * ab.agent_id = p_agent_id)`) is empty without that row, so every case below
 * would return zero rows regardless of the vector/lexical logic being
 * exercised — passing (or failing) for a reason that has nothing to do with
 * what the test claims to check. `tests/rls/soft-deletion.test.ts`'s
 * "stops grounding answers" test has exactly this gap; it is out of this
 * file's scope to fix, but this file inserts the link explicitly (below) so
 * it does not repeat the mistake.
 *
 * Two one-hot embeddings, orthogonal by construction, are used everywhere in
 * this file instead of realistic vectors: pgvector's `<=>` is cosine
 * distance, so `1 - (chunk <=> query)` for two one-hot vectors at different
 * indices is exactly `0` — not "low enough to probably clear a threshold",
 * the literal value — which makes "the vector arm cannot have produced this
 * hit" a fact about the arithmetic rather than a guess about embedding
 * geometry.
 *
 * This test cannot be run locally: there is no Docker and no Postgres shim in
 * this repo, and `match_chunks`, `search_tsv` and `rag_fold` only exist once
 * a migration has actually run against a real Postgres. It runs in CI's `rls`
 * job, which brings up the docker-compose stack, applies every migration,
 * and then runs `bun run test:rls`. Its correctness here rests on tracing
 * this file's calls against 0049's actual SQL body, not on a green run.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeSql,
  createTestUser,
  destroyTestUsers,
  serviceClient,
  type TestUser,
} from "./harness";
import { seedWorkspace, type Seeded } from "./fixtures";

let owner: TestUser;
let seeded: Seeded;

/** A unit vector with a single `1` at `index` and `0` everywhere else. */
function oneHot(index: number): number[] {
  return Array.from({ length: 1536 }, (_, i) => (i === index ? 1 : 0));
}

// Every chunk in this file is embedded at index 5; every query embedding
// used to call match_chunks is embedded at index 900. Cosine similarity
// between the two is exactly 0, so a `p_min_similarity` of 0.9 or 1.0
// excludes every chunk here from the vector arm with no ambiguity — only the
// lexical arm can produce a hit in any case below.
const CHUNK_EMBEDDING = oneHot(5);
const QUERY_EMBEDDING = oneHot(900);

const LEXICAL_TOKEN = "kontrat9271";

beforeAll(async () => {
  owner = await createTestUser("hybrid-owner");
  seeded = await seedWorkspace(owner);

  const service = serviceClient();

  // The fixture gap noted above: without this row, match_chunks's
  // bundle-scoping subquery is empty and every case below returns zero rows
  // for a reason unrelated to vector/lexical fusion. Written with the
  // service role, same reasoning tests/rls/soft-deletion.test.ts gives for
  // seeding document_chunks directly: this test is about match_chunks's
  // ranking logic, not about agent_bundles' own RLS policies.
  const { error: linkError } = await service
    .from("agent_bundles")
    .insert({ agent_id: seeded.agentId, bundle_id: seeded.bundleId });
  if (linkError) {
    throw new Error(`could not link the seeded agent to its bundle: ${linkError.message}`);
  }

  // Case 1 & 2's chunk: a rare alphanumeric token no embedding model would
  // place near QUERY_EMBEDDING's counterpart, so only the lexical arm can
  // surface it. Written with the service role — same reason
  // soft-deletion.test.ts gives: the embedding column wants a vector, and the
  // app writes chunks through the caller's own client, but this fixture only
  // needs the row to exist with a specific, controlled embedding.
  const { error: lexicalChunkError } = await service.from("document_chunks").insert({
    document_id: seeded.documentId,
    bundle_id: seeded.bundleId,
    workspace_id: owner.workspaceId,
    chunk_index: 0,
    content: `the appendix references contract number ${LEXICAL_TOKEN} in a footnote`,
    embedding: CHUNK_EMBEDDING,
  });
  if (lexicalChunkError) {
    throw new Error(`could not seed the lexical-rescue chunk: ${lexicalChunkError.message}`);
  }

  // Case 3's chunk: "kayıtlarında" ("in its/their records" — kayıt "record" +
  // lar (plural) + ı (3rd-person possessive) + nda (locative)), an inflected
  // form Postgres's 'simple' config (no stemmer) stores as one lexeme,
  // unchanged. See the third `it()` below for why the query term is "kayıt"
  // rather than the "sözleşme"/"sozlesmesinde" pairing the plan sketched.
  const { error: turkishChunkError } = await service.from("document_chunks").insert({
    document_id: seeded.documentId,
    bundle_id: seeded.bundleId,
    workspace_id: owner.workspaceId,
    chunk_index: 1,
    content: "yeni kayıtlarında bir değişiklik yapıldı",
    embedding: CHUNK_EMBEDDING,
  });
  if (turkishChunkError) {
    throw new Error(`could not seed the Turkish-morphology chunk: ${turkishChunkError.message}`);
  }
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

type Hit = {
  document_id: string;
  document_name: string;
  content: string;
  similarity: number | null;
};

async function matchChunks(args: { minSimilarity: number; queryTerms?: string[] }): Promise<Hit[]> {
  const { data, error } = await owner.db.rpc("match_chunks", {
    p_agent_id: seeded.agentId,
    p_query_embedding: QUERY_EMBEDDING,
    p_match_count: 10,
    p_min_similarity: args.minSimilarity,
    ...(args.queryTerms !== undefined ? { p_query_terms: args.queryTerms } : {}),
  });
  expect(error).toBeNull();
  return (data ?? []) as Hit[];
}

describe("match_chunks fuses vector and lexical search (0049)", () => {
  it("the lexical arm rescues a chunk the vector arm alone would miss", async () => {
    // Trace against 0049's body: vector_matches requires
    // `(1 - (dc.embedding <=> p_query_embedding)) >= p_min_similarity`; with
    // similarity exactly 0 and a floor of 0.9, this chunk is excluded from
    // vector_matches entirely. lexical_matches's `q.tsq` is
    // `rag_fold('kontrat9271') || ':*'` cast to tsquery — rag_fold only
    // lowercases and folds ı/İ, and this token has neither, so it is
    // unchanged: 'kontrat9271:*'. The chunk's search_tsv is
    // `to_tsvector('simple', rag_fold(content))`, and 'kontrat9271' is one
    // alphanumeric run with no internal punctuation, so it tokenizes to the
    // single lexeme 'kontrat9271' — which the prefix query matches (trivially,
    // as its own prefix). fused_score for this row is therefore
    // `0.8 / (60 + rank)` from lexical_matches alone; vector_matches
    // contributes nothing to its `sum(score)`, and `max(similarity)` over a
    // single lexical-only arm is `null`.
    const hits = await matchChunks({ minSimilarity: 0.9, queryTerms: [LEXICAL_TOKEN] });

    const hit = hits.find((h) => h.content.includes(LEXICAL_TOKEN));
    expect(hit).toBeDefined();
    expect(hit?.similarity).toBeNull();
  });

  it("without query terms, the same chunk stays invisible — the failure 0049 exists to fix", async () => {
    // Same call, `p_query_terms` empty. In the `q` CTE,
    // `cardinality(p_query_terms) = 0` is true, so `tsq` is `null`.
    // lexical_matches's `where q.tsq is not null` then admits no rows —
    // lexical_matches is empty — and vector_matches already excluded this
    // chunk on the 0.9 floor. `fused` has nothing to group for this chunk, so
    // it is absent from the result. This is byte-for-byte the pre-migration
    // `match_chunks`'s behaviour (0049's own claim), pinned here so a future
    // change to the lexical arm cannot silently make an empty
    // `p_query_terms` start matching everything.
    const hits = await matchChunks({ minSimilarity: 0.9, queryTerms: [] });

    expect(hits.some((h) => h.content.includes(LEXICAL_TOKEN))).toBe(false);
  });

  it("prefix-matches an inflected Turkish word instead of requiring an exact token", async () => {
    // The plan's sketch for this case paired content containing
    // "sözleşme"/"sözleşmesi" with a query term "sozlesmesinde" — plain ASCII,
    // on the premise that rag_fold normalizes Turkish diacritics away. It does
    // not: rag_fold is `replace(replace(lower(value), 'ı', 'i'),
    // U&'\0307', '')` — it folds dotless ı to i and strips the combining dot
    // U+0307 that JS/SQL default lower-casing leaves behind İ, and nothing
    // else. ö, ş, ç, ğ and ü all survive it untouched (confirmed against
    // worker/src/lib/search-terms.test.ts, which hand-writes both spellings
    // of words like "yükledi"/"yukledi" precisely because fold() does not
    // derive one from the other). An ASCII query term therefore cannot
    // prefix-match a stored token that still carries ö/ş — the characters
    // simply differ. So this case uses "kayıt" ("record") against content
    // holding "kayıtlarında" ("in its/their records") instead: the only
    // Turkish-specific character in either word is the dotless ı, which
    // rag_fold does fold to plain ASCII "i" on both sides, so the ASCII
    // framing the plan wanted is preserved without the false premise.
    //
    // Trace: content "yeni kayıtlarında bir değişiklik yapıldı" becomes
    // search_tsv from rag_fold("yeni kayıtlarında bir değişiklik yapıldı") =
    // "yeni kayitlarinda bir değişiklik yapildi" (each ı -> i; ğ is untouched
    // and irrelevant to this token) tokenized by to_tsvector('simple', ...),
    // giving a lexeme 'kayitlarinda' among others — 'simple' has no stemmer,
    // so the whole inflected word is one unsplit lexeme. The query term
    // "kayıt" folds the same way to "kayit", becomes tsquery 'kayit:*', and
    // 'kayitlarinda' starts with 'kayit' — a genuine prefix match, not an
    // exact-token one: to_tsquery-style exact matching would require the
    // lexeme to equal 'kayit' outright, which it does not.
    //
    // p_min_similarity 1.0 makes the vector arm's exclusion unambiguous even
    // to a reader who has not internalized that 0 < 0.9: nothing but an
    // identical vector could ever reach a floor of 1.0.
    const hits = await matchChunks({ minSimilarity: 1.0, queryTerms: ["kayıt"] });

    const hit = hits.find((h) => h.content.includes("kayıtlarında"));
    expect(hit).toBeDefined();
    expect(hit?.similarity).toBeNull();
  });
});
