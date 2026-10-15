-- Retrieval that finds what it filters for, documents that can be renamed and
-- deleted for good, and a count of what the knowledge base holds.
--
-- 1. `match_chunks` asks pgvector for an iterative scan. The HNSW index is
--    searched first and the agent's bundles filtered afterwards, and with the
--    default scan the index hands back its `ef_search` (40) nearest passages in
--    the whole table — of which, in a database shared by many workspaces, the
--    agent's own bundles might be none. `relaxed_order` keeps scanning until
--    enough rows survive the filter. Supabase does not let a migration attach
--    the setting to the function, so the function sets it for its own
--    transaction with `set_config`, which is why it is plpgsql now.
-- 2. A document's name can be changed, and its passages' `context` with it —
--    the lexical arm matches on the name through `context`.
-- 3. `forget_deleted` deletes something in Recently deleted now, rather than in
--    thirty days, and returns the stored objects the worker must remove.
-- 4. `knowledge_usage` counts what the caller can see of a workspace's
--    knowledge, for the line at the top of the Knowledge page.

-- ===========================================================================
-- 1. match_chunks, with an iterative scan
-- ===========================================================================

drop function if exists public.match_chunks(uuid, vector, int, float, text[], uuid, boolean);

create or replace function public.match_chunks(
  p_agent_id uuid,
  p_query_embedding vector(1536),
  p_match_count int,
  p_min_similarity float default 0,
  p_query_terms text[] default '{}',
  p_viewer uuid default null,
  p_shared_only boolean default false
)
returns table (document_id uuid, document_name text, content text, similarity float)
language plpgsql
volatile
security invoker
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
begin
  -- Transaction-local: a PostgREST call is one transaction, so this lasts for
  -- exactly this search.
  perform set_config('hnsw.iterative_scan', 'relaxed_order', true);
  perform set_config('hnsw.ef_search', '100', true);

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
  vector_matches as (
    select dc.id, dc.document_id, d.name as document_name, dc.content,
           1 - (dc.embedding <=> p_query_embedding::halfvec(1536)) as similarity,
           row_number() over (order by dc.embedding <=> p_query_embedding::halfvec(1536)) as rank
    from public.document_chunks dc
    join public.documents d on d.id = dc.document_id
    where dc.embedding is not null
      and d.deleted_at is null
      and (1 - (dc.embedding <=> p_query_embedding::halfvec(1536))) >= p_min_similarity
      and dc.bundle_id in (select r.bundle_id from readable r)
    order by dc.embedding <=> p_query_embedding::halfvec(1536)
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

revoke all on function public.match_chunks(uuid, vector, int, float, text[], uuid, boolean) from public, anon;
grant execute on function public.match_chunks(uuid, vector, int, float, text[], uuid, boolean)
  to authenticated, service_role;

-- ===========================================================================
-- 2. renaming a document
-- ===========================================================================

revoke update on public.documents from anon, authenticated;
grant update (bundle_id, name) on public.documents to authenticated;
revoke update on public.document_chunks from anon, authenticated;
grant update (bundle_id, context) on public.document_chunks to authenticated;

-- ===========================================================================
-- 3. deleting for good
-- ===========================================================================

-- What the caller may forget is what they may restore: a deleted bundle they
-- can see (shared, or their own) and a deleted document in one, in a workspace
-- they write in. The rows go now; the stored objects are named in the result
-- for the worker, which is the only thing that can reach the store.
create or replace function public.forget_deleted(p_kind text, p_id uuid)
returns table (r2_key text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_workspace_id uuid;
  v_scope text;
  v_owner uuid;
begin
  if p_kind = 'bundle' then
    select b.workspace_id, b.scope, b.created_by into v_workspace_id, v_scope, v_owner
    from public.knowledge_bundles b
    where b.id = p_id and b.deleted_at is not null;
  elsif p_kind = 'document' then
    select b.workspace_id, b.scope, b.created_by into v_workspace_id, v_scope, v_owner
    from public.documents d
    join public.knowledge_bundles b on b.id = d.bundle_id
    where d.id = p_id and d.deleted_at is not null;
  else
    raise exception 'only bundles and documents can be deleted for good here' using errcode = '22023';
  end if;

  if v_workspace_id is null
     or not public.is_workspace_member(v_workspace_id)
     or (v_scope = 'owner' and v_owner is distinct from auth.uid()) then
    raise exception 'nothing like that is in Recently deleted' using errcode = 'P0002';
  end if;
  if not public.can_write_in_workspace(v_workspace_id) then
    raise exception 'you cannot delete things in this workspace' using errcode = '42501';
  end if;

  if p_kind = 'bundle' then
    return query
      select d.r2_key from public.documents d where d.bundle_id = p_id and d.r2_key is not null;
    delete from public.knowledge_bundles where id = p_id;
  else
    return query
      select d.r2_key from public.documents d where d.id = p_id and d.r2_key is not null;
    delete from public.documents where id = p_id;
  end if;
end $$;

revoke all on function public.forget_deleted(text, uuid) from public, anon;
grant execute on function public.forget_deleted(text, uuid) to authenticated, service_role;

-- ===========================================================================
-- 4. how much there is
-- ===========================================================================

-- Invoker: the counts are of what the caller's own policies show them, so a
-- colleague's private bundles are not in anybody else's numbers.
create or replace function public.knowledge_usage(p_workspace_id uuid)
returns table (bundles bigint, documents bigint, bytes bigint, passages bigint)
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select
    (select count(*) from public.knowledge_bundles b
      where b.workspace_id = p_workspace_id and b.deleted_at is null),
    (select count(*) from public.documents d
      join public.knowledge_bundles b on b.id = d.bundle_id
      where b.workspace_id = p_workspace_id and d.deleted_at is null),
    (select coalesce(sum(d.size), 0)::bigint from public.documents d
      join public.knowledge_bundles b on b.id = d.bundle_id
      where b.workspace_id = p_workspace_id and d.deleted_at is null),
    (select count(*) from public.document_chunks dc
      where dc.workspace_id = p_workspace_id);
$$;

revoke all on function public.knowledge_usage(uuid) from public, anon;
grant execute on function public.knowledge_usage(uuid) to authenticated, service_role;
