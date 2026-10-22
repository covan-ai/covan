-- =========================================================================
-- What was asked and not written down
--
-- Settings › Coverage (A18) and an agent's Knowledge tab (A32) ask three
-- things the counts so far could not answer:
--
--   * "Documents worth revisiting — old enough to doubt, used enough to
--     matter": how many replies cited each document in the last 30 days.
--     0038's count is all of history; `document_citation_counts_since` is the
--     same count over a window, for the same callers — any member, numbers
--     only, across private threads as 0038 argued.
--   * The coverage bars per agent, now with each agent's mark (0120) and
--     without the deleted ones: 0053's function kept every agent the
--     workspace ever had, and its emoji. Replaced, not altered, because what
--     it returns changes; still the admin's alone.
--   * "Asked, not covered" on an agent's own Knowledge tab: how its replies
--     in the window were grounded. For anybody who can use the agent, as
--     `agent_knowledge_usage` (0124) is — counts, never who asked or what.
-- =========================================================================

create or replace function public.document_citation_counts_since(
  p_bundle_ids uuid[],
  p_days       integer default 30
)
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
     and s.workspace_id = b.workspace_id
     and s.deleted_at is null
     and public.is_workspace_member(b.workspace_id)
     and public.bundle_is_visible(b.id)
     and m.role = 'assistant'
     and m.created_at >= now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 365)))
   group by d.id;
$$;

drop function if exists public.workspace_coverage_agents(uuid, integer);
create function public.workspace_coverage_agents(p_workspace_id uuid, p_days integer default 30)
returns table (
  agent_id     uuid,
  agent_name   text,
  agent_emoji  text,
  agent_avatar text,
  answers      bigint,
  covered      bigint,
  fallback     bigint,
  ungrounded   bigint
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_days int := greatest(1, least(coalesce(p_days, 30), 365));
  v_since timestamptz := now() - make_interval(days => v_days);
begin
  if not public.is_workspace_admin(p_workspace_id) then
    raise exception 'not an admin of this workspace' using errcode = '42501';
  end if;

  return query
  select a.id,
         a.name,
         a.emoji,
         a.avatar,
         count(m.id) filter (where m.grounding is not null),
         count(m.id) filter (where m.grounding = 'chunks'),
         count(m.id) filter (where m.grounding = 'documents'),
         count(m.id) filter (where m.grounding = 'none')
    from public.agents a
    left join public.chat_sessions s
      on s.agent_id = a.id
     and s.deleted_at is null
    left join public.messages m
      on m.session_id = s.id
     and m.role = 'assistant'
     and m.created_at >= v_since
   where a.workspace_id = p_workspace_id
     and a.deleted_at is null
   group by a.id, a.name, a.emoji, a.avatar
   order by (count(m.id) filter (where m.grounding in ('documents', 'none'))) desc,
            count(m.id) desc,
            a.name;
end;
$$;

create or replace function public.agent_coverage(p_agent_id uuid, p_days integer default 30)
returns table (answers bigint, covered bigint, fallback bigint, ungrounded bigint)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if auth.uid() is null or not public.can_use_agent(p_agent_id) then
    raise exception 'no such agent' using errcode = 'P0002';
  end if;

  return query
  select count(*) filter (where m.grounding is not null),
         count(*) filter (where m.grounding = 'chunks'),
         count(*) filter (where m.grounding = 'documents'),
         count(*) filter (where m.grounding = 'none')
    from public.chat_sessions s
    join public.messages m on m.session_id = s.id
   where s.agent_id = p_agent_id
     and s.deleted_at is null
     and m.role = 'assistant'
     and m.created_at >= now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 365)));
end $$;

revoke all on function public.document_citation_counts_since(uuid[], integer) from public, anon;
grant execute on function public.document_citation_counts_since(uuid[], integer) to authenticated, service_role;
revoke all on function public.workspace_coverage_agents(uuid, integer) from public, anon;
grant execute on function public.workspace_coverage_agents(uuid, integer) to authenticated, service_role;
revoke all on function public.agent_coverage(uuid, integer) from public, anon;
grant execute on function public.agent_coverage(uuid, integer) to authenticated, service_role;
