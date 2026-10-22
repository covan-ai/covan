-- =========================================================================
-- Who counts what
--
-- Home (the Main board) opens with numbers: threads this week against last,
-- routine runs done and failed, what each agent spent, who on the team is
-- using it. Each is a count across the workspace, which no member's own view
-- of `chat_sessions` can give — a colleague's private thread is invisible to
-- them, and must stay invisible. So each number is a definer function that
-- counts and returns the count, never a title, a message or a session id.
--
-- Two audiences, and the line between them is 0032's:
--
--   any member   how many threads the team started, how many routine runs
--                finished, how many threads each agent they can use had.
--   admins       anything with money in it (`workspace_spend_daily`, priced by
--                the API from the models and token counts it returns, exactly
--                as `GET /usage/workspace` prices its months), and anything
--                with a person in it (`workspace_threads_by_member`: counts
--                per member, never titles).
--
-- And `agent_knowledge_usage`: for each folder an agent reads, how many of its
-- replies in a window cited something in it ("9 files · used in 61 replies
-- this month", A32). Counted the way `document_citation_counts` (0106) counts:
-- a reply whose sources name a document in the folder.
-- =========================================================================

create or replace function public.home_counts(p_workspace_id uuid, p_days integer default 7)
returns table (
  threads_window   integer,
  threads_previous integer,
  runs_total       integer,
  runs_done        integer,
  runs_failed      integer
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_days interval := make_interval(days => greatest(1, least(coalesce(p_days, 7), 90)));
begin
  if auth.uid() is null or not public.is_workspace_member(p_workspace_id) then
    raise exception 'not a member of this workspace' using errcode = '42501';
  end if;

  return query
  select
    (select count(*)::integer from public.chat_sessions s
      where s.workspace_id = p_workspace_id and s.kind in ('chat', 'brainstorm')
        and s.created_at >= now() - v_days),
    (select count(*)::integer from public.chat_sessions s
      where s.workspace_id = p_workspace_id and s.kind in ('chat', 'brainstorm')
        and s.created_at >= now() - 2 * v_days and s.created_at < now() - v_days),
    (select count(*)::integer from public.routine_runs r join public.routines ro on ro.id = r.routine_id
      where ro.workspace_id = p_workspace_id and r.status in ('ok', 'failed')
        and r.started_at >= now() - v_days),
    (select count(*)::integer from public.routine_runs r join public.routines ro on ro.id = r.routine_id
      where ro.workspace_id = p_workspace_id and r.status = 'ok'
        and r.started_at >= now() - v_days),
    (select count(*)::integer from public.routine_runs r join public.routines ro on ro.id = r.routine_id
      where ro.workspace_id = p_workspace_id and r.status = 'failed'
        and r.started_at >= now() - v_days);
end $$;

-- Threads per agent in the window, for the agents the caller can use.
create or replace function public.home_agent_threads(p_workspace_id uuid, p_days integer default 7)
returns table (agent_id uuid, threads integer)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_days interval := make_interval(days => greatest(1, least(coalesce(p_days, 7), 90)));
begin
  if auth.uid() is null or not public.is_workspace_member(p_workspace_id) then
    raise exception 'not a member of this workspace' using errcode = '42501';
  end if;

  return query
  select a.id, count(s.id)::integer
    from public.agents a
    left join public.chat_sessions s
      on s.agent_id = a.id and s.kind in ('chat', 'brainstorm') and s.created_at >= now() - v_days
   where a.workspace_id = p_workspace_id
     and a.deleted_at is null
     and public.can_use_agent(a.id)
   group by a.id;
end $$;

-- What the workspace spent per day, per agent, per model, from the token
-- counts each reply recorded. Admins only (0032). Every reply, the deleted
-- threads' included: the money was spent either way.
create or replace function public.workspace_spend_daily(p_workspace_id uuid, p_days integer default 14)
returns table (
  day                date,
  agent_id           uuid,
  model              text,
  prompt_tokens      bigint,
  completion_tokens  bigint,
  cached_tokens      bigint,
  cache_write_tokens bigint
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if auth.uid() is null or not public.is_workspace_admin(p_workspace_id) then
    raise exception 'admins only' using errcode = '42501';
  end if;

  return query
  select (m.created_at at time zone 'UTC')::date,
         s.agent_id,
         m.model,
         coalesce(sum(m.prompt_tokens), 0)::bigint,
         coalesce(sum(m.completion_tokens), 0)::bigint,
         coalesce(sum(m.cached_tokens), 0)::bigint,
         coalesce(sum(m.cache_write_tokens), 0)::bigint
    from public.messages m
    join public.chat_sessions s on s.id = m.session_id
   where s.workspace_id = p_workspace_id
     and m.role = 'assistant'
     and m.created_at >= (now() at time zone 'UTC')::date - (greatest(1, least(coalesce(p_days, 14), 90)) - 1)
     and (m.prompt_tokens is not null or m.completion_tokens is not null)
   group by 1, 2, 3;
end $$;

-- Threads each member started in the window. Admins only, counts only.
create or replace function public.workspace_threads_by_member(p_workspace_id uuid, p_days integer default 7)
returns table (user_id uuid, name text, avatar_url text, threads integer)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_days interval := make_interval(days => greatest(1, least(coalesce(p_days, 7), 90)));
begin
  if auth.uid() is null or not public.is_workspace_admin(p_workspace_id) then
    raise exception 'admins only' using errcode = '42501';
  end if;

  return query
  select wm.user_id, p.name, p.avatar_url, count(s.id)::integer
    from public.workspace_members wm
    left join public.profiles p on p.id = wm.user_id
    left join public.chat_sessions s
      on s.user_id = wm.user_id and s.workspace_id = p_workspace_id
     and s.kind in ('chat', 'brainstorm') and s.created_at >= now() - v_days
   where wm.workspace_id = p_workspace_id
   group by wm.user_id, p.name, p.avatar_url;
end $$;

-- For each folder an agent reads, the replies in the window that cited it.
create or replace function public.agent_knowledge_usage(p_agent_id uuid, p_days integer default 30)
returns table (bundle_id uuid, replies integer)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_days interval := make_interval(days => greatest(1, least(coalesce(p_days, 30), 365)));
begin
  if auth.uid() is null or not public.can_use_agent(p_agent_id) then
    raise exception 'no such agent' using errcode = 'P0002';
  end if;

  return query
  select ab.bundle_id,
         (select count(distinct m.id)::integer
            from public.chat_sessions s
            join public.messages m on m.session_id = s.id
           where s.agent_id = p_agent_id
             and m.role = 'assistant'
             and m.created_at >= now() - v_days
             and m.sources is not null
             and exists (
               select 1 from public.documents d
                where d.bundle_id = ab.bundle_id
                  and m.sources @> jsonb_build_array(jsonb_build_object('id', d.id::text))
             ))
    from public.agent_bundles ab
   where ab.agent_id = p_agent_id
     and public.bundle_is_visible(ab.bundle_id);
end $$;

revoke all on function public.home_counts(uuid, integer) from public, anon;
grant execute on function public.home_counts(uuid, integer) to authenticated, service_role;
revoke all on function public.home_agent_threads(uuid, integer) from public, anon;
grant execute on function public.home_agent_threads(uuid, integer) to authenticated, service_role;
revoke all on function public.workspace_spend_daily(uuid, integer) from public, anon;
grant execute on function public.workspace_spend_daily(uuid, integer) to authenticated, service_role;
revoke all on function public.workspace_threads_by_member(uuid, integer) from public, anon;
grant execute on function public.workspace_threads_by_member(uuid, integer) to authenticated, service_role;
revoke all on function public.agent_knowledge_usage(uuid, integer) from public, anon;
grant execute on function public.agent_knowledge_usage(uuid, integer) to authenticated, service_role;
