-- =========================================================================
-- Passages kept beside the database
--
-- A passage's embedding was the biggest thing in Postgres: on the hosted
-- service on 2026-10-19, 8,430 passages took 92 MB of a 117 MB database, and
-- 58 MB of that was vectors — the `halfvec` column (~25 MB) and its HNSW index
-- (33 MB), which `pg_stat_user_indexes` said had not been scanned once since
-- July, because every search is narrowed to an agent's bundles first and the
-- planner reads those rows directly. On a database with a 500 MB ceiling that
-- is the ceiling arriving three times sooner than the words do.
--
-- So a deployment may keep embeddings in a vector index of its own
-- (Cloudflare Vectorize, bound as `PASSAGES`; `worker/src/lib/passages.ts`).
-- A passage written there keeps its row here — the text, the words index, the
-- bundle, everything a policy reads — with `embedding` null. Nothing about who
-- may read what moves: the index is asked for passage ids, and those ids come
-- back through `match_passages_ranked` below, which is `security invoker` and
-- reads `document_chunks` under its policies like `match_chunks` does. An id
-- the caller cannot read is not an answer, whoever put it in the list.
--
-- A deployment without the binding is exactly what it was. Embeddings stay in
-- the column, `match_chunks` stays the search, and the table below only ever
-- sees a passage that has no embedding of its own — which here means none.
--
-- 1. passage_vector_changes — what the index has to be told
--
-- A passage leaves in more ways than the worker can see: a reindex clears an
-- old generation, a document or bundle is purged, a workspace or an account is
-- deleted and the cascade takes everything under it. A passage also moves:
-- `routes/documents.ts` re-homes a document's passages when the document
-- changes bundle, and the index filters by bundle. Each of those is a row
-- change on `document_chunks`, so a trigger is the one place that sees all of
-- them. The background tick (`lib/background.ts`) reads this table and tells
-- the index, then deletes what it has told.
--
-- Only for a passage whose embedding is not in the row: one whose vector is
-- here has nothing elsewhere to keep in step.
--
-- Service role only. It holds passage and bundle ids and nothing a person
-- wrote, but no client has any reason to read the engine's to-do list.
-- =========================================================================

create table if not exists public.passage_vector_changes (
  id          bigint generated always as identity primary key,
  chunk_id    uuid not null,
  -- The bundle the passage now belongs to; null when the passage is gone.
  bundle_id   uuid,
  document_id uuid,
  created_at  timestamptz not null default now()
);

alter table public.passage_vector_changes enable row level security;
revoke all on public.passage_vector_changes from public, anon, authenticated;
grant select, insert, delete on public.passage_vector_changes to service_role;

create or replace function public.note_passage_vector_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'DELETE' then
    if old.embedding is null then
      insert into public.passage_vector_changes (chunk_id) values (old.id);
    end if;
    return old;
  end if;
  if new.embedding is null and new.bundle_id is distinct from old.bundle_id then
    insert into public.passage_vector_changes (chunk_id, bundle_id, document_id)
    values (new.id, new.bundle_id, new.document_id);
  end if;
  return new;
end $$;
revoke all on function public.note_passage_vector_change() from public, anon, authenticated;

drop trigger if exists document_chunks_vector_change on public.document_chunks;
create trigger document_chunks_vector_change
  after delete or update of bundle_id on public.document_chunks
  for each row execute function public.note_passage_vector_change();

-- =========================================================================
-- 2. match_passages_ranked — `match_chunks`, with the vector arm supplied
--
-- The same search as 0107's `match_chunks`, line for line, except that the
-- nearest passages arrive as an ordered list of ids and their similarities
-- instead of being found here. The lexical arm, the fusion, the bundle
-- narrowing (`readable`) and the deleted-document filter are unchanged — and
-- the supplied ids go through all of them, so the list can only ever narrow
-- what the caller could already read.
-- =========================================================================

create or replace function public.match_passages_ranked(
  p_agent_id uuid,
  p_vector_ids uuid[],
  p_vector_similarities float[],
  p_match_count int,
  p_min_similarity float default 0,
  p_query_terms text[] default '{}',
  p_viewer uuid default null,
  p_shared_only boolean default false
)
returns table (document_id uuid, document_name text, content text, similarity float)
language plpgsql
stable
security invoker
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
begin
  return query
  with q as (
    select case when cardinality(p_query_terms) = 0 then null
           else array_to_string(
                  array(select public.rag_fold(t) || ':*' from unnest(p_query_terms) t),
                  ' | ')::tsquery
           end as tsq
  ),
  readable as (
    select ab.bundle_id
    from public.agent_bundles ab
    join public.knowledge_bundles b on b.id = ab.bundle_id
    where ab.agent_id = p_agent_id
      and b.deleted_at is null
      and (not p_shared_only or b.scope = 'workspace')
      and (p_viewer is null or b.scope = 'workspace' or b.created_by = p_viewer)
  ),
  supplied as (
    select s.id, s.similarity, s.ord
    from unnest(p_vector_ids, p_vector_similarities) with ordinality as s(id, similarity, ord)
  ),
  vector_matches as (
    select dc.id, dc.document_id, d.name as document_name, dc.content,
           s.similarity::float as similarity,
           row_number() over (order by s.ord) as rank
    from supplied s
    join public.document_chunks dc on dc.id = s.id
    join public.documents d on d.id = dc.document_id
    where d.deleted_at is null
      and s.similarity >= p_min_similarity
      and dc.bundle_id in (select r.bundle_id from readable r)
    order by s.ord
    limit p_match_count * 4
  ),
  lexical_matches as (
    select dc.id, dc.document_id, d.name as document_name, dc.content,
           row_number() over (order by ts_rank_cd(dc.search_tsv, q.tsq) desc) as rank
    from public.document_chunks dc
    join public.documents d on d.id = dc.document_id
    cross join q
    where q.tsq is not null
      and dc.search_tsv @@ q.tsq
      and d.deleted_at is null
      and dc.bundle_id in (select r.bundle_id from readable r)
    order by ts_rank_cd(dc.search_tsv, q.tsq) desc
    limit p_match_count * 4
  ),
  fused as (
    select arms.id, arms.document_id, arms.document_name, arms.content,
           max(arms.similarity) as similarity,
           sum(arms.score) as fused_score
    from (
      select v.id, v.document_id, v.document_name, v.content, v.similarity,
             1.0 / (60 + v.rank) as score
      from vector_matches v
      union all
      select l.id, l.document_id, l.document_name, l.content, null::float as similarity,
             0.8 / (60 + l.rank) as score
      from lexical_matches l
    ) arms
    group by arms.id, arms.document_id, arms.document_name, arms.content
  )
  select f.document_id, f.document_name, f.content, f.similarity
  from fused f
  order by f.fused_score desc
  limit p_match_count;
end $$;
revoke all on function public.match_passages_ranked(uuid, uuid[], float[], int, float, text[], uuid, boolean)
  from public, anon;
grant execute on function public.match_passages_ranked(uuid, uuid[], float[], int, float, text[], uuid, boolean)
  to authenticated, service_role;
