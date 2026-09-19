-- =========================================================================
-- Half the room for the same answer
--
-- `document_chunks.embedding` has been `vector(1536)` since 0004. pgvector
-- stores that as 1536 four-byte floats plus a header: 6,148 bytes a row, and
-- the HNSW index over it carries its own copy of every vector on top. On the
-- hosted plan the whole database has 500 MB, and nothing else in this schema
-- grows per paragraph of every document anybody uploads.
--
-- `halfvec` is the same vector in half-precision floats — 3,076 bytes a row,
-- and an HNSW index that is likewise halved. The conversion is a cast, so no
-- embedding is recomputed and no document is re-read: this is the cheap half
-- of the two ways to make the column smaller. The other, embedding at fewer
-- dimensions, needs every chunk re-embedded and is written up in
-- `supabase/optional/embedding_width.sql`.
--
-- WHAT IS LOST
--
-- Three or four significant digits instead of seven. Cosine similarity moves
-- in the third decimal, which is below any distinction this application makes
-- of it: RAG_MIN_SIMILARITY defaults to 0.25, and the fusion in
-- `match_chunks` ranks by position rather than by margin. Recall against a
-- half-precision HNSW index is indistinguishable at this dimensionality —
-- 1536 is well inside both the `vector` limit of 2000 and the `halfvec` limit
-- of 4000.
--
-- WHAT IT COSTS TO RUN
--
-- Read this before applying it to a database with traffic. Changing a
-- column's type rewrites the table under an ACCESS EXCLUSIVE lock, and the
-- index is dropped and rebuilt around it. For the whole of that, uploads
-- block and retrieval returns nothing — an agent answers from its persona
-- alone, which is the documented behaviour when a document has no chunks, so
-- nothing breaks and answers stop being grounded. How long depends entirely
-- on the row count, which is the one number this file cannot know:
--
--   select pg_size_pretty(pg_total_relation_size('public.document_chunks')),
--          pg_size_pretty(pg_relation_size('public.idx_document_chunks_embedding')),
--          count(*)
--   from public.document_chunks;
--
-- Tens of thousands of rows is seconds. If that query says millions, do this
-- behind a maintenance window, or not at all — a table small enough not to
-- threaten the 500 MB is a table this migration is not worth locking.
--
-- The function is left alone on purpose. `match_chunks` keeps taking a
-- `vector(1536)`, so PostgREST's schema cache, its grants, and the worker's
-- `db.rpc("match_chunks", ...)` call all carry on unchanged; the query vector
-- is cast at each point of use instead. Casting the *parameter* rather than
-- the column keeps the index scan intact: the cast folds to a constant for
-- the query, and the ordering expression still matches the index.
-- =========================================================================

-- halfvec arrived in pgvector 0.7.0. Failing here, by name, beats failing
-- three statements later inside an index build.
do $$
begin
  if to_regtype('public.halfvec') is null then
    raise exception
      'halfvec is not available: pgvector 0.7.0 or newer is required (found %)',
      coalesce((select extversion from pg_extension where extname = 'vector'), 'no vector extension');
  end if;
end $$;

-- ---- a. the column and its index --------------------------------------

-- The index first: it is defined over `vector_cosine_ops` and cannot survive
-- the column it indexes changing type.
drop index if exists public.idx_document_chunks_embedding;

alter table public.document_chunks
  alter column embedding type halfvec(1536)
  using embedding::halfvec(1536);

create index idx_document_chunks_embedding on public.document_chunks
  using hnsw (embedding halfvec_cosine_ops);

-- ---- b. match_chunks, same signature, half-precision comparisons -------

-- Replaced rather than altered because the body changes. The argument list is
-- identical to 0049's, so `create or replace` is enough and the grant that
-- migration issued still stands.
create or replace function public.match_chunks(
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
  -- Precondition on `p_query_terms` is unchanged from 0049: every element must
  -- be non-empty after `rag_fold` normalization, and it is the caller's job to
  -- ensure it (`worker/src/lib/search-terms.ts`). A term that folds to '' makes
  -- an invalid tsquery and fails the whole call, not just that term.
  with q as (
    select case when cardinality(p_query_terms) = 0 then null
           else array_to_string(
                  array(select public.rag_fold(t) || ':*' from unnest(p_query_terms) t),
                  ' | ')::tsquery
           end as tsq
  ),
  vector_matches as (
    select dc.id, dc.document_id, d.name as document_name, dc.content,
           1 - (dc.embedding <=> p_query_embedding::halfvec(1536)) as similarity,
           row_number() over (order by dc.embedding <=> p_query_embedding::halfvec(1536)) as rank
    from public.document_chunks dc
    join public.documents d on d.id = dc.document_id
    join public.knowledge_bundles b on b.id = dc.bundle_id
    where dc.embedding is not null
      and d.deleted_at is null
      and b.deleted_at is null
      and (1 - (dc.embedding <=> p_query_embedding::halfvec(1536))) >= p_min_similarity
      and dc.bundle_id in (
        select ab.bundle_id from public.agent_bundles ab where ab.agent_id = p_agent_id
      )
    order by dc.embedding <=> p_query_embedding::halfvec(1536)
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

-- No new grant: the signature is the one 0049 already granted to
-- `authenticated, service_role`, and `create or replace` keeps its ACL.
