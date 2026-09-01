-- 0032_what_the_workspace_costs.sql
--
-- `workspace_usage` scopes every figure to the caller, and 0022 went to some
-- trouble to make sure it keeps doing that even as sharing changed underneath
-- it. The Usage section says so in its own heading: "Yours alone".
--
-- That is right for a product whose conversations are private, and it leaves
-- the person paying the OpenAI bill unable to see what the workspace spends,
-- which agent is expensive, or whether one is quietly costing more than the
-- rest put together. It hurts a self-hoster most: they are the one holding the
-- invoice, and they have no billing console to go and look at instead.
--
-- **By agent and by month. Never by person.** These functions cannot report
-- who spent what, and that is a property of their shape rather than a rule the
-- interface is asked to follow: `user_id` is not selected, not grouped by, and
-- not returned. Token counts are not conversation content, but a table of who
-- spent what is still the wrong thing to hand an admin in a product that
-- promises private rooms — the signal is the problem, not the data.
--
-- SECURITY DEFINER, because that is the whole point: an admin's own RLS view
-- of `chat_sessions` deliberately excludes their colleagues' private sessions,
-- which is exactly the traffic being asked about. So each function checks for
-- itself that the caller is an admin of the workspace it was handed, before
-- reading anything. `is_workspace_admin` is the same helper the invitation and
-- membership policies use, so there is one answer to "is this person an admin"
-- and not two.
--
-- The guard raises rather than returning no rows. A silent empty result is
-- indistinguishable from a workspace that has never sent a message, and the
-- route needs to tell 403 from "nothing yet".
--
-- Idempotent, because CI does not apply migrations — this is hand-applied and
-- may well be pasted twice. Both functions are dropped by exact signature and
-- recreated, the same shape 0025 used when it replaced `workspace_usage`.

drop function if exists public.workspace_usage_all(uuid);
drop function if exists public.workspace_usage_monthly(uuid, int);

-- ---- workspace_usage_all --------------------------------------------------
-- The same columns as `workspace_usage`, so one renderer can read either, and
-- the same LEFT JOIN discipline: an agent nobody has chatted with keeps
-- appearing at zero rather than dropping out of the list. The only difference
-- that matters is the missing `s.user_id = auth.uid()` in the session join.
create function public.workspace_usage_all(p_workspace_id uuid)
returns table (
  agent_id uuid,
  agent_name text,
  agent_emoji text,
  agent_model text,
  message_count bigint,
  prompt_tokens bigint,
  completion_tokens bigint,
  cached_tokens bigint,
  measured_prompt_tokens bigint
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if not public.is_workspace_admin(p_workspace_id) then
    raise exception 'not an admin of this workspace' using errcode = '42501';
  end if;

  return query
  select a.id,
         a.name,
         a.emoji,
         a.model,
         count(m.id) as message_count,
         coalesce(sum(m.prompt_tokens), 0) as prompt_tokens,
         coalesce(sum(m.completion_tokens), 0) as completion_tokens,
         coalesce(sum(m.cached_tokens), 0) as cached_tokens,
         -- The denominator a cache hit rate has to be divided by; 0025
         -- explains why it is not `prompt_tokens`.
         coalesce(sum(m.prompt_tokens) filter (where m.cached_tokens is not null), 0)
           as measured_prompt_tokens
  from public.agents a
  left join public.chat_sessions s on s.agent_id = a.id
  left join public.messages m on m.session_id = s.id and m.role = 'assistant'
  where a.workspace_id = p_workspace_id
  group by a.id, a.name, a.emoji, a.model
  order by (coalesce(sum(m.prompt_tokens), 0) + coalesce(sum(m.completion_tokens), 0)) desc;
end;
$$;

-- ---- workspace_usage_monthly ----------------------------------------------
-- Everything the product shows today is either a lifetime total or the current
-- month, with nothing in between — so "are we spending more than we were" has
-- never had an answer. Buckets by the month a reply was stored, newest last,
-- so a renderer can draw them left to right without reversing anything.
--
-- `generate_series` rather than a plain group-by: a month in which nobody sent
-- anything has to appear as a zero, not as a gap. A chart that silently closes
-- up a quiet month makes a fall in spend look like a flat line.
create function public.workspace_usage_monthly(p_workspace_id uuid, p_months int default 6)
returns table (
  month date,
  message_count bigint,
  prompt_tokens bigint,
  completion_tokens bigint,
  cached_tokens bigint
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_months int := greatest(1, least(coalesce(p_months, 6), 24));
begin
  if not public.is_workspace_admin(p_workspace_id) then
    raise exception 'not an admin of this workspace' using errcode = '42501';
  end if;

  return query
  with span as (
    select generate_series(
             date_trunc('month', now()) - make_interval(months => v_months - 1),
             date_trunc('month', now()),
             interval '1 month'
           ) as bucket
  )
  select span.bucket::date,
         count(m.id) as message_count,
         coalesce(sum(m.prompt_tokens), 0) as prompt_tokens,
         coalesce(sum(m.completion_tokens), 0) as completion_tokens,
         coalesce(sum(m.cached_tokens), 0) as cached_tokens
  from span
  left join public.messages m
    on m.role = 'assistant'
   and date_trunc('month', m.created_at) = span.bucket
   and exists (
         select 1
         from public.chat_sessions s
         join public.agents a on a.id = s.agent_id
         where s.id = m.session_id
           and a.workspace_id = p_workspace_id
       )
  group by span.bucket
  order by span.bucket;
end;
$$;

-- ---- who may execute ------------------------------------------------------
-- A newly created function grants EXECUTE to `public` by default, which on a
-- SECURITY DEFINER function reading other people's sessions is not something
-- to leave to the default. The guard inside would refuse an anonymous caller
-- anyway — `auth.uid()` is null, so `is_workspace_admin` is false — but a
-- definer function should not be reachable by a role that can never pass its
-- own check.
--
-- Deliberately narrower than `workspace_usage`, which carries `anon` from
-- 0025; that grant exists to preserve a state the database was already in, and
-- is not a precedent for a new function.
revoke execute on function public.workspace_usage_all(uuid) from public;
revoke execute on function public.workspace_usage_monthly(uuid, int) from public;
grant execute on function public.workspace_usage_all(uuid) to authenticated, service_role;
grant execute on function public.workspace_usage_monthly(uuid, int) to authenticated, service_role;
