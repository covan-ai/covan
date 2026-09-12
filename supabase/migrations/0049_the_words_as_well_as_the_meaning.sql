-- =========================================================================
-- The words as well as the meaning
--
-- `match_chunks` today only matches on meaning: it walks `document_chunks`
-- ordered by embedding distance and stops at `p_min_similarity`. That is the
-- right tool for "what did we say about onboarding" and the wrong one for a
-- contract number, a SKU, an acronym, or an error code — a verbatim string
-- that is semantically almost nothing to an embedding model, and that can
-- therefore sit under the similarity floor even when it appears in the chunk
-- word for word. The result is a wrong or absent answer to a question whose
-- answer was sitting right there in the team's own documents.
--
-- Postgres ships no Turkish dictionary, and the terms this migration exists to
-- catch — codes, names, acronyms — are exactly what a stemmer must not touch
-- anyway. So the new lexical arm uses the `'simple'` text search
-- configuration (tokenize, lowercase, no stemming) with prefix matching,
-- rather than reaching for a dictionary Postgres does not have.
--
-- Three things ship together:
--
--   1. `rag_fold`, a SQL-side mirror of `worker/src/lib/doc-question.ts`'s
--      `fold()`. JavaScript's default (non-Turkish-aware) lower-casing turns
--      "İ" into "i" plus a combining dot above (U+0307) and leaves "I" as
--      plain "i" — so Turkish's four I's (İ i I ı) do not all collapse onto
--      one unless the dot is stripped and "ı" is folded in by hand. Without
--      this, "İŞE ALIM" stops matching "işe alım" over a single letter, in
--      the language most of this product's users type in. Both sides of a
--      lexical match — the stored `search_tsv` and the terms the worker sends
--      in `p_query_terms` — are folded through this same function so they
--      agree.
--
--   2. Two columns on `document_chunks`: `context`, and a generated,
--      indexed `search_tsv`. `context` holds the document's name, not the
--      prompt — `rag.ts`'s `buildContextBlock` already writes `Document:
--      <name>` into the context block it sends the model, so folding the name
--      into `content` as well would print it twice and spend the character
--      budget doing it. A separate column makes the name searchable (a
--      question naming a file by its filename should find that file's
--      chunks) without duplicating it. `search_tsv` is generated with the
--      two-argument `to_tsvector('simple', ...)`, not the one-argument form:
--      the one-argument form reads `default_text_search_config` at run time
--      and is therefore only `stable`, which a generated column's expression
--      is not allowed to be. The two-argument form pins the configuration and
--      is `immutable`. Both new columns are backfilled in this same
--      migration — `context` from `documents.name`, free, no embedding calls.
--
--   3. `match_chunks` itself, replaced rather than altered because its
--      signature grows: a fifth argument, `p_query_terms text[] default
--      '{}'`, defaulting to empty so every existing caller — the RPC's other
--      readers, and the 4-arg call in `tests/rls/soft-deletion.test.ts` — is
--      unaffected and needs no code change to keep working. That default is
--      also why this migration is safe to apply ahead of the worker deploy
--      that will start passing terms: until that deploy ships, every call
--      still arrives with `p_query_terms = '{}'`.
--
-- The new body fuses two arms with Reciprocal Rank Fusion rather than
-- picking one:
--
--   - The vector arm is the old query, unchanged in every clause that
--     matters for correctness: same `knowledge_bundles` join, same two
--     `deleted_at is null` checks (0040 — a chunk is retrievable only while
--     both the document it came from and the bundle it is filed under are
--     alive), same `agent_bundles` scoping, same `p_min_similarity` floor,
--     ranked by cosine distance, `limit p_match_count * 4` candidates.
--
--   - The lexical arm shares those joins, filters, and scoping, but carries
--     no similarity floor — a chunk containing the query's rare terms
--     verbatim is a match by a different definition than cosine similarity,
--     and a floor built for one does not belong on the other. It matches
--     against `search_tsv` with a `tsquery` built from `p_query_terms`,
--     folded through `rag_fold` and joined with `:*` (prefix) and `|` (OR):
--     prefix matching is the Turkish story — with no stemmer, `search_tsv`
--     for "fiyatlandırma" never matches the query term "fiyatlandırmada" on
--     an exact-token basis, but it does against "fiyatlandırma:*" — and `|`
--     rather than `&` because a long natural-language question ANDed
--     together matches nothing. The worker only ever sends sanitised
--     alphanumeric terms (a later task enforces this), so this never builds
--     a `tsquery` out of raw user text. Ranked by `ts_rank_cd`, same `limit
--     p_match_count * 4`.
--
--   - Fusion groups by `document_chunks.id` — the row's actual primary key —
--     not by `content`, so two different chunks that happen to hold
--     identical text are never merged into one fused row. Each arm
--     contributes `1.0 / (60 + rank)` (60 is the standard RRF constant); the
--     vector arm is weighted `1.0` and the lexical arm `0.8`, so a tied rank
--     favors the arm that still has a relevance floor behind it. `similarity`
--     in the result is the vector arm's cosine when a chunk was found by it,
--     and `null` for a lexical-only hit — `retrieval.ts` already discards
--     this column, so it is kept only for the RPC's other readers. The final
--     `order by fused_score desc` is what `rag.ts`'s `buildContextBlock`
--     relies on: it spends its character budget front to back on the order
--     the RPC hands back, and nothing downstream re-sorts.
--
-- What this deliberately does not do: it does not add a Turkish stemming
-- dictionary (Postgres ships none, and a stemmer would blur exactly the
-- verbatim codes and names this migration exists to catch); it does not
-- touch `p_min_similarity`'s semantics for the vector arm; and it does not
-- change what a lexical-only hit is allowed to claim downstream — it still
-- only ever produces `messages.grounding = 'chunks'` (the check constraint
-- from `0039_whether_anything_came_close.sql`, allowed values `'chunks' |
-- 'documents' | 'none'`), whose meaning is widening by this migration from
-- "cleared the similarity floor" to "matched, by meaning or by wording" —
-- the same column, a broader definition of what it records, tracked as
-- `covan#44`.
--
-- What does not change: when `p_query_terms` is `'{}'` (the default), the
-- lexical CTE's `tsq` is `null`, its `where q.tsq is not null` clause admits
-- no rows, and `lexical_matches` is empty — so the fused result is exactly
-- the pre-migration `match_chunks`, byte for byte. That property, not just
-- the default argument, is what makes this safe to apply before the worker
-- deploy that starts sending terms.
-- =========================================================================

-- ---- a. Turkish-aware case folding, mirroring worker/src/lib/doc-question.ts's
-- fold(): JS's default lower-casing turns "İ" into "i" + a combining dot above
-- (U+0307) rather than a plain "i", and leaves "I" un-Turkish-ified; folding
-- both "ı" and the combining dot away is what makes all four of Turkish's I's
-- collapse onto one, so "İŞE ALIM" keeps matching "işe alım". Must be
-- `immutable` to appear inside a generated column's expression below — both
-- `lower()` and `replace()` qualify.
create or replace function public.rag_fold(value text)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$ select replace(replace(lower(value), 'ı', 'i'), U&'\0307', '') $$;

-- Not 0023 (which only restores table/sequence grants): the shape here
-- follows 0032's `workspace_usage_*` and 0038's `document_citation_counts`,
-- the migrations that grant execute on a new function.
grant execute on function public.rag_fold(text) to authenticated, service_role;

-- ---- b. Two new columns on document_chunks --------------------------------

alter table public.document_chunks add column if not exists context text;

-- The two-argument `to_tsvector(regconfig, text)` is `immutable`; the
-- one-argument form reads the `default_text_search_config` GUC at run time
-- and is only `stable`, which a generated column's expression may not be.
-- `'simple'` (tokenize + lowercase, no stemming) rather than a language
-- dictionary: Postgres ships no Turkish one, and the terms this arm exists to
-- catch — codes, names, acronyms — are exactly what a stemmer must not touch.
alter table public.document_chunks
  add column if not exists search_tsv tsvector
  generated always as (
    to_tsvector('simple', public.rag_fold(coalesce(context, '') || ' ' || content))
  ) stored;

create index if not exists document_chunks_search_tsv_idx
  on public.document_chunks using gin (search_tsv);

-- Free — no embedding calls, no worker involvement. `context` holds the
-- document's name, not the prompt: `rag.ts`'s `buildContextBlock` already
-- writes `Document: <name>` into the context block, so folding the name into
-- `content` too would print it twice and spend the char budget on it. A
-- separate column makes the name searchable without repeating it there.
update public.document_chunks dc
set context = d.name
from public.documents d
where d.id = dc.document_id and dc.context is null;

-- ---- c. match_chunks, replaced with a hybrid (vector + lexical) version ---

-- Signature is growing by one argument, so the old 4-arg function is dropped
-- before the replacement is created.
drop function if exists public.match_chunks(uuid, vector, int, float);

create function public.match_chunks(
  p_agent_id uuid,
  p_query_embedding vector(1536),
  p_match_count int,
  p_min_similarity float default 0,
  p_query_terms text[] default '{}'
)
returns table (document_id uuid, document_name text, content text, similarity float)
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  with q as (
    select case when cardinality(p_query_terms) = 0 then null
           else array_to_string(
                  array(select public.rag_fold(t) || ':*' from unnest(p_query_terms) t),
                  ' | ')::tsquery
           end as tsq
  ),
  vector_matches as (
    select dc.id, dc.document_id, d.name as document_name, dc.content,
           1 - (dc.embedding <=> p_query_embedding) as similarity,
           row_number() over (order by dc.embedding <=> p_query_embedding) as rank
    from public.document_chunks dc
    join public.documents d on d.id = dc.document_id
    join public.knowledge_bundles b on b.id = dc.bundle_id
    where dc.embedding is not null
      and d.deleted_at is null
      and b.deleted_at is null
      and (1 - (dc.embedding <=> p_query_embedding)) >= p_min_similarity
      and dc.bundle_id in (
        select ab.bundle_id from public.agent_bundles ab where ab.agent_id = p_agent_id
      )
    order by dc.embedding <=> p_query_embedding
    limit p_match_count * 4
  ),
  lexical_matches as (
    select dc.id, dc.document_id, d.name as document_name, dc.content,
           row_number() over (order by ts_rank_cd(dc.search_tsv, q.tsq) desc) as rank
    from public.document_chunks dc
    join public.documents d on d.id = dc.document_id
    join public.knowledge_bundles b on b.id = dc.bundle_id
    cross join q
    where q.tsq is not null
      and dc.search_tsv @@ q.tsq
      and d.deleted_at is null
      and b.deleted_at is null
      and dc.bundle_id in (
        select ab.bundle_id from public.agent_bundles ab where ab.agent_id = p_agent_id
      )
    order by ts_rank_cd(dc.search_tsv, q.tsq) desc
    limit p_match_count * 4
  ),
  fused as (
    select id, document_id, document_name, content,
           max(similarity) as similarity,
           sum(score) as fused_score
    from (
      select id, document_id, document_name, content, similarity,
             1.0 / (60 + rank) as score
      from vector_matches
      union all
      select id, document_id, document_name, content, null::float as similarity,
             0.8 / (60 + rank) as score
      from lexical_matches
    ) arms
    group by id, document_id, document_name, content
  )
  select document_id, document_name, content, similarity
  from fused
  order by fused_score desc
  limit p_match_count;
$$;

grant execute on function public.match_chunks(uuid, vector(1536), int, float, text[])
  to authenticated, service_role;
