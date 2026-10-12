-- 0084_the_deleted_and_the_anonymous.sql
--
-- Two pieces of hygiene that 0076 recorded and deliberately left alone
-- (covan-ai/covan-cloud#306). Neither is a hole. Both are the kind of thing
-- that becomes one the day somebody copies the wrong example.
--
-- ---- 1. 0053's coverage read counts rows nobody can see -------------------
--
-- `workspace_coverage` and `workspace_coverage_agents` (0053) are SECURITY
-- DEFINER, so row level security does not filter them — and 0053 forgot the one
-- clause RLS would have applied for it: `chat_sessions.deleted_at is null`
-- (0040). A soft-deleted session is invisible to everybody through every
-- policy, yet its replies were still in the coverage screen's figures.
--
-- 0076 noticed, wrote its own `workspace_coverage_totals` with the filter, and
-- called 0053's omission a defect "recorded as a follow-up beyond this phase"
-- rather than copying it. This is the follow-up. Both of 0053's functions are
-- restated with the filter, so the totals 0076 computes and the totals the
-- coverage screen shows are once again the same number for the same window —
-- and `tests/rls/coverage-gaps.test.ts` goes back to asserting equality instead
-- of "equal plus the deleted delta".
--
-- The per-agent read also stops listing an agent that has been deleted. Its
-- sessions are soft-deleted with it (0040's `soft_delete_agent`), so after the
-- first change it would have been listed at zero — "nobody asked this one" —
-- which is a false sentence about an agent nobody can see any more.
--
-- `create or replace` with the identical signature and return type, not 0053's
-- drop-and-create: the grants survive, and the section below then narrows them
-- on purpose rather than by accident.
--
-- What 0076's prose says about the two functions DIVERGING is now history. That
-- migration is applied and is not edited (AGENTS.md); its catalog comment, which
-- is what somebody reading the live database sees, is restated below.
--
-- ---- 2. `anon` can execute most of the definer functions -----------------
--
-- Postgres grants EXECUTE on a new function to PUBLIC, and Supabase ships
-- `alter default privileges ... grant execute on functions to anon,
-- authenticated, service_role` on top of that — so `anon` holds EXECUTE BY
-- NAME, and `revoke ... from public` does not reach it. 0076 found that out the
-- hard way and wrote it up; `worker/src/definer-grant.static.test.ts` checked
-- the PUBLIC half and nothing checked the `anon` half.
--
-- Every function revoked below already refuses an anonymous caller in its body:
-- each derives identity from `auth.uid()`, which is null for `anon`, and so
-- fails its own membership check. That is why this is hygiene and not a fix.
-- But the invariant that made them safe was written nowhere, and 0076 broke it
-- deliberately — `workspace_coverage_gaps(p_workspace_id, p_user_id, ...)`
-- takes the identity as an argument — and closed that with a grant. One
-- function in this tree already has the same two-id shape:
-- `workspace_api_key_count(uuid, uuid)`. The next one should not have to find
-- out which of the two rules it is under by reading three migrations.
--
-- So the rule, now in `docs/security.md` and pinned by two tests:
--
--   A SECURITY DEFINER function in `public` either
--     (a) takes no identity as an argument and derives it from `auth.uid()`,
--         and is granted to `authenticated` (and `service_role`); or
--     (b) takes an identity as an argument, is granted to `service_role`
--         ONLY, and checks `auth.role()` in its own body as well;
--   and in neither case is it executable by `anon`.
--
-- The one exception is the policy helpers, and it is not a judgement call. A
-- row level security policy is evaluated as the caller, every policy here that
-- names a helper is `to public`, and `anon` holds table privileges through
-- Supabase's auto-expose (supabase/config.toml). Revoking a helper from `anon`
-- would turn every anonymous read of every table from "no rows" into
-- "permission denied for function", and would not make anything safer: each
-- answers a question about `auth.uid()`, which for `anon` is null, so each
-- answers false. They are named in the test, with that reason.
--
-- Trigger functions are revoked too. Postgres checks EXECUTE on a trigger
-- function when the trigger is CREATED, not when it fires, so this changes
-- nothing about what they do; it makes "anon can execute no definer function
-- but the policy helpers" a sentence that is true of the catalog without a
-- footnote. 0082 already did the same for `sync_profile_email`, against PUBLIC.
--
-- Idempotent: `create or replace`, and revoke/grant are no-ops when repeated.
-- Production applies this through the Supabase API, with its
-- `covan_meta.migrations` ledger insert as the last statement, after 0083.

-- ---- 1. the coverage reads ------------------------------------------------

create or replace function public.workspace_coverage(p_workspace_id uuid, p_days int default 30)
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
  v_days int := greatest(1, least(coalesce(p_days, 30), 365));
  v_since timestamptz := now() - make_interval(days => v_days);
begin
  if not public.is_workspace_admin(p_workspace_id) then
    raise exception 'not an admin of this workspace' using errcode = '42501';
  end if;

  -- The five buckets are 0053's, unchanged, and 0076's
  -- `workspace_coverage_totals` uses the same five. THE BUCKET DEFINITIONS AND
  -- THE WHERE CLAUSE NOW MATCH THAT FUNCTION'S; a change to either belongs in
  -- both. What still differs is the caller model and the switch, which is the
  -- difference between a screen and a report, not between two counts.
  return query
  select count(*) filter (where m.grounding is not null),
         count(*) filter (where m.grounding = 'chunks'),
         count(*) filter (where m.grounding = 'documents'),
         count(*) filter (where m.grounding = 'none'),
         count(*) filter (where m.grounding is null)
  from public.messages m
  join public.chat_sessions s on s.id = m.session_id
  where s.workspace_id = p_workspace_id
    -- The clause 0053 left out. See this migration's header.
    and s.deleted_at is null
    and m.role = 'assistant'
    and m.created_at >= v_since;
end;
$$;

comment on function public.workspace_coverage(uuid, int) is
  'The grounding counts for a window, in four buckets plus a denominator, for '
  'the coverage screen. Admin only. Excludes soft-deleted sessions since 0084. '
  'Same buckets and same WHERE clause as public.workspace_coverage_totals — '
  'THOSE MUST STAY IN STEP.';

create or replace function public.workspace_coverage_agents(p_workspace_id uuid, p_days int default 30)
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

  -- Still a LEFT JOIN from `agents`, so an agent nobody asked stays in the
  -- list at zero. The session filter belongs in the join rather than in the
  -- WHERE clause for exactly that reason: in the WHERE it would drop the agent
  -- whose only sessions were deleted, instead of counting it at zero.
  return query
  select a.id,
         a.name,
         a.emoji,
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
  group by a.id, a.name, a.emoji
  order by (count(m.id) filter (where m.grounding in ('documents', 'none'))) desc,
           count(m.id) desc,
           a.name;
end;
$$;

comment on function public.workspace_coverage_agents(uuid, int) is
  'workspace_coverage per agent, with an agent nobody asked kept at zero. '
  'Admin only. Excludes soft-deleted sessions and agents since 0084.';

-- 0076's comment on the totals said the two functions diverge. They no longer
-- do, and a catalog comment that contradicts the catalog is worse than none.
comment on function public.workspace_coverage_totals(uuid, uuid, int) is
  'The grounding counts for a window, in 0053''s four buckets plus its '
  'denominator, for the coverage gap report. Same buckets and same WHERE clause '
  'as public.workspace_coverage since 0084 — THOSE MUST STAY IN STEP. '
  'Service-role only: `p_user_id` must be an admin of the workspace, and it '
  'refuses while workspaces.gap_report_enabled is false.';

-- ---- 2. who may execute ---------------------------------------------------
--
-- Rule (a): identity from `auth.uid()`, callable by a signed-in client. Each is
-- revoked from PUBLIC and from `anon` by name, and granted back to the two
-- roles that call it. The grant is explicit rather than left to default
-- privileges, which belong to whichever role runs the migration: once PUBLIC
-- is revoked, a database where that role's defaults never named
-- `authenticated` would otherwise lock every signed-in caller out.

-- Client RPCs: the first two make the membership the others then check.
revoke all on function public.create_workspace(text) from public, anon;
revoke all on function public.accept_invitation(uuid) from public, anon;
grant execute on function public.create_workspace(text) to authenticated, service_role;
grant execute on function public.accept_invitation(uuid) to authenticated, service_role;

-- 0040 revoked these from `anon` alone, which is the mistake the static test
-- exists to catch: `anon` inherits PUBLIC, so it changed nothing.
revoke all on function public.soft_delete_agent(uuid) from public, anon;
revoke all on function public.soft_delete_bundle(uuid) from public, anon;
revoke all on function public.soft_delete_document(uuid) from public, anon;
revoke all on function public.restore_agent(uuid) from public, anon;
revoke all on function public.restore_bundle(uuid) from public, anon;
revoke all on function public.restore_document(uuid) from public, anon;
revoke all on function public.workspace_trash(uuid) from public, anon;
grant execute on function public.soft_delete_agent(uuid) to authenticated, service_role;
grant execute on function public.soft_delete_bundle(uuid) to authenticated, service_role;
grant execute on function public.soft_delete_document(uuid) to authenticated, service_role;
grant execute on function public.restore_agent(uuid) to authenticated, service_role;
grant execute on function public.restore_bundle(uuid) to authenticated, service_role;
grant execute on function public.restore_document(uuid) to authenticated, service_role;
grant execute on function public.workspace_trash(uuid) to authenticated, service_role;

revoke all on function public.touch_session(uuid) from public, anon;
revoke all on function public.show_message_version(uuid) from public, anon;
grant execute on function public.touch_session(uuid) to authenticated, service_role;
grant execute on function public.show_message_version(uuid) to authenticated, service_role;

-- Admin reads. Each already revoked PUBLIC; `anon` held them by name.
revoke all on function public.workspace_coverage(uuid, int) from public, anon;
revoke all on function public.workspace_coverage_agents(uuid, int) from public, anon;
revoke all on function public.workspace_usage_all(uuid) from public, anon;
revoke all on function public.workspace_usage_monthly(uuid, int) from public, anon;
grant execute on function public.workspace_coverage(uuid, int) to authenticated, service_role;
grant execute on function public.workspace_coverage_agents(uuid, int) to authenticated, service_role;
grant execute on function public.workspace_usage_all(uuid) to authenticated, service_role;
grant execute on function public.workspace_usage_monthly(uuid, int) to authenticated, service_role;

-- The one that looks like rule (b) and is not. `workspace_api_key_count`
-- takes a user id, but only to count that person's keys; WHO IS ASKING still
-- comes from `is_workspace_admin`, i.e. from `auth.uid()`, so it is under rule
-- (a) and stays granted to `authenticated`. Only `anon` goes.
revoke all on function public.workspace_api_key_count(uuid, uuid) from public, anon;
grant execute on function public.workspace_api_key_count(uuid, uuid) to authenticated, service_role;

-- Trigger functions. Nobody calls these; see the header for why revoking them
-- changes nothing about when they fire.
revoke all on function public.handle_new_user() from public, anon;
revoke all on function public.prevent_last_admin_removal() from public, anon;
revoke all on function public.trg_log_invitation() from public, anon;
revoke all on function public.trg_log_membership() from public, anon;
revoke all on function public.trg_log_soft_delete() from public, anon;
revoke all on function public.sync_profile_email() from public, anon;

-- NOT revoked from `anon`, by design — the policy helpers. See the header:
--   is_workspace_member, is_workspace_admin, can_write_in_workspace,
--   session_is_visible, shares_workspace.
