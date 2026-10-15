-- Knowledge is yours until you share it.
--
-- Every member of a workspace could read every bundle in it, and every writer
-- could change or delete any of them (0004, 0021, 0040): the only question any
-- policy asked was "are you in the workspace". A file somebody dropped in for
-- their own work was the whole team's from the first upload. 0098 gave
-- connected services the shape this gives bundles — personal by default,
-- shared on purpose — and 0104 gave agents theirs.
--
--   scope   'owner'      only the person who made it (`created_by`) sees it,
--                        its documents and its passages; only they write it.
--           'workspace'  every member sees it and every writer writes it, as
--                        every bundle could before.
--
-- The unit is the bundle, not the document. A bundle is the folder people
-- already think in, retrieval already scopes by it (`document_chunks.bundle_id`),
-- and a document moves between bundles — so a document's visibility is its
-- bundle's, and moving a file into a shared bundle is sharing it.
--
-- EXISTING BUNDLES become 'workspace': everyone who could read one yesterday
-- still can. New bundles start as 'owner'. A bundle with no `created_by` (made
-- before 0037, or by a routine or a sync) stays shared, since nobody could be
-- its owner.
--
-- AN AGENT AND A PRIVATE BUNDLE. Attaching a bundle to an agent used to share
-- it with everyone who could talk to the agent. Now a private bundle may be
-- attached only by its owner, and it grounds only that owner's own turns:
-- through a person's own client the policies below hide it from everybody
-- else, and the service-role paths (Slack, routines) ask `match_chunks` for
-- shared bundles only, or for one named person's — see `p_viewer` and
-- `p_shared_only`. A reply anybody else can read is never grounded on it.
--
-- Only the owner shares or unshares. An admin can change or delete a shared
-- bundle, as any writer can, but cannot make somebody's private bundle
-- visible or take a shared one private — the same line 0098 drew.

-- ===========================================================================
-- 1. the column
-- ===========================================================================

-- Added with 'workspace' as the default so every existing row gets it, then
-- the default moved to 'owner' for every row made from now on.
alter table public.knowledge_bundles
  add column if not exists scope text not null default 'workspace';
alter table public.knowledge_bundles alter column scope set default 'owner';

alter table public.knowledge_bundles drop constraint if exists knowledge_bundles_scope_known;
alter table public.knowledge_bundles add constraint knowledge_bundles_scope_known
  check (scope in ('owner', 'workspace'));

-- Nobody can own a bundle with no maker, so it cannot be private. The trigger
-- makes it so for the writers that make bundles nobody owns — a workspace
-- restored from an export of rows from before 0037, a service-role insert —
-- rather than failing them on the constraint below.
create or replace function public.knowledge_bundles_unowned_are_shared()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.created_by is null then
    new.scope := 'workspace';
  end if;
  return new;
end;
$$;

revoke all on function public.knowledge_bundles_unowned_are_shared() from public;

drop trigger if exists trg_knowledge_bundles_unowned_are_shared on public.knowledge_bundles;
create trigger trg_knowledge_bundles_unowned_are_shared
  before insert on public.knowledge_bundles
  for each row execute function public.knowledge_bundles_unowned_are_shared();

alter table public.knowledge_bundles drop constraint if exists knowledge_bundles_owner_needs_maker;
alter table public.knowledge_bundles add constraint knowledge_bundles_owner_needs_maker
  check (scope = 'workspace' or created_by is not null);

comment on column public.knowledge_bundles.scope is
  'owner: only created_by sees and writes it (and its documents and passages); workspace: every member sees it, every writer writes it. Only created_by changes it (0106).';

grant insert (workspace_id, name, description, created_by, scope)
  on public.knowledge_bundles to authenticated;
grant update (name, description, scope) on public.knowledge_bundles to authenticated;

-- ===========================================================================
-- 2. the two questions every policy below asks
-- ===========================================================================

-- Whether the caller can see a bundle. Definer, so a policy on documents or
-- passages can ask it without the bundle's own policy running inside it.
create or replace function public.bundle_is_visible(p_bundle_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.knowledge_bundles b
    where b.id = p_bundle_id
      and public.is_workspace_member(b.workspace_id)
      and (b.scope = 'workspace' or b.created_by = auth.uid())
  );
$$;

-- Whether the caller can change what is in a bundle.
create or replace function public.bundle_is_writable(p_bundle_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.knowledge_bundles b
    where b.id = p_bundle_id
      and public.can_write_in_workspace(b.workspace_id)
      and (b.scope = 'workspace' or b.created_by = auth.uid())
  );
$$;

revoke all on function public.bundle_is_visible(uuid) from public, anon;
grant execute on function public.bundle_is_visible(uuid) to authenticated, service_role;
revoke all on function public.bundle_is_writable(uuid) from public, anon;
grant execute on function public.bundle_is_writable(uuid) to authenticated, service_role;

-- ===========================================================================
-- 3. bundles
-- ===========================================================================

drop policy if exists "kb_select_member" on public.knowledge_bundles;
create policy "kb_select_member"
  on public.knowledge_bundles for select
  using (
    deleted_at is null
    and public.is_workspace_member(workspace_id)
    and (scope = 'workspace' or created_by = auth.uid())
  );

drop policy if exists "kb_update_member" on public.knowledge_bundles;
create policy "kb_update_member"
  on public.knowledge_bundles for update
  using (
    public.can_write_in_workspace(workspace_id)
    and (scope = 'workspace' or created_by = auth.uid())
  )
  with check (
    public.can_write_in_workspace(workspace_id)
    and (scope = 'workspace' or created_by = auth.uid())
  );

drop policy if exists "kb_delete_member" on public.knowledge_bundles;
create policy "kb_delete_member"
  on public.knowledge_bundles for delete
  using (
    public.can_write_in_workspace(workspace_id)
    and (scope = 'workspace' or created_by = auth.uid())
  );

-- Only the owner moves a bundle between private and shared. A policy cannot
-- compare the new row with the old, so this is a trigger, as 0098's is.
create or replace function public.knowledge_bundles_guard_scope()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if new.scope is distinct from old.scope and old.created_by is distinct from auth.uid() then
    raise exception 'only the person who made this bundle can share it or stop sharing it'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.knowledge_bundles_guard_scope() from public;

drop trigger if exists trg_knowledge_bundles_guard_scope on public.knowledge_bundles;
create trigger trg_knowledge_bundles_guard_scope
  before update on public.knowledge_bundles
  for each row execute function public.knowledge_bundles_guard_scope();

-- ===========================================================================
-- 4. documents and passages: their bundle's answer
-- ===========================================================================

drop policy if exists "documents_select_member" on public.documents;
create policy "documents_select_member"
  on public.documents for select
  using (documents.deleted_at is null and public.bundle_is_visible(documents.bundle_id));

drop policy if exists "documents_insert_member" on public.documents;
create policy "documents_insert_member"
  on public.documents for insert
  with check (
    (created_by is null or created_by = auth.uid())
    and public.bundle_is_writable(documents.bundle_id)
  );

drop policy if exists "documents_update_member" on public.documents;
create policy "documents_update_member"
  on public.documents for update
  using (public.bundle_is_writable(documents.bundle_id))
  with check (public.bundle_is_writable(documents.bundle_id));

drop policy if exists "documents_delete_member" on public.documents;
create policy "documents_delete_member"
  on public.documents for delete
  using (public.bundle_is_writable(documents.bundle_id));

drop policy if exists "dc_select_member" on public.document_chunks;
create policy "dc_select_member"
  on public.document_chunks for select
  using (
    public.is_workspace_member(workspace_id)
    and public.bundle_is_visible(document_chunks.bundle_id)
    and exists (
      select 1 from public.documents d
      where d.id = document_chunks.document_id
        and d.deleted_at is null
    )
  );

drop policy if exists "dc_insert_member" on public.document_chunks;
create policy "dc_insert_member"
  on public.document_chunks for insert
  with check (
    public.can_write_in_workspace(workspace_id)
    and public.bundle_is_writable(document_chunks.bundle_id)
  );

drop policy if exists "dc_update_member" on public.document_chunks;
create policy "dc_update_member"
  on public.document_chunks for update
  using (
    public.can_write_in_workspace(workspace_id)
    and public.bundle_is_writable(document_chunks.bundle_id)
  )
  with check (
    public.can_write_in_workspace(workspace_id)
    and public.bundle_is_writable(document_chunks.bundle_id)
  );

drop policy if exists "dc_delete_member" on public.document_chunks;
create policy "dc_delete_member"
  on public.document_chunks for delete
  using (
    public.can_write_in_workspace(workspace_id)
    and public.bundle_is_writable(document_chunks.bundle_id)
  );

-- ===========================================================================
-- 5. what an agent reads
-- ===========================================================================

-- An attachment to a private bundle is its owner's to see.
drop policy if exists "ab_select_member" on public.agent_bundles;
create policy "ab_select_member"
  on public.agent_bundles for select
  using (
    exists (
      select 1 from public.agents a
      where a.id = agent_bundles.agent_id
        and public.is_workspace_member(a.workspace_id)
    )
    and public.bundle_is_visible(agent_bundles.bundle_id)
  );

-- 0104's rule, and the bundle has to be one the caller may write: a private
-- bundle is attached by its owner and nobody else.
drop policy if exists "ab_insert_member" on public.agent_bundles;
create policy "ab_insert_member"
  on public.agent_bundles for insert
  with check (
    public.can_edit_agent(agent_bundles.agent_id)
    and public.bundle_is_writable(agent_bundles.bundle_id)
    and exists (
      select 1
      from public.agents a
      join public.knowledge_bundles b on b.id = agent_bundles.bundle_id
      where a.id = agent_bundles.agent_id
        and a.workspace_id = b.workspace_id
        and public.can_write_in_workspace(a.workspace_id)
    )
  );

drop policy if exists "ab_delete_member" on public.agent_bundles;
create policy "ab_delete_member"
  on public.agent_bundles for delete
  using (
    public.can_edit_agent(agent_bundles.agent_id)
    and public.bundle_is_visible(agent_bundles.bundle_id)
    and exists (select 1 from public.agents a where a.id = agent_bundles.agent_id)
  );

-- ===========================================================================
-- 6. retrieval for the paths that have no caller
-- ===========================================================================

-- Through a person's own client the policies above already decide; what is
-- added here is for the service role, which no policy filters (Slack, routines)
-- and for a conversation others can read:
--
--   p_shared_only  only shared bundles — for any reply someone other than the
--                  asker can read: a shared conversation, a Slack thread, a
--                  shared routine's report.
--   p_viewer       shared bundles and this person's own — for a private
--                  routine, which runs for its owner alone.
--
-- Both left as their defaults is the old behaviour, which is right only
-- through a person's own client.
drop function if exists public.match_chunks(uuid, vector, int, float, text[]);

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
      and dc.bundle_id in (select bundle_id from readable)
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
      and dc.bundle_id in (select bundle_id from readable)
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

revoke all on function public.match_chunks(uuid, vector, int, float, text[], uuid, boolean) from public, anon;
grant execute on function public.match_chunks(uuid, vector, int, float, text[], uuid, boolean)
  to authenticated, service_role;

-- ===========================================================================
-- 7. the definer functions, which no policy reaches
-- ===========================================================================

create or replace function public.soft_delete_bundle(p_bundle_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_workspace_id uuid;
  v_now timestamptz := now();
  v_actor uuid := auth.uid();
begin
  select workspace_id into v_workspace_id
  from public.knowledge_bundles
  where id = p_bundle_id and deleted_at is null;

  -- Somebody else's private bundle is not there, as far as the caller can tell.
  if v_workspace_id is null or not public.bundle_is_visible(p_bundle_id) then
    raise exception 'no such bundle' using errcode = 'P0002';
  end if;

  if not public.bundle_is_writable(p_bundle_id) then
    raise exception 'you cannot delete things in this workspace' using errcode = '42501';
  end if;

  update public.knowledge_bundles
     set deleted_at = v_now, deleted_by = v_actor, deleted_via = null
   where id = p_bundle_id;

  update public.documents
     set deleted_at = v_now, deleted_by = v_actor, deleted_via = p_bundle_id
   where bundle_id = p_bundle_id and deleted_at is null;
end $$;

-- A deleted bundle's visibility is asked of the row as it is, deleted_at
-- aside: `bundle_is_visible` would answer for a live one.
create or replace function public.restore_bundle(p_bundle_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_workspace_id uuid;
  v_scope text;
  v_owner uuid;
begin
  select workspace_id, scope, created_by into v_workspace_id, v_scope, v_owner
  from public.knowledge_bundles
  where id = p_bundle_id and deleted_at is not null;

  if v_workspace_id is null
     or not public.is_workspace_member(v_workspace_id)
     or (v_scope = 'owner' and v_owner is distinct from auth.uid()) then
    raise exception 'no such deleted bundle' using errcode = 'P0002';
  end if;

  if not public.can_write_in_workspace(v_workspace_id) then
    raise exception 'you cannot restore things in this workspace' using errcode = '42501';
  end if;

  update public.knowledge_bundles
     set deleted_at = null, deleted_by = null, deleted_via = null
   where id = p_bundle_id;

  update public.documents
     set deleted_at = null, deleted_by = null, deleted_via = null
   where deleted_via = p_bundle_id;
end $$;

create or replace function public.soft_delete_document(p_document_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_bundle_id uuid;
begin
  select d.bundle_id into v_bundle_id
  from public.documents d
  where d.id = p_document_id and d.deleted_at is null;

  if v_bundle_id is null or not public.bundle_is_visible(v_bundle_id) then
    raise exception 'no such document' using errcode = 'P0002';
  end if;

  if not public.bundle_is_writable(v_bundle_id) then
    raise exception 'you cannot delete things in this workspace' using errcode = '42501';
  end if;

  update public.documents
     set deleted_at = now(), deleted_by = auth.uid(), deleted_via = null
   where id = p_document_id;
end $$;

create or replace function public.restore_document(p_document_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_bundle_id uuid;
  v_bundle_deleted timestamptz;
begin
  select d.bundle_id, b.deleted_at into v_bundle_id, v_bundle_deleted
  from public.documents d
  join public.knowledge_bundles b on b.id = d.bundle_id
  where d.id = p_document_id and d.deleted_at is not null;

  if v_bundle_id is null then
    raise exception 'no such deleted document' using errcode = 'P0002';
  end if;

  -- Restoring into a deleted bundle would produce a row visible from nowhere.
  if v_bundle_deleted is not null then
    raise exception 'restore the bundle this document belongs to first'
      using errcode = 'P0001';
  end if;

  if not public.bundle_is_visible(v_bundle_id) then
    raise exception 'no such deleted document' using errcode = 'P0002';
  end if;

  if not public.bundle_is_writable(v_bundle_id) then
    raise exception 'you cannot restore things in this workspace' using errcode = '42501';
  end if;

  update public.documents
     set deleted_at = null, deleted_by = null, deleted_via = null
   where id = p_document_id;
end $$;

-- 0104's trash, with somebody else's private bundles — and their documents —
-- left out of it.
create or replace function public.workspace_trash(p_workspace_id uuid)
returns table (
  kind          text,
  id            uuid,
  name          text,
  deleted_at    timestamptz,
  deleted_by_id uuid,
  deleted_by_name text,
  parent_name   text
)
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
begin
  if not public.can_write_in_workspace(p_workspace_id) then
    raise exception 'you cannot see this workspace''s deleted items'
      using errcode = '42501';
  end if;

  return query
    select 'agent'::text, a.id, a.name, a.deleted_at, a.deleted_by,
           coalesce(p.name, p.email), null::text
      from public.agents a
      left join public.profiles p on p.id = a.deleted_by
     where a.workspace_id = p_workspace_id
       and a.deleted_at is not null
       and a.deleted_via is null
       and public.can_manage_agent(a.id)
    union all
    select 'bundle'::text, b.id, b.name, b.deleted_at, b.deleted_by,
           coalesce(p.name, p.email), null::text
      from public.knowledge_bundles b
      left join public.profiles p on p.id = b.deleted_by
     where b.workspace_id = p_workspace_id
       and b.deleted_at is not null
       and b.deleted_via is null
       and (b.scope = 'workspace' or b.created_by = auth.uid())
    union all
    select 'document'::text, d.id, d.name, d.deleted_at, d.deleted_by,
           coalesce(p.name, p.email), b.name
      from public.documents d
      join public.knowledge_bundles b on b.id = d.bundle_id
      left join public.profiles p on p.id = d.deleted_by
     where b.workspace_id = p_workspace_id
       and d.deleted_at is not null
       and d.deleted_via is null
       and (b.scope = 'workspace' or b.created_by = auth.uid())
    order by 4 desc;
end $$;

create or replace function public.document_citation_counts(p_bundle_ids uuid[])
returns table (document_id uuid, citations bigint)
language sql
security definer
stable
set search_path = pg_catalog, public
as $$
  select d.id, count(*)
  from public.documents d
  join public.knowledge_bundles b on b.id = d.bundle_id
  join public.messages m
    on m.sources @> jsonb_build_array(jsonb_build_object('id', d.id::text))
  join public.chat_sessions s on s.id = m.session_id
  where d.bundle_id = any(p_bundle_ids)
    and d.deleted_at is null
    and b.deleted_at is null
    and s.workspace_id = b.workspace_id
    and public.is_workspace_member(b.workspace_id)
    and (b.scope = 'workspace' or b.created_by = auth.uid())
  group by d.id;
$$;

-- 0105's reindex door, for the bundles the caller may write.
create or replace function public.queue_document_index(p_document_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_bundle_id uuid;
begin
  select d.bundle_id into v_bundle_id
  from public.documents d
  where d.id = p_document_id and d.deleted_at is null;

  if v_bundle_id is null or not public.bundle_is_visible(v_bundle_id) then
    raise exception 'no such document' using errcode = 'P0002';
  end if;
  if not public.bundle_is_writable(v_bundle_id) then
    raise exception 'you cannot reindex documents in this workspace' using errcode = '42501';
  end if;

  update public.documents
     set index_status = 'queued',
         index_cursor = 0,
         index_total = null,
         index_attempts = 0,
         index_error = null,
         index_truncated = false,
         index_next_run_at = now()
   where id = p_document_id
     and (index_lease_until is null or index_lease_until < now());
end $$;

-- `create or replace` keeps these grants; restated so this file reads whole.
revoke all on function public.soft_delete_bundle(uuid) from public, anon;
grant execute on function public.soft_delete_bundle(uuid) to authenticated, service_role;
revoke all on function public.restore_bundle(uuid) from public, anon;
grant execute on function public.restore_bundle(uuid) to authenticated, service_role;
revoke all on function public.soft_delete_document(uuid) from public, anon;
grant execute on function public.soft_delete_document(uuid) to authenticated, service_role;
revoke all on function public.restore_document(uuid) from public, anon;
grant execute on function public.restore_document(uuid) to authenticated, service_role;
revoke all on function public.workspace_trash(uuid) from public, anon;
grant execute on function public.workspace_trash(uuid) to authenticated, service_role;
revoke all on function public.document_citation_counts(uuid[]) from public, anon;
grant execute on function public.document_citation_counts(uuid[]) to authenticated, service_role;
revoke all on function public.queue_document_index(uuid) from public, anon;
grant execute on function public.queue_document_index(uuid) to authenticated, service_role;
