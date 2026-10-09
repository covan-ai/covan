-- A web task handed to a third party, outliving the conversation turn that
-- asked for it.
--
-- ---------------------------------------------------------------------------
-- WHY A TABLE OF ITS OWN, and not `routine_runs`.
--
-- `routine_runs.routine_id` is `not null` (0012:154). A browser task has no
-- routine, so holding one there would mean inventing a `routines` row per
-- task -- which would then appear on the routines screen as a schedule nobody
-- set up, with a cron expression nobody wrote. The record of a thing is not
-- the place to invent the thing.
--
-- WHY NOT `paused_turns`, which is the other candidate and the one the design
-- doc reached for. Three reasons, and the third is decisive:
--
--   1. `paused_turns.expires_at` defaults to one hour and nothing writes it
--      (`lib/harness/turn.ts:148-162`). That hour is chosen for how long a
--      PERSON's answer stays meaningful, which is not the same question.
--   2. `loadPausedTurn` refuses any row whose status is not `pending`
--      (`turn.ts:187`), and `POST /chat/confirm/:id` is caller-bound -- it
--      reads `c.get("db")` and `c.get("user")` and streams SSE. The cron
--      Worker has no caller, so it could not resume a turn through that route
--      whatever the status said.
--   3. `browse` is a destructive tool, so it ALREADY parks a `paused_turns`
--      row -- for the approval card. A second pause in one turn runs into
--      `routes/chat.ts:1186-1189`, which treats a tool asking for
--      confirmation twice as a bug in the tool. It is the right check and it
--      should stay.
--
-- So the turn ends when the task is handed over, and the answer arrives later
-- as a NEW assistant message in the same session. This table is what connects
-- the two, and `session_id` is the connection.
--
-- ---------------------------------------------------------------------------
-- WHY `provider_task_id` IS WITHHELD FROM EVERY CLIENT ROLE.
--
-- 0063's argument, unchanged. One `BROWSER_USE_API_KEY` serves every
-- workspace on a deployment, so an id at that provider is not a label -- it is
-- the whole address of a running browser somebody is paying for. Handed to a
-- client it would be the one string needed to read another workspace's task
-- through the provider's own API. Same shape as
-- `tool_connections.connected_account_id`: the row may be seen, the address
-- may not.
--
-- Everything else here is advisory and belongs on the screen: what was asked,
-- what came back, what it cost, whether it worked.
--
-- ---------------------------------------------------------------------------
-- WHY THE READ POLICY IS NARROWER THAN THE SESSION'S.
--
-- `paused_turns` is visible to everybody who can see the conversation
-- (0060:194-196), because a pending question in a shared session is the whole
-- room's business. A browser task is not: it spends the ALLOWANCE OF ONE
-- PERSON, and `user_id` is whose. The answer it produces becomes an ordinary
-- assistant message and is visible to the room through the session's own
-- policy, which is the right place for that to be decided.
--
-- The workspace check is kept beside the owner check for the reason 0012's
-- routines policy keeps it: a person removed from a workspace should stop
-- seeing its rows, and `user_id = auth.uid()` alone would not say so.

create table if not exists public.browser_tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  agent_id uuid not null references public.agents (id) on delete cascade,
  -- Whose allowance paid for this, and who is told when it finishes.
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Where the answer goes. `on delete cascade` is deliberate and has a
  -- consequence the poller must survive: delete the conversation and the task
  -- row goes with it, while the browser at the provider carries on until it
  -- finishes. That is accepted -- the alternative is a row pointing at a
  -- conversation that is not there.
  session_id uuid not null references public.chat_sessions (id) on delete cascade,
  -- The task at browser-use. Never handed to a client; see the header.
  provider_task_id text not null,
  -- The sentence the person approved, verbatim. This is the whole blast
  -- radius of the call: there is no endpoint to inspect, no method to check
  -- and no origin to lock, so the text IS the record of what was authorised.
  task text not null,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'finished', 'failed', 'stopped')),
  -- The backoff, and the claim. Mirrors `connections.next_sync_at` /
  -- `claimed_at` (0043:69-81) rather than inventing a second vocabulary for
  -- the same mechanism.
  next_poll_at timestamptz not null default now(),
  claimed_at timestamptz,
  poll_count int not null default 0,
  -- What the provider charged, in dollars, read back from its own status
  -- endpoint. Advisory: the allowance was already charged a flat
  -- `BROWSER_TASK_TOKENS` when the task was created. This column is what
  -- makes that constant re-derivable from real invoices instead of from
  -- browser-use's benchmark blog post.
  cost_usd numeric(10, 4),
  output text,
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

comment on table public.browser_tasks is
  'A web task handed to browser-use and outliving the chat turn that asked '
  'for it. The turn ends at handover; the answer arrives later as a new '
  'assistant message in session_id, written by the cron Worker (0073).';

comment on column public.browser_tasks.provider_task_id is
  'The task id at browser-use. Withheld from every client role for '
  'tool_connections.connected_account_id''s reason (0063): one deployment-wide '
  'API key means this id is the only thing separating two tenants at that '
  'provider.';

comment on column public.browser_tasks.task is
  'The sentence a person approved, verbatim. The approval card shows exactly '
  'this, untruncated, because with no endpoint, method or origin to inspect '
  'the sentence is the entire description of what was authorised.';

comment on column public.browser_tasks.cost_usd is
  'What browser-use charged, in dollars. Advisory -- the allowance was charged '
  'a flat BROWSER_TASK_TOKENS at creation. This is the column that lets that '
  'constant be re-derived from real spending rather than from a published '
  'benchmark.';

-- The poller's query, and the only hot one here. Partial, for
-- `paused_turns_pending_idx`'s reason (0060:180-184): a task that has reached
-- a terminal status will never be polled again.
create index if not exists browser_tasks_due_idx
  on public.browser_tasks (next_poll_at)
  where status in ('queued', 'running');

-- The screen's query: this person's tasks, newest first.
create index if not exists browser_tasks_owner_idx
  on public.browser_tasks (user_id, created_at desc);

create index if not exists browser_tasks_session_idx
  on public.browser_tasks (session_id, created_at desc);

alter table public.browser_tasks enable row level security;

-- Narrower than the session's own policy, on purpose. See the header.
drop policy if exists "browser_tasks_read" on public.browser_tasks;
create policy "browser_tasks_read"
  on public.browser_tasks for select
  using (user_id = auth.uid() and public.is_workspace_member(workspace_id));

-- No write policy of any kind for a client role, for `paused_turns`'s reason
-- (0060:198-201): every column here is the worker's account of what it did
-- with somebody's money, and an account the subject can edit is not an
-- account. A client that could insert could invent a finished task with an
-- `output` of its choosing, which the agent would then read back as fact.
revoke all on public.browser_tasks from anon, authenticated;
grant select (
  id, workspace_id, agent_id, user_id, session_id, task, status, poll_count,
  cost_usd, output, error, created_at, finished_at
) on public.browser_tasks to authenticated;
-- 0023's closing rule: a migration that adds a table grants for it, in the
-- same file.
grant select, insert, update, delete on public.browser_tasks to service_role;

-- ---- claim_due_browser_tasks ---------------------------------------------
-- Atomically hand out tasks that are due a poll. `for update skip locked`
-- means two overlapping ticks can never take the same row -- and here that is
-- not hypothetical: `src/index.ts` and `src/cron.ts` both export a
-- `scheduled` handler against one database (see the comment in `cron.ts`), so
-- two ticks genuinely do overlap. A double claim would mean two model calls
-- and two assistant messages for one browser task.
--
-- A claim older than p_stale_after is treated as abandoned -- the worker died
-- mid-poll -- and becomes claimable again. Character for character the same
-- mechanism as `claim_due_routines` (0055:65-91) and
-- `claim_due_connections` (0043:258-292), because the failure it defends
-- against is the same one.
--
-- The status filter goes INSIDE the `for update skip locked` sub-select, for
-- 0055's reason: outside, finished rows would still be locked and counted
-- against p_limit before being discarded, so a workspace with a backlog of
-- completed tasks could starve its running ones out of every tick.
create or replace function public.claim_due_browser_tasks(
  p_limit int default 3,
  p_stale_after interval default interval '15 minutes'
)
returns setof public.browser_tasks
language sql
security definer
set search_path = pg_catalog, public
as $$
  update public.browser_tasks b
  set claimed_at = now()
  where b.id in (
    select id from public.browser_tasks
    where status in ('queued', 'running')
      and next_poll_at <= now()
      and (claimed_at is null or claimed_at < now() - p_stale_after)
    order by next_poll_at
    for update skip locked
    limit p_limit
  )
  returning b.*;
$$;

-- The grant IS the security boundary. Revoking from named roles is not
-- enough: Postgres grants EXECUTE to PUBLIC by default and every role
-- inherits it, so a SECURITY DEFINER function returning rows that carry
-- `provider_task_id` -- the one column withheld from every client above --
-- stays callable through PostgREST unless PUBLIC is revoked explicitly.
revoke all on function public.claim_due_browser_tasks(int, interval) from public, anon, authenticated;
grant execute on function public.claim_due_browser_tasks(int, interval) to service_role;
