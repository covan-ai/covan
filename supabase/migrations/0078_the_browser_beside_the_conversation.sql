-- The browser beside the conversation: one browser per chat session and
-- person, which the agent drives and the person can take over.
--
-- Until now every `browse` was a stranger. 0073's task opened a fresh browser
-- at browser-use, did one thing and threw the browser away, so a follow-up --
-- "now open the second result" -- started from a blank tab, and nothing the
-- person could watch existed between two calls. browser-use's V4 API keeps
-- an agent SESSION alive across runs: the same browser, the same tabs, the
-- same history. This table is where Covan remembers which session belongs to
-- which conversation, and whose hands it is in right now.
--
-- ---------------------------------------------------------------------------
-- WHY ONE ROW PER (CHAT SESSION, PERSON), AND WHY THE `unique` IS LOAD-BEARING.
--
-- Per conversation, because that is the unit a person thinks in: the browser
-- beside this chat is the one this chat has been using. Per person within it,
-- because a shared conversation has several people in it and the browser
-- spends ONE person's allowance -- `browser_tasks`'s reason (0073) for its
-- narrow read policy applies here unchanged. Two people asking in one room get
-- two browsers, each visible only to its owner.
--
-- The `unique` is what makes creating the row safe, for the reason 0077 gave
-- `browser_profiles.user_id` its own: the first `browse` in a conversation
-- races itself -- two tabs, or a retry before the first response lands -- and
-- if both opened a session at browser-use, one of them would be a running
-- browser nothing in this database could name. So the row is inserted FIRST
-- with `on conflict (chat_session_id, user_id) do nothing ... returning`, and
-- an empty `returning` tells the loser to re-read instead of calling out. The
-- provider ids are therefore nullable: the row exists before the provider has
-- answered.
--
-- ---------------------------------------------------------------------------
-- WHY `provider_session_id`, `provider_browser_id` AND `events_cursor` ARE
-- GRANTED TO NO CLIENT ROLE.
--
-- 0063's argument about `tool_connections.connected_account_id`, which 0073
-- and 0077 have already repeated for every id this product holds at
-- browser-use. One deployment-wide `BROWSER_USE_API_KEY` serves every
-- workspace, so an id at the provider is not a label -- it is the whole
-- address of the thing. Here the thing is a running browser, possibly signed
-- into somebody's accounts through their profile, and the browser id is what
-- the provider mints a live view URL against. "Treat the URL as a
-- credential" is browser-use's own sentence; the id is one call away from it.
--
-- `events_cursor` is withheld not because it is dangerous but because it is
-- the poller's own bookkeeping about how far into the provider's event log it
-- has read, and an exposed column is a column somebody will later build a
-- screen on. `profile_id`, `claimed_at` and `human_started_at` are withheld for
-- the same reason: all three are read only server side.
--
-- No insert, update or delete grant or policy for any client role. The column
-- that matters most is `live_state`: `human` is the state in which the panel
-- hands somebody the controls, and the take-over route writes it only after
-- the provider has reported the agent's run stopped. A client that could
-- write it could put itself in `human` while the agent was still typing.
--
-- ---------------------------------------------------------------------------
-- WHY `claimed_at` EXISTS, WHEN THE PLAN'S SHAPE OF THE TABLE DID NOT HAVE IT.
--
-- 0077's reason for adding one to `browser_takeovers`, word for word: the
-- claim function needs a lease column. `for update skip locked` keeps two
-- OVERLAPPING ticks apart only for the instant the claiming statement runs;
-- the moment it commits, the row lock is gone, and a second tick arriving a
-- second later would take the same browser again unless the claim left a mark
-- on the row. `human_since` cannot be that mark -- it is the sweep's clock,
-- and a stop that fails must leave it standing so the browser is still found
-- -- and `live_state` cannot either, because flipping it before the stop has
-- happened would tell the panel the person's turn was over while the browser
-- was still theirs. Same vocabulary as `browser_tasks.claimed_at` and
-- `browser_takeovers.claimed_at` rather than a third name for one mechanism.

create table if not exists public.browser_sessions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  agent_id uuid not null references public.agents (id) on delete cascade,
  -- Whose allowance drives this browser, and the only person who sees it.
  user_id uuid not null references auth.users (id) on delete cascade,
  chat_session_id uuid not null references public.chat_sessions (id) on delete cascade,
  -- The cookie jar the browser's runs carry: named on the claim when the
  -- person already has one, else written when a run starts with the jar the
  -- first `browse` provisioned for them (ruling R19), because the sweep and
  -- the panel's close read the jar back by this column after a stop. `set
  -- null`, because deleting a jar must not delete the record of a browser that
  -- may still be running at the provider.
  profile_id uuid references public.browser_profiles (id) on delete set null,
  -- The V4 agent session. Null until the first run answers; never handed to a
  -- client. See the header.
  provider_session_id text,
  -- From `browser.ready`. May change (`browser.reattached`), so it is a
  -- current value rather than an identity. Never handed to a client.
  -- Also the row's record that its browser is still open: written when a run
  -- names it (the open tab's event drain, or the settle when no tab did) and
  -- cleared by every CONFIRMED stop (the panel's close, the sweep), so the
  -- sweep's idle arm claims a browser it has not yet seen stopped and nothing
  -- else. Null does not mean "no session": a follow-up still continues
  -- `provider_session_id`, and the provider gives it a new browser.
  provider_browser_id text,
  -- Who has the controls. `agent` while a run is in flight, `human` from a
  -- take-over until the hand-back (or the sweep), `none` otherwise.
  live_state text not null default 'none' check (live_state in ('none', 'agent', 'human')),
  -- Set on take-over, and moved to now about once a minute by the open tab's
  -- poll (ruling R21). The sweep's clock: ten minutes past it is ten minutes
  -- since the tab holding the browser went quiet -- a closed tab, not a long
  -- think -- so a person still signing in is never swept from under.
  human_since timestamptz,
  -- Set on take-over and cleared with `human_since`, and never moved by the
  -- heartbeat (ruling R21): when the person actually took the browser. The
  -- sweep counts the provider's four-hour hard timeout from here, because
  -- `human_since` now says only when the tab last spoke. Read by the worker
  -- alone; the panel draws from `human_since`.
  human_started_at timestamptz,
  -- How far into the provider's event log the poller has read.
  events_cursor int not null default 0,
  last_run_at timestamptz,
  created_at timestamptz not null default now(),
  -- The sweep's lease. See the header.
  claimed_at timestamptz,
  -- Insert-first depends on this. See the header.
  unique (chat_session_id, user_id)
);

comment on table public.browser_sessions is
  'One browser-use V4 agent session per chat session and person: the browser '
  'beside the conversation, kept between browse calls (0078). Inserted before '
  'the provider is called, so the unique (chat_session_id, user_id) decides a '
  'race rather than leaving an unnamed browser at the provider.';

comment on column public.browser_sessions.provider_session_id is
  'The agent session id at browser-use. Withheld from every client role for '
  'connected_account_id''s reason (0063, repeated by 0073 and 0077): one '
  'deployment-wide API key makes this id the entire address of a running '
  'browser.';

comment on column public.browser_sessions.provider_browser_id is
  'The browser id at browser-use, from browser.ready; replaced on '
  'browser.reattached. Withheld from every client role: a live view URL is '
  'minted against it. Cleared by every confirmed stop, so a row naming one is '
  'a browser not yet seen stopped: the idle sweep''s marker.';

comment on column public.browser_sessions.live_state is
  'Who has the controls: agent while a run is in flight, human from a '
  'take-over until hand-back or the sweep, none otherwise. Written only by the '
  'worker; human means the panel is interactive, so no client may set it.';

comment on column public.browser_sessions.human_since is
  'When the person took over, moved to now about once a minute while their tab '
  'is open (ruling R21). The sweep''s clock: claim_due_browser_sessions takes a '
  'browser whose tab has been quiet for ten minutes. A stop that fails leaves '
  'it standing, so the sweep finds the browser again once its lease expires.';

comment on column public.browser_sessions.human_started_at is
  'When the person took over, never moved by the tab''s heartbeat: the sweep '
  'counts the provider''s four-hour hard timeout from here. Withheld from '
  'every client role; the panel needs only human_since.';

-- The sweep's query. Partial for `browser_tasks_due_idx`'s reason (0073): a
-- browser the agent is driving, or nobody is, will never be swept, and those
-- are nearly all the rows in a table that gains one per conversation that ever
-- used `browse`.
create index if not exists browser_sessions_human_idx
  on public.browser_sessions (human_since)
  where live_state = 'human';

-- The sweep's other arm (ruling R20): a browser nobody is using, still open
-- at the provider. Partial for the same reason: once the sweep has seen a
-- browser stopped the row names none, so nearly every row drops out of this.
create index if not exists browser_sessions_idle_idx
  on public.browser_sessions (last_run_at)
  where live_state = 'none' and provider_browser_id is not null;

alter table public.browser_sessions enable row level security;

-- 0073's policy exactly, and for 0073's reasons: the row is the owner's, and
-- the workspace half is what makes a removed member stop seeing it. A
-- colleague in the same shared conversation sees the answers -- they are
-- ordinary assistant messages -- and nothing of the browser.
drop policy if exists "browser_sessions_read" on public.browser_sessions;
create policy "browser_sessions_read"
  on public.browser_sessions for select
  using (user_id = auth.uid() and public.is_workspace_member(workspace_id));

revoke all on public.browser_sessions from anon, authenticated;
-- What the panel needs to draw itself and nothing else: whose, where, who has
-- the controls and since when. The provider ids, the cursor, the jar, the
-- lease and the four-hour clock are withheld for the header's reasons.
grant select (
  id, user_id, workspace_id, agent_id, chat_session_id, live_state, human_since,
  last_run_at, created_at
) on public.browser_sessions to authenticated;
-- 0023's closing rule: a migration that adds a table grants for it, in the
-- same file.
grant select, insert, update, delete on public.browser_sessions to service_role;

-- ---- browser_tasks, on V4 --------------------------------------------------
-- A task is now one RUN inside a browser session rather than a browser of its
-- own. `provider_task_id` stays `not null` and keeps meaning the V2 task for
-- rows written before this migration, which the poller drains on the V2 API;
-- `api_version` is how it tells the two apart, and defaults to `v2` precisely
-- so that every existing row says what it is without a backfill.
--
-- `browser_session_id` is `on delete set null` for `retry_of`'s reason
-- (0077): the task's answer is in the conversation, and losing the browser
-- row must not take the record of what was asked with it.
--
-- `stop_reason` says why a run ended before its answer, so the conversation
-- can tell "you took over" from "it hit the cost ceiling" from "it was
-- cancelled": 'handed_to_person' | 'cost_cap' | 'cancelled', or the run's own
-- word for the wall it stopped at, 'login_required' | 'blocked' -- written by
-- the settle in its claim, because the panel's sign-in prompt has only the row
-- to key on -- or null. Not a
-- check constraint, because it is advisory text read by a screen and the set
-- will grow with the provider's reasons; `status` is the column the poller
-- branches on, and that one is checked.
alter table public.browser_tasks
  add column if not exists browser_session_id uuid references public.browser_sessions (id) on delete set null,
  -- The run at browser-use. Never handed to a client, for provider_task_id's
  -- reason (0073).
  add column if not exists provider_run_id text,
  add column if not exists api_version text not null default 'v2' check (api_version in ('v2', 'v4')),
  add column if not exists stop_reason text,
  -- The site a run said it needed a sign-in on, set only when it ended
  -- `login_required`: the panel's "linkedin.com needs you to sign in. Take
  -- over, sign in in the browser, then press Done." has no other place to
  -- read it, because the outcome is parsed from the run's output and then
  -- only spoken in the chat message. A bare lowercase host, the shape
  -- `allowedDomains` wants; the worker validates before it writes and this
  -- refuses what it missed, because a screen renders it.
  add column if not exists signin_host text
    check (signin_host = lower(signin_host) and signin_host !~ '[/:@\s]');

comment on column public.browser_tasks.provider_run_id is
  'The V4 run id at browser-use. Withheld from every client role for '
  'provider_task_id''s reason (0073). provider_task_id stays for v2 rows '
  'being drained; api_version says which of the two a row carries.';

-- 0073 names its selectable columns one by one, so a new column is withheld
-- until a migration says otherwise. This says otherwise for four of the five:
-- which browser, which API, why it stopped and where it wanted a sign-in are
-- all things the panel shows. `signin_host` is a site's name, not a provider
-- id, so it is not what 0073 withholds. `provider_run_id` stays withheld.
grant select (browser_session_id, api_version, stop_reason, signin_host)
  on public.browser_tasks to authenticated;

-- ---- claim_due_browser_sessions --------------------------------------------
-- The safety net for a browser nobody will stop, in two arms that share one
-- claim, one lease and one batch -- so a cron tick's subrequests are counted
-- once for both (`sweep.ts`'s `BROWSER_BATCH_SIZE`).
--
-- HUMAN: a take-over nobody handed back. A person who took the controls and
-- then closed the tab leaves a browser running at the provider, billing, with
-- the profile's new cookies unsaved -- "always stop the session to persist
-- profile state" is browser-use's own sentence. The open tab moves
-- `human_since` to now about once a minute (ruling R21), so ten minutes past
-- it is ten minutes after the tab went quiet, not after the take-over: a
-- person still signing in keeps the browser for as long as the tab is open. A
-- tick claims such a browser, stops it (which saves the jar and stops the
-- billing in one call), and puts `live_state` back to `none`.
--
-- IDLE (ruling R20): a browser nobody is using. The last run ended, nobody
-- took over, and the provider keeps the browser open for its own idle
-- cleanup -- "after approximately 20 minutes", in its words, and "not an
-- exact shutdown deadline" -- billing all the while, with what the run's
-- pages set not yet saved to the profile. Ten minutes after the last run
-- started (`last_run_at`), a row that still names a browser is claimed and
-- stopped, and the sweep clears `provider_browser_id`: the row's own record
-- that it has seen the browser stopped, without which the same browser would
-- be claimed every tick. The agent session stays; a follow-up continues it in
-- a browser the provider re-provisions.
--
-- Human rows first: a sign-in somebody performed is the thing most worth
-- saving, and a batch full of idle browsers must not make it wait a tick.
--
-- Character for character the mechanism of `claim_due_browser_tasks`
-- (0073) and `claim_due_browser_takeovers` (0077), because the failure it
-- defends against is the same one: `src/index.ts` and `src/cron.ts` both
-- export a `scheduled` handler against one database, so two ticks genuinely
-- do overlap, and a double claim would mean two stops and two profile
-- refreshes for one browser. Both arms' filters go INSIDE the
-- `for update skip locked` sub-select, for 0055's reason: outside, rows that
-- are not due would be locked and counted against `p_limit` first.
--
-- `p_stale_after` defaults to the takeover sweep's 15 minutes: a claim older
-- than that is a worker that died mid-stop. A stop that FAILS takes the same
-- road (ruling R15): the sweep writes nothing and KEEPS the lease, so the row
-- is claimable again fifteen minutes later rather than on the very next tick
-- -- this stage short-circuits a tick whenever it claims anything, and a
-- browser whose stop keeps failing would otherwise starve every stage behind
-- it. Past the provider's four-hour hard timeout (counted from
-- `human_started_at` for the human arm, from `last_run_at` for the idle one)
-- the sweep stops trying and settles the row, because there is no browser
-- left.
create or replace function public.claim_due_browser_sessions(
  p_limit int default 3,
  p_stale_after interval default interval '15 minutes'
)
returns setof public.browser_sessions
language sql
security definer
set search_path = pg_catalog, public
as $$
  update public.browser_sessions b
  set claimed_at = now()
  where b.id in (
    select id from public.browser_sessions
    where (
        (live_state = 'human' and human_since <= now() - interval '10 minutes')
        or (
          live_state = 'none'
          and provider_browser_id is not null
          and last_run_at <= now() - interval '10 minutes'
        )
      )
      and (claimed_at is null or claimed_at < now() - p_stale_after)
    order by (live_state = 'human') desc, coalesce(human_since, last_run_at)
    for update skip locked
    limit p_limit
  )
  returning b.*;
$$;

-- The grant IS the security boundary. Revoking from named roles is not
-- enough: Postgres grants EXECUTE to PUBLIC by default and every role
-- inherits it, so a SECURITY DEFINER function returning rows that carry
-- `provider_session_id` -- withheld from every client above -- stays callable
-- through PostgREST unless PUBLIC is revoked explicitly.
revoke all on function public.claim_due_browser_sessions(int, interval) from public, anon, authenticated;
grant execute on function public.claim_due_browser_sessions(int, interval) to service_role;
