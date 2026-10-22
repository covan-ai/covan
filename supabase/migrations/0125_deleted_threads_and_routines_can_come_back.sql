-- =========================================================================
-- Deleted threads and routines can come back
--
-- Agents, folders and documents have gone to a thirty-day trash since 0040;
-- a thread or a routine deleted on its own was gone the moment the button
-- was pressed, messages and run history with it. The redesign's Recently
-- deleted (A27) lists all five, with Restore and the days left, so threads
-- and routines learn what agents already know:
--
--   * `soft_delete_session` / `restore_session` and `soft_delete_routine` /
--     `restore_routine`, the owner's alone — a shared thread is still its
--     starter's to throw away, as it is theirs to share. The shape of
--     `soft_delete_agent` (0104): the refusals are raised, never a silent
--     "0 rows", and `deleted_via` stays null, which is what marks a thing
--     deleted on its own rather than with its agent.
--   * `deleted_by`, so the list can say who.
--   * `workspace_trash` lists them, each to its owner only.
--
-- A routine comes back paused. It may have been listening for an event whose
-- subscription its deletion released (0109), and a routine that quietly
-- resumed sending after a month is a surprise nobody asked for; Resume is one
-- press. The sweeper (worker/src/lib/purge.ts) takes both for good after
-- thirty days.
-- =========================================================================

alter table public.chat_sessions
  add column if not exists deleted_by uuid references auth.users (id) on delete set null;
alter table public.routines
  add column if not exists deleted_by uuid references auth.users (id) on delete set null;

create or replace function public.soft_delete_session(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_owner uuid;
begin
  select s.user_id into v_owner
    from public.chat_sessions s
   where s.id = p_session_id and s.deleted_at is null;

  if v_owner is null or not public.session_is_visible(p_session_id) then
    raise exception 'no such thread' using errcode = 'P0002';
  end if;
  if v_owner is distinct from auth.uid() then
    raise exception 'only whoever started a thread can delete it' using errcode = '42501';
  end if;

  update public.chat_sessions
     set deleted_at = now(), deleted_by = auth.uid(), deleted_via = null
   where id = p_session_id;
end $$;

create or replace function public.restore_session(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_owner uuid;
  v_workspace uuid;
  v_agent uuid;
begin
  select s.user_id, s.workspace_id, s.agent_id into v_owner, v_workspace, v_agent
    from public.chat_sessions s
   where s.id = p_session_id and s.deleted_at is not null and s.deleted_via is null;

  if v_owner is null or v_owner is distinct from auth.uid()
     or not public.is_workspace_member(v_workspace) then
    raise exception 'no such deleted thread' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.agents a where a.id = v_agent and a.deleted_at is not null) then
    raise exception 'restore its agent first' using errcode = '22023';
  end if;

  update public.chat_sessions
     set deleted_at = null, deleted_by = null
   where id = p_session_id;
end $$;

create or replace function public.soft_delete_routine(p_routine_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_owner uuid;
  v_workspace uuid;
begin
  select r.user_id, r.workspace_id into v_owner, v_workspace
    from public.routines r
   where r.id = p_routine_id and r.deleted_at is null;

  if v_owner is null or not public.is_workspace_member(v_workspace) then
    raise exception 'no such routine' using errcode = 'P0002';
  end if;
  if v_owner is distinct from auth.uid() then
    raise exception 'only whoever made a routine can delete it' using errcode = '42501';
  end if;

  update public.routines
     set deleted_at = now(), deleted_by = auth.uid(), deleted_via = null, claimed_at = null
   where id = p_routine_id;
end $$;

create or replace function public.restore_routine(p_routine_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_owner uuid;
  v_workspace uuid;
  v_agent uuid;
begin
  select r.user_id, r.workspace_id, r.agent_id into v_owner, v_workspace, v_agent
    from public.routines r
   where r.id = p_routine_id and r.deleted_at is not null and r.deleted_via is null;

  if v_owner is null or v_owner is distinct from auth.uid()
     or not public.is_workspace_member(v_workspace) then
    raise exception 'no such deleted routine' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.agents a where a.id = v_agent and a.deleted_at is not null) then
    raise exception 'restore its agent first' using errcode = '22023';
  end if;

  update public.routines
     set deleted_at = null, deleted_by = null,
         status = case when status = 'completed' then status else 'paused' end,
         paused_reason = case when status = 'completed' then paused_reason
                              else 'Restored from Recently deleted. Resume it to run again.' end
   where id = p_routine_id;
end $$;

-- The trash, with the owner's own threads and routines in it.
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
    union all
    select 'session'::text, s.id, coalesce(s.title, 'Untitled thread'), s.deleted_at, s.deleted_by,
           coalesce(p.name, p.email), a.name
      from public.chat_sessions s
      join public.agents a on a.id = s.agent_id
      left join public.profiles p on p.id = s.deleted_by
     where s.workspace_id = p_workspace_id
       and s.deleted_at is not null
       and s.deleted_via is null
       and s.user_id = auth.uid()
    union all
    select 'routine'::text, r.id, r.name, r.deleted_at, r.deleted_by,
           coalesce(p.name, p.email), a.name
      from public.routines r
      join public.agents a on a.id = r.agent_id
      left join public.profiles p on p.id = r.deleted_by
     where r.workspace_id = p_workspace_id
       and r.deleted_at is not null
       and r.deleted_via is null
       and r.user_id = auth.uid()
    order by 4 desc;
end $$;

revoke all on function public.soft_delete_session(uuid) from public, anon;
grant execute on function public.soft_delete_session(uuid) to authenticated, service_role;
revoke all on function public.restore_session(uuid) from public, anon;
grant execute on function public.restore_session(uuid) to authenticated, service_role;
revoke all on function public.soft_delete_routine(uuid) from public, anon;
grant execute on function public.soft_delete_routine(uuid) to authenticated, service_role;
revoke all on function public.restore_routine(uuid) from public, anon;
grant execute on function public.restore_routine(uuid) to authenticated, service_role;
revoke all on function public.workspace_trash(uuid) from public, anon;
grant execute on function public.workspace_trash(uuid) to authenticated, service_role;
