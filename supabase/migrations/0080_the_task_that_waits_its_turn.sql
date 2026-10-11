-- The task that waits its turn: a conversation's browser tasks run one after
-- another instead of the second being refused.
--
-- A conversation's browser does one thing at a time (0078), and until now a
-- `browse` that arrived while it was busy was refused: "a browser task is
-- still running ... do not retry this turn". On 2026-10-11 somebody asked one
-- agent to look at a GitHub repo, a website and a competitor in one message;
-- the first started, the other two were refused, and the agent -- which had
-- no way to queue them -- told the person all three were running. This is
-- the queue it did not have.
--
-- ---------------------------------------------------------------------------
-- WHY A NEW STATUS, `waiting`, AND NOT `queued`.
--
-- `queued` was taken in 0073, and it does not mean what the word suggests: it
-- is "accepted by the provider", a run that exists at browser-use and is
-- polled, and nine places read it as in flight. A task that has not started
-- has no run, no provider id and nothing to poll, so it is a different state
-- and gets its own word. The panel calls it "Queued"; the database calls it
-- `waiting`, so no reader of `queued` changes meaning underneath.
--
-- `provider_task_id` was `not null` because every row was a run. A waiting row
-- is not, so the column becomes nullable and a check keeps the old promise
-- where it still holds: a row in flight names its run. A waiting row that is
-- cancelled ends `stopped` with no run, which is why the check is about the
-- two in-flight statuses rather than about every status but `waiting`.
--
-- `login_host` is the site the task has to sign in to, resolved when it was
-- queued -- the same narrowing as `signin_host` -- so the saved login it needs
-- is looked up when it STARTS, from the host, rather than decrypted and
-- carried in a row for however long it waits.
--
-- ---------------------------------------------------------------------------
-- WHY THE START IS A CLAIM, AND WHAT HOLDS THE LINE.
--
-- Two things start a waiting task: the settle of the task in front of it, and
-- a cron stage for everything a settle could not (a hold that lapsed, a start
-- that has to be retried). Both can fire at once -- `src/index.ts` and
-- `src/cron.ts` both export `scheduled`, and an open tab settles runs too --
-- and two starts of one task would be two runs at the provider and two
-- charges. So the start is a claim, `claim_due_browser_tasks`'s mechanism: a
-- lease in `claimed_at`, taken inside `for update skip locked`.
--
-- One at a time per browser, in order. A row is claimable only as the HEAD of
-- its browser's line (no earlier `waiting` row), and only when nothing of that
-- browser is in flight. A concurrent claim skips the locked head and finds the
-- next row is not the head, so a line never starts two.
--
-- What holds it:
--   * the person has the browser (`live_state = 'human'`, a take-over): their
--     hands are on it, and the line waits for Done -- whose retry is a run in
--     flight, so the line waits for that too;
--   * the browser's last task stopped at a sign-in less than `p_login_hold`
--     ago: the panel is asking the person to sign in, and starting the next
--     task would put another run in that browser and take the prompt away;
--   * the browser is being opened (no provider session, row under a minute
--     old), for `ensureBrowserSession`'s reason;
--   * the person who queued it is no longer in the workspace: a start spends
--     their allowance and their saved logins, and the service role this runs
--     as would not ask.
-- A lease younger than `p_lease` is a start in progress, or one that failed
-- and is backing off -- the worker keeps the lease on a busy provider, so the
-- same row is not retried on the very next tick.

alter table public.browser_tasks drop constraint if exists browser_tasks_status_check;
alter table public.browser_tasks
  add constraint browser_tasks_status_check
    check (status in ('waiting', 'queued', 'running', 'finished', 'failed', 'stopped'));

alter table public.browser_tasks alter column provider_task_id drop not null;
alter table public.browser_tasks drop constraint if exists browser_tasks_run_named;
alter table public.browser_tasks
  add constraint browser_tasks_run_named
    check (status not in ('queued', 'running') or provider_task_id is not null);

alter table public.browser_tasks
  add column if not exists login_host text
    check (login_host = lower(login_host) and login_host !~ '[/:@\s]');

comment on column public.browser_tasks.login_host is
  'The host a waiting task has to sign in to, resolved when it was queued. '
  'The saved login is looked up from it when the task starts. Withheld from '
  'client roles: nothing on a screen reads it.';

-- Each browser's line, in order, and what is in flight in it: the two
-- questions every claim below asks.
create index if not exists browser_tasks_line_idx
  on public.browser_tasks (browser_session_id, created_at)
  where status in ('waiting', 'queued', 'running');

-- ---- claim_next_browser_tasks ----------------------------------------------
-- `p_browser_session_id` names one browser (a settle starting what is behind
-- it) or null for every browser (the cron). Returns the rows it leased; the
-- worker starts each, then moves it to `queued` with a compare-and-set on
-- `status = 'waiting'`, so a task cancelled mid-start is never marked started.
create or replace function public.claim_next_browser_tasks(
  p_browser_session_id uuid default null,
  p_limit int default 3,
  p_lease interval default interval '2 minutes',
  p_login_hold interval default interval '10 minutes'
)
returns setof public.browser_tasks
language sql
security definer
set search_path = pg_catalog, public
as $$
  update public.browser_tasks b
  set claimed_at = now()
  where b.status = 'waiting'
    and b.id in (
      select w.id from public.browser_tasks w
      where w.status = 'waiting'
        and w.browser_session_id is not null
        and (p_browser_session_id is null or w.browser_session_id = p_browser_session_id)
        and (w.claimed_at is null or w.claimed_at < now() - p_lease)
        -- The head of its line.
        and not exists (
          select 1 from public.browser_tasks e
          where e.browser_session_id = w.browser_session_id
            and e.status = 'waiting'
            and (e.created_at, e.id) < (w.created_at, w.id)
        )
        -- Nothing in flight in that browser.
        and not exists (
          select 1 from public.browser_tasks r
          where r.browser_session_id = w.browser_session_id
            and r.status in ('queued', 'running')
        )
        -- Not in the person's hands, and not being opened.
        and exists (
          select 1 from public.browser_sessions s
          where s.id = w.browser_session_id
            and s.live_state <> 'human'
            and (s.provider_session_id is not null or s.created_at < now() - interval '1 minute')
        )
        -- Not behind a sign-in the panel is asking for.
        and not exists (
          select 1 from (
            select l.stop_reason, l.finished_at from public.browser_tasks l
            where l.browser_session_id = w.browser_session_id
              and l.status in ('finished', 'failed', 'stopped')
              and l.provider_task_id is not null
            order by l.created_at desc
            limit 1
          ) last
          where last.stop_reason = 'login_required'
            and last.finished_at > now() - p_login_hold
        )
        -- Still somebody this workspace runs work for.
        and exists (
          select 1 from public.workspace_members m
          where m.workspace_id = w.workspace_id and m.user_id = w.user_id
        )
      order by w.created_at
      for update skip locked
      limit p_limit
    )
  returning b.*;
$$;

-- 0078's sentence, for 0078's reason: PUBLIC holds EXECUTE by default, and
-- this returns rows the client roles may not read.
revoke all on function public.claim_next_browser_tasks(uuid, int, interval, interval) from public, anon, authenticated;
grant execute on function public.claim_next_browser_tasks(uuid, int, interval, interval) to service_role;
