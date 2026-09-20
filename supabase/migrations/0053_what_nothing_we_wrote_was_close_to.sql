-- 0053_what_nothing_we_wrote_was_close_to.sql
--
-- 0039 added `messages.grounding` and said what it was for: covan#44 wants to
-- report what a team asked that its own written knowledge does not cover, so
-- somebody can see what to write down next. The column has been filling up
-- since. Nothing reads it. This is the read.
--
-- Two functions, the same shape as 0032's pair and for the same reason. The
-- question is "how were this workspace's answers grounded", and a workspace's
-- answers live mostly in sessions the caller cannot see — chats are private by
-- default (0008), so an admin's own RLS view of `messages` excludes exactly the
-- traffic being asked about. SECURITY DEFINER, and each function checks for
-- itself that the caller is an admin before reading anything.
--
-- **By agent and by window. Never by person, and never the question itself.**
-- Neither function selects, groups by or returns a `user_id`, and neither
-- returns a word of anybody's content. That is a property of their shape
-- rather than a rule the interface is asked to follow — the same trade 0038
-- named when it counted citations across private sessions.
--
-- That bound is what this migration is, and it is worth being exact about what
-- it costs. #44 as written wants the unanswered questions *listed*, and a list
-- of questions is a list of what colleagues typed in private rooms. Handing
-- that to an admin would take the product's one structural promise apart to
-- build a report. So the numbers ship here without consent because they
-- disclose nothing, and the questions behind them are a separate feature with
-- a consent step in front of it: the person who asked decides whether their
-- question joins the team's gap list. A count cannot identify anybody; the
-- sentence they typed can.
--
-- ---- what the four buckets mean -------------------------------------------
--
-- 0039 records one of three values per assistant reply, and the fourth bucket
-- here is the absence of one:
--
--   covered     'chunks'    — a passage cleared the similarity floor. Somebody
--                             had written something *for this question*.
--   fallback    'documents' — nothing cleared the floor, so whole documents
--                             went instead, newest first. The answer is often
--                             right, and no passage in the team's knowledge
--                             was close to what was asked. This is the number
--                             the report exists for.
--   ungrounded  'none'      — nothing grounded it at all. A setup problem (no
--                             bundle attached, nothing uploaded) rather than a
--                             coverage one, which is why it is counted apart
--                             from `fallback` instead of added to it.
--   unrecorded   null       — nobody recorded one: every reply written before
--                             0039, and any surface that does not set it.
--
-- `unrecorded` is returned rather than dropped on purpose. A rate computed
-- over "replies that carry a grounding" is honest only if the caller can see
-- how many did not, and a workspace whose history predates 0039 would
-- otherwise read its first report as a census when it is a sample. The
-- interface prints it; `answers` is the denominator and excludes it.
--
-- Idempotent — CI does not apply migrations, so this is hand-applied and may
-- well be pasted twice. Dropped by exact signature and recreated, the shape
-- 0032 used.

drop function if exists public.workspace_coverage(uuid, int);
drop function if exists public.workspace_coverage_agents(uuid, int);

-- ---- workspace_coverage ----------------------------------------------------
-- One row: the whole workspace over a window of days.
--
-- The window is the point of the feature rather than a parameter on it. "What
-- is this team asking that we have not written down" is a question about now —
-- a lifetime figure buries a month of new questions under a year of answered
-- ones, and a gap closed in March should stop being reported in September.
create function public.workspace_coverage(p_workspace_id uuid, p_days int default 30)
returns table (
  answers bigint,
  covered bigint,
  fallback bigint,
  ungrounded bigint,
  unrecorded bigint
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  -- Clamped here as well as in the route. The route is one caller of several —
  -- an API key holds the same access a person does (0033) — and a function
  -- that reads across every private session in a workspace should not take an
  -- unbounded integer from any of them.
  v_days int := greatest(1, least(coalesce(p_days, 30), 365));
  v_since timestamptz := now() - make_interval(days => v_days);
begin
  if not public.is_workspace_admin(p_workspace_id) then
    raise exception 'not an admin of this workspace' using errcode = '42501';
  end if;

  return query
  select count(*) filter (where m.grounding is not null),
         count(*) filter (where m.grounding = 'chunks'),
         count(*) filter (where m.grounding = 'documents'),
         count(*) filter (where m.grounding = 'none'),
         count(*) filter (where m.grounding is null)
  from public.messages m
  join public.chat_sessions s on s.id = m.session_id
  where s.workspace_id = p_workspace_id
    and m.role = 'assistant'
    and m.created_at >= v_since;
end;
$$;

-- ---- workspace_coverage_agents ---------------------------------------------
-- The same figures per agent, because the workspace number on its own does not
-- say what to do. One agent starved of documents drags the whole rate down and
-- looks, from the total alone, like a knowledge problem everywhere.
--
-- LEFT JOIN from `agents`, the discipline 0032 uses: an agent nobody asked
-- anything in the window stays in the list at zero rather than dropping out.
-- "Nobody used this one" is also an answer, and a list that silently omits it
-- cannot give it.
--
-- Ordered by the misses, so the agent most in need of somebody writing
-- something down is first.
create function public.workspace_coverage_agents(p_workspace_id uuid, p_days int default 30)
returns table (
  agent_id uuid,
  agent_name text,
  agent_emoji text,
  answers bigint,
  covered bigint,
  fallback bigint,
  ungrounded bigint
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
         count(m.id) filter (where m.grounding is not null),
         count(m.id) filter (where m.grounding = 'chunks'),
         count(m.id) filter (where m.grounding = 'documents'),
         count(m.id) filter (where m.grounding = 'none')
  from public.agents a
  left join public.chat_sessions s on s.agent_id = a.id
  left join public.messages m
    on m.session_id = s.id
   and m.role = 'assistant'
   and m.created_at >= v_since
  where a.workspace_id = p_workspace_id
  group by a.id, a.name, a.emoji
  order by (count(m.id) filter (where m.grounding in ('documents', 'none'))) desc,
           count(m.id) desc,
           a.name;
end;
$$;

-- ---- who may execute -------------------------------------------------------
-- A new function grants EXECUTE to `public` by default, which on a SECURITY
-- DEFINER function reading across other people's sessions is not a default to
-- leave in place. The guard inside would refuse an anonymous caller anyway —
-- `auth.uid()` is null, so `is_workspace_admin` is false — but a definer
-- function should not be reachable by a role that can never pass its own
-- check. Same grant set as 0032.
revoke execute on function public.workspace_coverage(uuid, int) from public;
revoke execute on function public.workspace_coverage_agents(uuid, int) from public;
grant execute on function public.workspace_coverage(uuid, int) to authenticated, service_role;
grant execute on function public.workspace_coverage_agents(uuid, int) to authenticated, service_role;
