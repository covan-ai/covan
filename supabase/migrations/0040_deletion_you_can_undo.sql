-- 0040_deletion_you_can_undo.sql
--
-- Deleting an agent has been final since 0001, and larger than it looks. The
-- foreign keys do the rest: every session anybody ever had with that agent,
-- every message in those sessions, every routine pointed at it. A bundle takes
-- its documents and their embeddings. Any `member` can do it, nothing asks
-- twice, and afterwards nothing records who did.
--
-- docs/team.md has said this in plain words for a while — "None of it is
-- recoverable from inside the product." That was survivable while the only
-- people in a workspace were the people who built it.
--
-- This migration makes those three deletions reversible for thirty days, and
-- writes a workspace-level record of the things people do to each other's work.
-- Design: docs/superpowers/specs/2026-09-02-deletion-you-can-undo-design.md
--
-- WHAT THIS IS NOT. It does not change who may delete. A member deletes an
-- agent today and still does after this; the deletion is reversible and
-- recorded, not harder to reach.

-- ===========================================================================
-- 1. The columns
-- ===========================================================================
--
-- `deleted_via` is the one doing the work. Foreign keys cascade on a real
-- delete and do nothing at all on a soft one, so a soft-deleted agent would
-- leave its sessions and routines sitting in place, visible, pointing at
-- something that is gone. Marking the children at delete time is what keeps
-- the screens honest — and naming WHICH ancestor hid them is what makes
-- restoring exact: restoring X clears X and exactly the rows carrying
-- `deleted_via = X`. A document deleted on its own (`deleted_via is null`)
-- does not come back when its bundle is restored, which is what anyone would
-- predict and what a bare timestamp comparison could not express.

alter table public.agents
  add column if not exists deleted_at  timestamptz,
  add column if not exists deleted_by  uuid references public.profiles (id) on delete set null,
  add column if not exists deleted_via uuid;

alter table public.knowledge_bundles
  add column if not exists deleted_at  timestamptz,
  add column if not exists deleted_by  uuid references public.profiles (id) on delete set null,
  add column if not exists deleted_via uuid;

alter table public.documents
  add column if not exists deleted_at  timestamptz,
  add column if not exists deleted_by  uuid references public.profiles (id) on delete set null,
  add column if not exists deleted_via uuid;

-- Hidden with their agent, restored with it, never restorable on their own.
-- No `deleted_by`: nobody deleted these directly, and a column that could only
-- ever repeat the agent's answer is a column that will one day disagree with it.
alter table public.chat_sessions
  add column if not exists deleted_at  timestamptz,
  add column if not exists deleted_via uuid;

alter table public.routines
  add column if not exists deleted_at  timestamptz,
  add column if not exists deleted_via uuid;

-- Partial indexes: the sweeper and the trash both ask for the rows that ARE
-- deleted, which is nearly none of them. Everything else asks for
-- `deleted_at is null`, which no index helps.
create index if not exists agents_deleted_at_idx
  on public.agents (deleted_at) where deleted_at is not null;
create index if not exists knowledge_bundles_deleted_at_idx
  on public.knowledge_bundles (deleted_at) where deleted_at is not null;
create index if not exists documents_deleted_at_idx
  on public.documents (deleted_at) where deleted_at is not null;
create index if not exists chat_sessions_deleted_via_idx
  on public.chat_sessions (deleted_via) where deleted_via is not null;
create index if not exists routines_deleted_via_idx
  on public.routines (deleted_via) where deleted_via is not null;

-- ===========================================================================
-- 2. Visibility
-- ===========================================================================
--
-- Today deletion is real, so there is nothing to leak. Soft deletion opens a
-- window, and it has to be closed HERE rather than in the API: PostgREST is
-- reachable directly with the anon key that ships in the browser bundle
-- (docs/architecture.md). A `.is("deleted_at", null)` in a route is a
-- courtesy; the policy is the boundary.
--
-- The clause is `deleted_at is null`, for EVERYONE, with no branch admitting
-- the people who could restore it. That is the whole decision in this section
-- and it was made the other way first, so it is worth saying why it moved.
--
-- The obvious shape is `deleted_at is null or can_write_in_workspace(...)`,
-- which lets a trash screen read the rows through the ordinary policy. Its cost
-- is that every existing SELECT in the codebase — the agent list, the bundle
-- page, the document picker, retrieval, export — becomes wrong unless it also
-- carries `.is("deleted_at", null)`, because a member is exactly who runs those
-- queries. That is roughly thirty call sites to get right today and an
-- open-ended number to get right forever: the next query somebody adds is
-- wrong by default, and it fails by showing deleted things rather than by
-- erroring, so nothing catches it.
--
-- Hiding deleted rows from everyone inverts that. Every query in the codebase
-- is correct as written and stays correct, and the one screen that needs the
-- other answer asks for it explicitly, through `workspace_trash()` below —
-- `security definer` with its own permission check, which is the arrangement
-- 0032 already uses for `workspace_usage_all` and for the same reason: reading
-- past RLS is the point, so the function checks for itself.

drop policy if exists "agents_select_workspace_member" on public.agents;
create policy "agents_select_workspace_member"
  on public.agents for select
  using (deleted_at is null and public.is_workspace_member(workspace_id));

drop policy if exists "kb_select_member" on public.knowledge_bundles;
create policy "kb_select_member"
  on public.knowledge_bundles for select
  using (deleted_at is null and public.is_workspace_member(workspace_id));

-- Documents reach their workspace through the bundle, which is where it lives.
-- A bundle's deletion marks its documents, so `documents.deleted_at` alone is
-- the whole question — the bundle's own flag never has to be consulted.
drop policy if exists "documents_select_member" on public.documents;
create policy "documents_select_member"
  on public.documents for select
  using (
    documents.deleted_at is null
    and exists (
      select 1 from public.knowledge_bundles b
      where b.id = documents.bundle_id
        and public.is_workspace_member(b.workspace_id)
    )
  );

-- ---- the one that matters -------------------------------------------------
--
-- Chunks carry the document's text. `dc_select_member` gates on workspace
-- membership and nothing else, so without this change a deleted document's
-- contents stay readable straight from PostgREST by any member — the deletion
-- would remove the row from a list and leave the words behind.
--
drop policy if exists "dc_select_member" on public.document_chunks;
create policy "dc_select_member"
  on public.document_chunks for select
  using (
    public.is_workspace_member(workspace_id)
    and exists (
      select 1 from public.documents d
      where d.id = document_chunks.document_id
        and d.deleted_at is null
    )
  );

-- ---- sessions, and everything hanging off them ----------------------------
--
-- 0031 collapsed eleven policies onto this function precisely so a change like
-- this is one line rather than five. `messages` and `ideas` name it and nothing
-- else, so adding the condition here hides a deleted agent's entire
-- conversation history — transcripts, boards and all — in one place.
--
-- No `can_write_in_workspace` branch: a session is never restorable on its own,
-- so there is no screen that needs to list a deleted one. Deleted means
-- invisible, and the rows come back only when the agent above them does.
create or replace function public.session_is_visible(p_session_id uuid)
returns boolean
language sql
security definer
stable
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.chat_sessions cs
    where cs.id = p_session_id
      and cs.deleted_at is null
      and public.is_workspace_member(cs.workspace_id)
      and (cs.user_id = auth.uid() or cs.visibility = 'shared')
  );
$$;

drop policy if exists "chat_sessions_select_owner_or_shared" on public.chat_sessions;
create policy "chat_sessions_select_owner_or_shared"
  on public.chat_sessions for select
  using (
    deleted_at is null
    and public.is_workspace_member(workspace_id)
    and (user_id = auth.uid() or visibility = 'shared')
  );

drop policy if exists "routines_select_visible" on public.routines;
create policy "routines_select_visible"
  on public.routines for select
  using (
    deleted_at is null
    and (
      user_id = auth.uid()
      or (visibility = 'shared' and public.is_workspace_member(workspace_id))
    )
  );

-- ---- the one screen that asks the other question --------------------------
--
-- Everything above hides deleted rows from everybody, which leaves the trash
-- with no way to read them. This is that way, and it is deliberately the only
-- one: a single function to audit rather than a branch in five policies, and a
-- signature that cannot accidentally be widened by a query somebody writes
-- next year.
--
-- `deleted_via is null` is the filter that makes the list mean something. Only
-- deletions somebody actually performed appear; the documents that went down
-- with a bundle are not separate entries, because they are not separate
-- decisions and restoring the bundle is what brings them back.
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
    union all
    select 'bundle'::text, b.id, b.name, b.deleted_at, b.deleted_by,
           coalesce(p.name, p.email), null::text
      from public.knowledge_bundles b
      left join public.profiles p on p.id = b.deleted_by
     where b.workspace_id = p_workspace_id
       and b.deleted_at is not null
       and b.deleted_via is null
    union all
    select 'document'::text, d.id, d.name, d.deleted_at, d.deleted_by,
           coalesce(p.name, p.email), b.name
      from public.documents d
      join public.knowledge_bundles b on b.id = d.bundle_id
      left join public.profiles p on p.id = d.deleted_by
     where b.workspace_id = p_workspace_id
       and d.deleted_at is not null
       and d.deleted_via is null
    order by 4 desc;
end $$;

revoke all on function public.workspace_trash(uuid) from anon;

-- ===========================================================================
-- 3. Retrieval has to forget too
-- ===========================================================================
--
-- Left alone, `match_chunks` goes on grounding answers in a deleted document —
-- "I deleted it and it is still quoting from it" — which is the worst way this
-- feature can fail, because it looks like the deletion silently did nothing.
--
-- Two conditions, not one, and the second is not redundant. Retrieval scope
-- lives on `document_chunks.bundle_id` rather than on `documents.bundle_id`;
-- that is what makes moving a document between bundles a re-pointing of its
-- chunks (0024), and it means a chunk can name a bundle its document no longer
-- belongs to. Asking both makes a chunk retrievable only while the document it
-- came from and the bundle it is filed under are BOTH alive.
--
-- `security invoker`, so `dc_select_member` above is already the backstop. This
-- is written anyway: the RPC is what people read when they ask what the agent
-- can see, and a retrieval function that does not mention deletion invites the
-- reader to conclude it does not have to.
create or replace function public.match_chunks(
  p_agent_id uuid,
  p_query_embedding vector(1536),
  p_match_count int,
  p_min_similarity float default 0
)
returns table (document_id uuid, document_name text, content text, similarity float)
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select dc.document_id,
         d.name as document_name,
         dc.content,
         1 - (dc.embedding <=> p_query_embedding) as similarity
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
  limit p_match_count;
$$;

-- The engine holds a service-role client that RLS does not constrain, so the
-- policy above does not reach it: without this it would go on running a routine
-- whose agent was deleted, and go on delivering its output to Slack.
create or replace function public.claim_due_routines(
  p_limit int default 10,
  p_stale_after interval default interval '15 minutes'
)
returns setof public.routines
language sql
security definer
set search_path = pg_catalog, public
as $$
  update public.routines r
  set claimed_at = now()
  where r.id in (
    select id from public.routines
    where status = 'active'
      and deleted_at is null
      and next_run_at <= now()
      and (claimed_at is null or claimed_at < now() - p_stale_after)
    order by next_run_at
    for update skip locked
    limit p_limit
  )
  returning r.*;
$$;

revoke all on function public.claim_due_routines(int, interval) from public, anon, authenticated;
grant execute on function public.claim_due_routines(int, interval) to service_role;

-- ===========================================================================
-- 4. Deleting and restoring
-- ===========================================================================
--
-- Marking an agent plus its sessions plus its routines is several statements,
-- and PostgREST offers no transaction across them. Worse,
-- `chat_sessions_update_owner` is keyed to the session's owner, so an API doing
-- this with the caller's client could not mark a colleague's conversations even
-- though it has just deleted the agent underneath them — it would half-succeed
-- and leave orphans on screen.
--
-- So the marking lives here, `security definer`, with each function checking its
-- own permission the way `workspace_usage_all` does in 0032 and raising rather
-- than returning quietly. `security definer` is doing one job and only one:
-- reaching rows the caller's own policies would refuse to update, inside a
-- single statement.
--
-- Three SQLSTATEs, all mapped by the API: 42501 is "you may not", P0002 is
-- "there is no such row, or it is already deleted", P0001 is "not in that
-- order".
--
-- Unlike `claim_due_routines`, whose grant IS its security boundary, these keep
-- the default EXECUTE for `authenticated` — they are meant to be called through
-- PostgREST and they check `can_write_in_workspace` for themselves before
-- touching a row. `anon` is revoked anyway: an anonymous caller has no
-- `auth.uid()` and would be refused on the check, so this removes a call that
-- could only ever fail.

create or replace function public.soft_delete_agent(p_agent_id uuid)
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
  from public.agents
  where id = p_agent_id and deleted_at is null;

  if v_workspace_id is null then
    raise exception 'no such agent' using errcode = 'P0002';
  end if;

  if not public.can_write_in_workspace(v_workspace_id) then
    raise exception 'you cannot delete things in this workspace' using errcode = '42501';
  end if;

  update public.agents
     set deleted_at = v_now, deleted_by = v_actor, deleted_via = null
   where id = p_agent_id;

  -- Bundles are deliberately untouched. A bundle is workspace-level and may be
  -- attached to several agents; deleting an agent has always cascaded the
  -- `agent_bundles` link and left the bundle standing, including the per-agent
  -- `covan:chat-uploads:<agentId>` bundle. That stays true.
  update public.chat_sessions
     set deleted_at = v_now, deleted_via = p_agent_id
   where agent_id = p_agent_id and deleted_at is null;

  update public.routines
     set deleted_at = v_now, deleted_via = p_agent_id
   where agent_id = p_agent_id and deleted_at is null;
end $$;

create or replace function public.restore_agent(p_agent_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_workspace_id uuid;
begin
  select workspace_id into v_workspace_id
  from public.agents
  where id = p_agent_id and deleted_at is not null;

  if v_workspace_id is null then
    raise exception 'no such deleted agent' using errcode = 'P0002';
  end if;

  if not public.can_write_in_workspace(v_workspace_id) then
    raise exception 'you cannot restore things in this workspace' using errcode = '42501';
  end if;

  update public.agents
     set deleted_at = null, deleted_by = null, deleted_via = null
   where id = p_agent_id;

  -- Exactly the rows this agent's deletion hid. A session or routine deleted
  -- some other way is not swept up by somebody else's restore.
  update public.chat_sessions
     set deleted_at = null, deleted_via = null
   where deleted_via = p_agent_id;

  update public.routines
     set deleted_at = null, deleted_via = null
   where deleted_via = p_agent_id;
end $$;

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

  if v_workspace_id is null then
    raise exception 'no such bundle' using errcode = 'P0002';
  end if;

  if not public.can_write_in_workspace(v_workspace_id) then
    raise exception 'you cannot delete things in this workspace' using errcode = '42501';
  end if;

  update public.knowledge_bundles
     set deleted_at = v_now, deleted_by = v_actor, deleted_via = null
   where id = p_bundle_id;

  update public.documents
     set deleted_at = v_now, deleted_by = v_actor, deleted_via = p_bundle_id
   where bundle_id = p_bundle_id and deleted_at is null;
end $$;

create or replace function public.restore_bundle(p_bundle_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_workspace_id uuid;
begin
  select workspace_id into v_workspace_id
  from public.knowledge_bundles
  where id = p_bundle_id and deleted_at is not null;

  if v_workspace_id is null then
    raise exception 'no such deleted bundle' using errcode = 'P0002';
  end if;

  if not public.can_write_in_workspace(v_workspace_id) then
    raise exception 'you cannot restore things in this workspace' using errcode = '42501';
  end if;

  update public.knowledge_bundles
     set deleted_at = null, deleted_by = null, deleted_via = null
   where id = p_bundle_id;

  -- A document somebody deleted on its own before the bundle went keeps its own
  -- deletion. It is in the trash under its own name, where it can be restored
  -- by whoever wants it back.
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
  v_workspace_id uuid;
begin
  select b.workspace_id into v_workspace_id
  from public.documents d
  join public.knowledge_bundles b on b.id = d.bundle_id
  where d.id = p_document_id and d.deleted_at is null;

  if v_workspace_id is null then
    raise exception 'no such document' using errcode = 'P0002';
  end if;

  if not public.can_write_in_workspace(v_workspace_id) then
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
  v_workspace_id uuid;
  v_bundle_deleted timestamptz;
begin
  select b.workspace_id, b.deleted_at into v_workspace_id, v_bundle_deleted
  from public.documents d
  join public.knowledge_bundles b on b.id = d.bundle_id
  where d.id = p_document_id and d.deleted_at is not null;

  if v_workspace_id is null then
    raise exception 'no such deleted document' using errcode = 'P0002';
  end if;

  if not public.can_write_in_workspace(v_workspace_id) then
    raise exception 'you cannot restore things in this workspace' using errcode = '42501';
  end if;

  -- Restoring into a deleted bundle would produce a row visible from nowhere,
  -- which reads as the restore having failed. Say which button to press instead.
  -- P0001, not P0002: the row is there and the caller may have it back. What is
  -- wrong is the order, and a 404 would send them looking for a document that
  -- is sitting in front of them.
  if v_bundle_deleted is not null then
    raise exception 'restore the bundle this document belongs to first'
      using errcode = 'P0001';
  end if;

  update public.documents
     set deleted_at = null, deleted_by = null, deleted_via = null
   where id = p_document_id;
end $$;

revoke all on function public.soft_delete_agent(uuid) from anon;
revoke all on function public.restore_agent(uuid) from anon;
revoke all on function public.soft_delete_bundle(uuid) from anon;
revoke all on function public.restore_bundle(uuid) from anon;
revoke all on function public.soft_delete_document(uuid) from anon;
revoke all on function public.restore_document(uuid) from anon;

-- ===========================================================================
-- 5. The record of who did it
-- ===========================================================================

create table if not exists public.workspace_events (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  actor_id      uuid references public.profiles (id) on delete set null,
  action        text not null,
  subject_type  text not null check (subject_type in ('agent', 'bundle', 'document', 'member', 'invitation')),
  subject_id    uuid,
  -- The thing's name as it was at the time. Thirty days later the sweeper
  -- removes the row and `subject_id` points nowhere; a log that can only say
  -- "an agent was deleted" is not a log. Denormalised on purpose.
  subject_label text not null,
  detail        jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists workspace_events_workspace_created_idx
  on public.workspace_events (workspace_id, created_at desc);

alter table public.workspace_events enable row level security;

-- 0023: from there on a migration that adds a table grants for it, in the same
-- file. SELECT only, and only to authenticated — the rows are written by the
-- triggers below, which run as the owner. Withholding the INSERT grant is a
-- second lock on the same door as "no insert policy exists": either alone would
-- do, and an audit log is the wrong place to rely on either alone.
grant select on public.workspace_events to authenticated;
grant select on public.workspace_events to service_role;

drop policy if exists "workspace_events_select_admin" on public.workspace_events;
create policy "workspace_events_select_admin"
  on public.workspace_events for select
  using (public.is_workspace_admin(workspace_id));

-- No insert, update or delete policy, for anybody. An API that writes its own
-- audit log is an API whose audit log can be skipped by anything that does not
-- go through it — and PostgREST does not go through it. A trigger cannot be
-- routed around.

create or replace function public.log_workspace_event(
  p_workspace_id  uuid,
  p_action        text,
  p_subject_type  text,
  p_subject_id    uuid,
  p_subject_label text,
  p_detail        jsonb default null
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  -- During a workspace cascade the parent row is already gone and the events
  -- are being deleted in the same statement. The same exception
  -- `trg_prevent_last_admin` makes, for the same reason: there is nothing left
  -- to file an event against.
  if not exists (select 1 from public.workspaces w where w.id = p_workspace_id) then
    return;
  end if;

  insert into public.workspace_events
    (workspace_id, actor_id, action, subject_type, subject_id, subject_label, detail)
  values (
    p_workspace_id,
    -- Resolved through profiles rather than taken from auth.uid() directly: a
    -- service-role caller has no uid, and an account mid-deletion has a uid
    -- with no profile row. Either would be a foreign key violation that failed
    -- the operation the log exists to observe.
    (select p.id from public.profiles p where p.id = auth.uid()),
    p_action,
    p_subject_type,
    p_subject_id,
    coalesce(nullif(trim(p_subject_label), ''), '(unnamed)'),
    p_detail
  );
end $$;

revoke all on function public.log_workspace_event(uuid, text, text, uuid, text, jsonb)
  from public, anon, authenticated;

-- ---- deletions and restores ----------------------------------------------
--
-- Fires only when `deleted_via is null`, which is what keeps the log readable:
-- deleting a bundle of two hundred documents writes ONE event, not two hundred
-- and one. The cascaded rows are not separate decisions and reading them as
-- such would bury the decision that was made.

create or replace function public.trg_log_soft_delete()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_workspace_id uuid;
  v_type text;
begin
  if tg_table_name = 'agents' then
    v_type := 'agent';
    v_workspace_id := new.workspace_id;
  elsif tg_table_name = 'knowledge_bundles' then
    v_type := 'bundle';
    v_workspace_id := new.workspace_id;
  else
    v_type := 'document';
    select b.workspace_id into v_workspace_id
    from public.knowledge_bundles b where b.id = new.bundle_id;
  end if;

  if v_workspace_id is null then
    return new;
  end if;

  if old.deleted_at is null and new.deleted_at is not null and new.deleted_via is null then
    perform public.log_workspace_event(
      v_workspace_id, v_type || '.deleted', v_type, new.id, new.name, null);
  elsif old.deleted_at is not null and new.deleted_at is null and old.deleted_via is null then
    perform public.log_workspace_event(
      v_workspace_id, v_type || '.restored', v_type, new.id, new.name, null);
  end if;

  return new;
end $$;

drop trigger if exists trg_agents_log_soft_delete on public.agents;
create trigger trg_agents_log_soft_delete
  after update of deleted_at on public.agents
  for each row when (old.deleted_at is distinct from new.deleted_at)
  execute function public.trg_log_soft_delete();

drop trigger if exists trg_bundles_log_soft_delete on public.knowledge_bundles;
create trigger trg_bundles_log_soft_delete
  after update of deleted_at on public.knowledge_bundles
  for each row when (old.deleted_at is distinct from new.deleted_at)
  execute function public.trg_log_soft_delete();

drop trigger if exists trg_documents_log_soft_delete on public.documents;
create trigger trg_documents_log_soft_delete
  after update of deleted_at on public.documents
  for each row when (old.deleted_at is distinct from new.deleted_at)
  execute function public.trg_log_soft_delete();

-- ---- membership -----------------------------------------------------------
--
-- `member.removed` and `member.left` are the same DELETE. They are told apart
-- by whether the caller is the row's own user, because being removed and
-- choosing to go are different events to everyone involved and the row is
-- identical. `workspace_members_delete_self` (0020) is the policy that makes
-- the second one reachable at all.
--
-- No INSERT trigger. A membership row is written by the signup trigger, by
-- `create_workspace`, and by `accept_invitation` — the first two are somebody
-- making their own workspace, which is not an event about a team, and the third
-- is logged as `member.joined` from the invitation side where the inviter and
-- the role are both in scope.

create or replace function public.trg_log_membership()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_label text;
  v_user_id uuid;
begin
  v_user_id := coalesce(new.user_id, old.user_id);

  select coalesce(p.name, p.email, '(unknown)') into v_label
  from public.profiles p where p.id = v_user_id;

  if tg_op = 'UPDATE' then
    perform public.log_workspace_event(
      new.workspace_id, 'member.role_changed', 'member', new.user_id,
      coalesce(v_label, '(unknown)'),
      jsonb_build_object('from', old.role, 'to', new.role));
    return new;
  end if;

  perform public.log_workspace_event(
    old.workspace_id,
    case when auth.uid() = old.user_id then 'member.left' else 'member.removed' end,
    'member', old.user_id, coalesce(v_label, '(unknown)'),
    jsonb_build_object('role', old.role));
  return old;
end $$;

drop trigger if exists trg_workspace_members_log_role on public.workspace_members;
create trigger trg_workspace_members_log_role
  after update of role on public.workspace_members
  for each row when (old.role is distinct from new.role)
  execute function public.trg_log_membership();

drop trigger if exists trg_workspace_members_log_delete on public.workspace_members;
create trigger trg_workspace_members_log_delete
  after delete on public.workspace_members
  for each row execute function public.trg_log_membership();

-- ---- invitations ----------------------------------------------------------
--
-- Revoking is a hard delete (docs/team.md), so the revoke event has to come off
-- a DELETE trigger. An accepted invitation is never deleted, which is what lets
-- `member.joined` come from an UPDATE of the same row.

create or replace function public.trg_log_invitation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'INSERT' then
    perform public.log_workspace_event(
      new.workspace_id, 'invitation.created', 'invitation', new.id, new.email,
      jsonb_build_object('role', new.role));
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if new.status = 'accepted' and old.status <> 'accepted' then
      perform public.log_workspace_event(
        new.workspace_id, 'member.joined', 'member', new.accepted_by, new.email,
        jsonb_build_object('role', new.role));
    end if;
    return new;
  end if;

  perform public.log_workspace_event(
    old.workspace_id, 'invitation.revoked', 'invitation', old.id, old.email,
    jsonb_build_object('role', old.role));
  return old;
end $$;

drop trigger if exists trg_invitations_log on public.invitations;
create trigger trg_invitations_log
  after insert or delete on public.invitations
  for each row execute function public.trg_log_invitation();

drop trigger if exists trg_invitations_log_accept on public.invitations;
create trigger trg_invitations_log_accept
  after update of status on public.invitations
  for each row when (old.status is distinct from new.status)
  execute function public.trg_log_invitation();

-- ---- one function 0038 wrote before documents could be deleted ------------
--
-- `document_citation_counts` is `security definer`, so RLS is off for its body
-- and the policies above do not reach it. Left alone it answers for deleted
-- documents too — handing back their ids and how heavily they were used, which
-- is a small but exact statement about a file the caller has just been told is
-- gone. The caller happens not to render it today, because it lists documents
-- it can see and looks counts up against them; that is the caller's shape
-- rather than a guarantee, and it is the kind that changes.
--
-- Patched here rather than in 0038 because this migration is what made a
-- document deletable, and a consequence belongs with its cause.
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
    -- Replies inside a deleted agent's conversations still happened, and the
    -- document they cite is still there; excluding them would make a count
    -- drop when somebody deletes an unrelated agent, and reappear on restore.
    and s.workspace_id = b.workspace_id
    and public.is_workspace_member(b.workspace_id)
  group by d.id;
$$;

-- ===========================================================================
-- 6. The sweeper's half of the bargain
-- ===========================================================================
--
-- After thirty days a marked row is deleted for real, which is where the
-- existing foreign keys take over and do what they always did. The Worker runs
-- it (worker/src/lib/purge.ts) because it also has to delete the stored
-- objects, and it collects their keys BEFORE deleting the rows — afterwards
-- there is nothing left to enumerate them by. `worker/src/routes/account.ts`
-- has followed that order since account closure existed.
--
-- This function exists so the window is defined in one place rather than in a
-- constant on each side of the boundary.
create or replace function public.purge_horizon()
returns timestamptz
language sql
stable
set search_path = pg_catalog, public
as $$
  select now() - interval '30 days';
$$;
