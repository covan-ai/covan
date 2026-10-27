-- =========================================================================
-- Come back later
--
-- An agent asked to make a video started one browser task and sat on the
-- page for ten minutes while the video rendered, billed by the browser
-- provider for a tab that did nothing (2026-10-27). What it should have done
-- is submit the prompt, close the browser, come back in fifteen minutes, and
-- look — and it could not, for two reasons this migration removes.
--
-- 1. No timer. Nothing let the agent say "wake me in N minutes with this
--    note". `continuations` is that note: one row per wake-up, written by the
--    `continue_later` tool from the ids the turn already carried, claimed by
--    the cron when `wake_at` has passed, and run as a new turn in the same
--    conversation (`lib/continuations/run.ts`). The turn is new rather than
--    resumed, for 0117's reason: a turn replays its caller's own request, and
--    the cron has no caller.
--
-- 2. The step after the browser ran only in an open tab. 0117 put the step
--    on the task (`then_step`) and had the tab claim it; with the tab closed,
--    or on a routine's run, the answer arrived and nothing acted on it. The
--    second function below is the cron's claim on the same column, so the
--    tab's claim and this one race on `continued_at` and exactly one wins.
--
-- Nothing is billed while a row waits. The browser was stopped by the sweep
-- ten minutes after its last run, as it always was; the wake-up opens a new
-- one in the same provider session.
--
-- No client role may write continuations, for `browser_tasks`' reason (0073):
-- a client that could insert a row would be writing a turn nobody asked for,
-- with tools, in a conversation of its choosing. The person may read their
-- own, so a screen can one day say "will check back at 14:35".
-- =========================================================================

create table if not exists public.continuations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  agent_id uuid not null references public.agents (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Where the woken turn runs. Cascade: a deleted conversation has nothing
  -- to wake into, and the runner checks `deleted_at` for the soft case.
  session_id uuid not null references public.chat_sessions (id) on delete cascade,
  -- The held routine run this wake-up belongs to (0100), when it is a
  -- routine's; its report waits while this row does.
  routine_run_id uuid references public.routine_runs (id) on delete cascade,
  -- What the agent told itself to do on waking, written to be read cold.
  note text not null check (char_length(note) between 1 and 1000),
  wake_at timestamptz not null,
  -- How many wake-ups this conversation has had today, counting this one.
  depth int not null default 1 check (depth >= 1),
  status text not null default 'waiting'
    check (status in ('waiting', 'running', 'done', 'failed', 'cancelled')),
  -- The claim, `claim_due_browser_tasks`'s mechanism (0073): a `running` row
  -- whose claim is older than the stale interval is taken again, once.
  claimed_at timestamptz,
  attempts int not null default 0,
  finished_at timestamptz,
  error text,
  created_at timestamptz not null default now()
);

comment on table public.continuations is
  'A wake-up the agent set for itself (0142): end the turn now, be woken at '
  'wake_at in session_id with note, by the cron, with tools, with nobody '
  'watching. Written by the worker from the turn''s own ids; no client role '
  'may write one.';

-- The cron's query. Partial: a finished row is never due again.
create index if not exists continuations_due_idx
  on public.continuations (wake_at)
  where status in ('waiting', 'running');

-- The held report's question: is anything of this run still pending?
create index if not exists continuations_run_idx
  on public.continuations (routine_run_id)
  where routine_run_id is not null;

-- The task note's question: what is set for this conversation?
create index if not exists continuations_session_idx
  on public.continuations (session_id, created_at desc);

alter table public.continuations enable row level security;

-- The person's own, and only while they are still in the workspace —
-- `browser_tasks_read`'s two checks (0073), for its reasons.
drop policy if exists "continuations_read_own" on public.continuations;
create policy "continuations_read_own"
  on public.continuations for select
  to authenticated
  using (user_id = auth.uid() and public.is_workspace_member(workspace_id));

-- A key's token reaches this table in no workspace (0087's shape, 0139's
-- choice): a wake-up is the worker's own note to itself about a conversation,
-- and nothing a key-driven request has a use for.
drop policy if exists continuations_request_workspace on public.continuations;
create policy continuations_request_workspace on public.continuations
  as restrictive for all to authenticated
  using ((select public.request_workspace()) is null)
  with check ((select public.request_workspace()) is null);

revoke all on public.continuations from anon, authenticated;
grant select (id, session_id, note, wake_at, status, created_at, finished_at)
  on public.continuations to authenticated;
-- 0023's closing rule: a migration that adds a table grants for it, in the
-- same file.
grant select, insert, update, delete on public.continuations to service_role;

-- ---- claim_due_continuations ---------------------------------------------
-- Atomically hand out the wake-ups whose time has come. `for update skip
-- locked` for `claim_due_routines`' reason (0012): two ticks overlap, and a
-- double claim here would be two turns in one conversation saying the same
-- thing. A `running` row claimed longer ago than p_stale_after is a runner
-- that died, and is taken once more; a second death leaves it `running`
-- with two attempts, which the next sweep of the held report cancels or the
-- person reads as what it is.
create or replace function public.claim_due_continuations(
  p_limit int default 2,
  p_stale_after interval default interval '15 minutes'
)
returns setof public.continuations
language sql
security definer
set search_path = pg_catalog, public
as $$
  update public.continuations c
  set claimed_at = now(),
      status = 'running',
      attempts = c.attempts + 1
  where c.id in (
    select id from public.continuations
    where wake_at <= now()
      and (
        status = 'waiting'
        or (status = 'running' and claimed_at < now() - p_stale_after and attempts < 2)
      )
    order by wake_at
    for update skip locked
    limit p_limit
  )
  returning c.*;
$$;

-- The grant IS the security boundary. Revoking from named roles is not
-- enough: Postgres grants EXECUTE to PUBLIC by default and every role
-- inherits it, so a SECURITY DEFINER function that hands out turns to run
-- stays callable through PostgREST unless PUBLIC is revoked explicitly.
revoke all on function public.claim_due_continuations(int, interval) from public, anon, authenticated;
grant execute on function public.claim_due_continuations(int, interval) to service_role;

-- ---- claim_browser_continuations_unwatched --------------------------------
-- The step after the browser, for the cron (0117 gave it to the tab).
--
-- The same rows `claim_browser_continuation` would hand a tab — finished,
-- answered in the conversation, carrying a step, not yet claimed, nothing
-- else in the conversation's line — with three differences:
--
--  - no `auth.uid()`: the cron has none, and the rows carry their own owner,
--    which the runner acts as;
--  - p_within is two hours rather than thirty minutes, the held report's own
--    window (`HELD_MAX_MS`): a step the cron was too busy to run for forty
--    minutes is still worth running, where a tab opened tomorrow is not;
--  - p_grace: only steps delivered more than a minute ago. A tab that is open
--    polls every few seconds and claims in one of them; the cron ticks every
--    five minutes and should not take a step from the person watching it.
--
-- Both claims set `continued_at` in the statement that selects, so the two
-- never run the same step.
create or replace function public.claim_browser_continuations_unwatched(
  p_limit int default 2,
  p_within interval default interval '2 hours',
  p_grace interval default interval '1 minute'
)
returns setof public.browser_tasks
language sql
security definer
set search_path = pg_catalog, public
as $$
  update public.browser_tasks t
  set continued_at = now()
  where t.id in (
    select t2.id from public.browser_tasks t2
    where t2.then_step is not null
      and t2.continued_at is null
      and t2.status = 'finished'
      and t2.delivered_at is not null
      and t2.delivered_at > now() - p_within
      and t2.delivered_at < now() - p_grace
      and not exists (
        select 1 from public.browser_tasks o
        where o.session_id = t2.session_id
          and o.status in ('waiting', 'queued', 'running')
      )
    order by t2.delivered_at
    for update skip locked
    limit p_limit
  )
  returning t.*;
$$;

revoke all on function public.claim_browser_continuations_unwatched(int, interval, interval) from public, anon, authenticated;
grant execute on function public.claim_browser_continuations_unwatched(int, interval, interval) to service_role;
