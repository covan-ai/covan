-- =========================================================================
-- The step after the browser
--
-- A browser task answers minutes after the turn that started it has ended,
-- as a message of its own (`lib/browser/deliver.ts`), and that message is one
-- model call with no tools. So a request with a step after the browser —
-- "find twenty leads on LinkedIn, then write them to a page in Qrucial" —
-- stopped when the browser did: on 2026-10-19 the leads arrived and the page
-- was written only after the person asked "so?", twice in one evening.
--
-- The turn cannot be resumed from the cron: a turn replays its caller's own
-- request (`lib/turns/detached.ts`), and the cron has no caller. The tab that
-- is open does. So the task carries the step, and when the answer is in the
-- conversation and nothing else is in the browser's line, the tab claims the
-- step once and sends the conversation on.
--
-- 1. Three columns on browser_tasks
--
--   then_step     What the agent said it would do with the answer, in its own
--                 words, from `browse`'s `then`. Null when the answer is all
--                 that was asked, which is every task before this.
--   delivered_at  When the answer's message was written. `finished_at` is the
--                 settle's claim, a model call before the message exists, and
--                 a conversation sent on before its answer arrived would carry
--                 on without it.
--   continued_at  When a tab claimed the step. Once, whichever tab.
--
-- The panel reads all three, through the caller's client: 0073 names its
-- selectable columns one by one, and these are the agent's own words and two
-- times, nothing a provider gave.
-- =========================================================================

alter table public.browser_tasks
  add column if not exists then_step text
    check (then_step is null or char_length(then_step) between 1 and 1000),
  add column if not exists delivered_at timestamptz,
  add column if not exists continued_at timestamptz;

grant select (then_step, delivered_at, continued_at)
  on public.browser_tasks to authenticated;

-- =========================================================================
-- 2. claim_browser_continuation — the step, once
--
-- Returns the steps a conversation is waiting on, oldest first, and marks
-- them claimed in the same statement, or nothing. Only for the person who
-- started the tasks (`user_id = auth.uid()`, the policy's own narrowing), only
-- for tasks that finished — a login wall, a refusal or a run that did part of
-- it is the person's to decide on, and the conversation already told them —
-- only once the answer is written, and only when nothing else in this
-- conversation's line is still to come: a request for three lookups and then
-- a write is sent on once, after the third.
--
-- Within half an hour of the answer. A tab opened tomorrow does not start
-- work by itself because of something said today; the task note still says
-- what was left (`lib/browser/task-note.ts`), so asking picks it up.
--
-- `security definer` because no client role may write browser_tasks (0073);
-- the caller is narrowed by `auth.uid()` here exactly as the policy narrows
-- their reads.
-- =========================================================================

create or replace function public.claim_browser_continuation(p_session_id uuid)
returns text[]
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_user uuid := auth.uid();
  v_steps text[];
begin
  if v_user is null then
    return '{}';
  end if;

  if exists (
    select 1 from public.browser_tasks
    where session_id = p_session_id
      and user_id = v_user
      and status in ('waiting', 'queued', 'running')
  ) then
    return '{}';
  end if;

  with claimed as (
    update public.browser_tasks t
    set continued_at = now()
    where t.session_id = p_session_id
      and t.user_id = v_user
      and t.then_step is not null
      and t.continued_at is null
      and t.status = 'finished'
      and t.delivered_at is not null
      and t.delivered_at > now() - interval '30 minutes'
    returning t.then_step, t.created_at
  )
  select coalesce(array_agg(c.then_step order by c.created_at), '{}')
  into v_steps
  from claimed c;

  return v_steps;
end $$;

revoke all on function public.claim_browser_continuation(uuid) from public, anon;
grant execute on function public.claim_browser_continuation(uuid) to authenticated;
