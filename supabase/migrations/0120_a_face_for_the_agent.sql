-- =========================================================================
-- A face for the agent
--
-- The redesign gives every agent one of eight ink marks (DESIGN.md §5, the
-- A12 board) instead of an emoji. `avatar` holds the mark's name; null is
-- "none picked", which the interface draws as the agent's two-letter
-- monogram. `emoji` stays in the schema and is no longer read: existing rows
-- keep what they had, and nothing is gained by forgetting it.
--
-- `text` with a check rather than an enum, for 0017's reason: the list changes
-- faster than the schema should. The API validates against the same eight
-- names (`AVATAR_MARKS` in worker/src/lib/dto.ts).
--
-- And `agent_delete_summary`, so the delete dialog can say what a delete takes
-- with it before anybody presses it: "Its 19 threads stay readable for 30 days
-- under Recently deleted, then go. The 2 routines pointed at it stop now. The
-- 3 folders it reads are not touched." Counts, never titles, and only for
-- somebody who could delete the agent — the same `manage` test
-- `soft_delete_agent` (0104) applies, so the sentence is offered to exactly
-- the people the button is.
-- =========================================================================

alter table public.agents
  add column if not exists avatar text;

alter table public.agents
  drop constraint if exists agents_avatar_check;
alter table public.agents
  add constraint agents_avatar_check
  check (avatar is null or avatar in (
    'headset', 'fox', 'owl', 'bear', 'cat', 'robot', 'penguin', 'blob'
  ));

-- Chosen when the agent is made and changed under Identity in Configuration:
-- both writes go through the caller's own client, like `name` beside it (0094).
grant insert (avatar) on public.agents to authenticated;
grant update (avatar) on public.agents to authenticated;

create or replace function public.agent_delete_summary(p_agent_id uuid)
returns table (threads integer, routines integer, folders integer)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_access text;
begin
  if not exists (select 1 from public.agents where id = p_agent_id and deleted_at is null) then
    raise exception 'no such agent' using errcode = 'P0002';
  end if;

  v_access := public.agent_access(p_agent_id);
  if v_access is null then
    raise exception 'no such agent' using errcode = 'P0002';
  end if;
  if v_access <> 'manage' then
    raise exception 'you cannot delete this agent' using errcode = '42501';
  end if;

  return query
  select
    (select count(*)::integer from public.chat_sessions s
      where s.agent_id = p_agent_id and s.deleted_at is null),
    (select count(*)::integer from public.routines r
      where r.agent_id = p_agent_id and r.deleted_at is null),
    (select count(*)::integer from public.agent_bundles ab
      where ab.agent_id = p_agent_id);
end $$;

revoke all on function public.agent_delete_summary(uuid) from public, anon;
grant execute on function public.agent_delete_summary(uuid) to authenticated, service_role;
