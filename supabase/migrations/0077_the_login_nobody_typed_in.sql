-- A cookie jar that belongs to a person, and a browser they borrow for ten
-- minutes to fill it.
--
-- `browse` (0073) works on any page that needs no login, and stops dead at
-- every page that does. This makes that case recoverable without Covan ever
-- receiving a credential: the person is handed a live browser rented at
-- browser-use, signs in with their own hands, presses done, and the task runs
-- again with the jar attached. What is stored here is an opaque reference to
-- a jar held at the provider. No password, no cookie, no session token.
--
-- ---------------------------------------------------------------------------
-- WHY THE PROFILE IS PER PERSON, AND HAS NO `workspace_id`.
--
-- A login is a property of a human being, not of a room they happen to be
-- standing in. Somebody who signs into their own supplier portal has not
-- signed the workspace in; move them to a second workspace and the same
-- cookies are the same person's, still theirs, still the only ones they have.
-- There is no sense in which a second row would hold anything different.
--
-- This is the one place the design departs from `browser_tasks`, whose read
-- policy is `user_id = auth.uid() and is_workspace_member(workspace_id)`.
-- Here the second half has no subject: there is no workspace for a jar to be
-- about, so the policy is `user_id = auth.uid()` and stops there. That is
-- narrower than 0073's, not wider -- nobody but the owner ever sees the row,
-- in any room.
--
-- One profile per person rather than one per site, because browser-use
-- answers 402 on a profile limit counted against the whole deployment key,
-- and because a real browser does not keep a separate profile per site
-- either. `cookie_domains` is what the provider reports back -- the list of
-- domains it holds cookies for -- and is the whole of what Covan can tell
-- somebody about their own logins. Which is the right amount, because Covan
-- holds none of them.
--
-- `user_id` is `unique`, and that is load-bearing rather than tidy. Creating
-- the row races: two devices, or one double-click before the first response
-- lands, and find-or-create calls `POST /api/v2/profiles` twice. One insert
-- wins; the loser has already left a profile at browser-use that nothing in
-- this database can name and that counts against the account's limit
-- forever. So the Covan row is inserted FIRST with
-- `on conflict (user_id) do nothing ... returning`, the provider is called
-- only if the insert won, and a conflict means re-read. The unique index is
-- what makes that sequence possible.
--
-- `proxy_country_code` is pinned at creation and reused forever -- on the
-- takeover browser and on every later `browse` that attaches the profile.
-- Cookies are bound to the egress the login happened from: sign in through a
-- German datacenter, run the next task through a Dutch one, and the site
-- invalidates the session. The failure that produces is the nastiest kind --
-- the jar works once, then silently stops, and every later task hits a login
-- wall -- and the sign-in itself is what trips a site's risk engine into
-- demanding an email code or hard-locking the account. One stored column
-- buys that off.
--
-- ---------------------------------------------------------------------------
-- WHY THE TAKEOVER DOES HAVE ONE.
--
-- A profile is personal; a takeover ACTS inside a workspace's conversation.
-- It ends by writing a `browser_tasks` row into a session and an assistant
-- message into that session's transcript, so 0073's reason for the column
-- applies here word for word: "a person removed from a workspace should stop
-- seeing its rows, and `user_id = auth.uid()` alone would not say so."
--
-- Without it, somebody removed from the workspace between opening a takeover
-- and closing it would still cause the re-run to write a task into that
-- workspace's session, and the delivery to put an assistant message into a
-- conversation they can no longer see. The close route re-reads the original
-- task through the caller's own client for the same reason; the column is
-- what gives that re-read something to fail against.
--
-- ---------------------------------------------------------------------------
-- WHY `provider_profile_id` AND `provider_session_id` ARE GRANTED TO NO
-- CLIENT ROLE.
--
-- 0063's argument about `tool_connections.connected_account_id`, which 0073
-- already repeated for `provider_task_id`, and it is sharper here. One
-- deployment-wide `BROWSER_USE_API_KEY` serves every workspace, so an id at
-- that provider is not a label -- it is the whole address of the thing. For
-- `provider_profile_id` the thing is somebody's cookie jar: handed to a
-- client it is the one string needed to attach another person's logins to
-- your own task, through the provider's own API, with the deployment's key.
-- For `provider_session_id` it is a running browser somebody is signed into
-- right now, which also carries a live view URL.
--
-- `cookie_domains` is the only column a screen may show, and it is also the
-- only one worth showing: which sites this person is signed into, held at the
-- provider and never here. `proxy_country_code` is withheld too, not because
-- it is dangerous but because it is read only server side and an exposed
-- column is a column somebody will later build a screen on.
--
-- No insert, update or delete policy or grant for any client role on either
-- table. The whole content of a profile row is an address at a third party,
-- and a client that could write one could point its own row at somebody
-- else's jar -- which is the same attack as reading the id, through a
-- different door. Service role is the only road in, as it is for
-- `browser_tasks`.
--
-- ---------------------------------------------------------------------------
-- WHY `browser_task_id` IS `unique`, AND `on delete set null`.
--
-- `unique`: one task, one takeover, ever. Together with the `retry_of is
-- null` half of the offerable predicate below, this is belt and braces on one
-- hole -- a person being offered takeover twice for the same task, opening a
-- second browser, and signing in to a site they are already signed into. The
-- predicate is the half that reads nicely on a screen; this is the half the
-- database can actually enforce, and it is the half that survives two
-- concurrent requests.
--
-- `on delete set null` rather than `cascade`: deleting the conversation
-- mid-takeover would otherwise delete this row while the browser runs on at
-- the provider -- orphaned, never swept, never stopped, the profile never
-- saved, and a slot held in the account-wide concurrency pool until the
-- provider's own timeout. 0073's header flags exactly this class of leak for
-- its own `session_id`. A takeover that outlives the task it was recovering
-- is still a browser that must be stopped, so losing the row is the one
-- outcome that cannot be allowed.
--
-- ---------------------------------------------------------------------------
-- WHY `claimed_at` AND `provider_stopped_at` EXIST.
--
-- Neither is in the shape of the table the design sketched, and both are
-- needed by the sweep at the bottom of this file.
--
-- `claimed_at` because the claim function needs a staleness column, for the
-- reason `claim_due_browser_tasks` needs one: a worker that dies mid-stop
-- must not take the row out of circulation permanently. Same vocabulary as
-- `browser_tasks.claimed_at` and `connections.claimed_at` (0043) rather than
-- a second name for one mechanism.
--
-- `provider_stopped_at` because closing is two steps that can disagree. The
-- route flips the row to `closed` first and only then asks the provider to
-- stop -- that order is deliberate, because the reverse would leave a row
-- `open` on a failed `PATCH` and the one-open index would then lock the
-- person out of their own account until the next cron tick. But it means a
-- `closed` row is not proof that the browser stopped: the stop may have been
-- refused, in which case the jar was never saved and the browser is still
-- billing. This column records that the provider ACTUALLY stopped, so the
-- sweep can retry a stop that was only believed. Without it, "closed" and
-- "stopped" are one bit and the retry is impossible to express.
--
-- ---------------------------------------------------------------------------
-- WHY THE DUE INDEX COVERS ONLY HALF OF WHAT THE SWEEP ASKS FOR.
--
-- `browser_takeovers_due_idx` is partial on `status = 'open'`, so the second
-- arm of the claim's predicate -- a `closed` row the provider never confirmed
-- stopping -- is a sequential scan. That is a decision and not an oversight:
-- an index for that arm would exist entirely to hold rows that are empty
-- except in the minutes after a provider stop has FAILED, which is a thing
-- that happens rarely and resolves on the next tick. On a table holding at
-- most one open row per person, whose rows reach a terminal status within
-- minutes, the planner would seq-scan past such an index anyway.
--
-- ---------------------------------------------------------------------------
-- WHY `retry_of` EXISTS, ON THE EXISTING TABLE.
--
-- Not to make a screen read better -- though it does that too, letting the
-- conversation say "tried again" instead of showing two failures side by
-- side. It exists because it is how the card's offerable predicate knows not
-- to offer a second free attempt for a task that already has a successor.
--
-- The re-run after a takeover does not go through the `browse` tool, because
-- `browse` charges `BROWSER_TASK_TOKENS` and the person already paid it once;
-- a login wall is not something they did wrong. So the re-run writes a NEW
-- `browser_tasks` row with the service role, copying the original's
-- workspace, agent, user, session and task -- all resolved from an
-- authenticated request when the original was created, so nothing new is
-- being trusted. A new row rather than reopening the old one, so the old row
-- stays terminal and cannot be claimed twice: the poller's partial index
-- excludes terminal statuses, and reviving a row would put it back in the
-- claim set with a `poll_count` already near `MAX_POLLS`.
--
-- `retry_of` is the only thing connecting the two, and without it a person
-- whose retry is still running is invited to take over again. `on delete set
-- null` rather than `cascade`, because purging an old attempt must not delete
-- the answer that came from the new one.

create table if not exists public.browser_profiles (
  id uuid primary key default gen_random_uuid(),
  -- One jar per person, and `unique` is what makes find-or-create safe
  -- against the double-click. See the header.
  user_id uuid not null unique references auth.users (id) on delete cascade,
  -- The profile at browser-use. Never handed to a client; see the header.
  provider_profile_id text not null,
  -- Read back from the provider, and the only column a screen may show.
  cookie_domains jsonb,
  -- Pinned once, reused forever. Cookies are bound to the egress they were
  -- set from, so changing this later invalidates the jar it describes.
  proxy_country_code text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

comment on table public.browser_profiles is
  'One cookie jar per person, held at browser-use. Covan stores an opaque '
  'reference and never a credential: the sign-in happens in a browser the '
  'person drives, at the site itself (0077). No workspace column -- a login '
  'is a property of a person, not of a room.';

comment on column public.browser_profiles.provider_profile_id is
  'The profile id at browser-use. Withheld from every client role for '
  'connected_account_id''s reason (0063, repeated by 0073): one '
  'deployment-wide API key makes this id the entire address of somebody''s '
  'cookie jar, and the only thing separating two people at that provider.';

comment on column public.browser_profiles.cookie_domains is
  'The domains the provider reports holding cookies for. The whole of what '
  'Covan can tell somebody about their own logins, which is the right amount '
  'because Covan holds none of them.';

comment on column public.browser_profiles.proxy_country_code is
  'The egress country the jar was filled through, pinned at creation and '
  'reused on every task that attaches the profile. Cookies are bound to the '
  'egress they were set from; running a later task from elsewhere makes the '
  'site invalidate the session, which presents as a jar that worked once.';

alter table public.browser_profiles enable row level security;

-- No workspace half, because there is no workspace. See the header.
drop policy if exists "browser_profiles_read" on public.browser_profiles;
create policy "browser_profiles_read"
  on public.browser_profiles for select
  using (user_id = auth.uid());

revoke all on public.browser_profiles from anon, authenticated;
-- `cookie_domains` is the only thing a screen may show, and it is also the
-- one thing worth showing: which sites this person is signed into, held by
-- the provider and never by us. `provider_profile_id` and
-- `proxy_country_code` are withheld -- the first because one deployment key
-- makes it the whole address of somebody's cookie jar, the second because it
-- is only ever read server side.
grant select (id, user_id, cookie_domains, created_at, last_used_at)
  on public.browser_profiles to authenticated;
-- 0023's closing rule: a migration that adds a table grants for it, in the
-- same file.
grant select, insert, update, delete on public.browser_profiles to service_role;

create table if not exists public.browser_takeovers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Personal jar, workspace act. See the header.
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  profile_id uuid not null references public.browser_profiles (id) on delete cascade,
  -- One task, one takeover, ever -- and `set null` because a takeover that
  -- outlives its task is still a rented browser that must be stopped.
  browser_task_id uuid unique references public.browser_tasks (id) on delete set null,
  -- The rented browser at browser-use. Never handed to a client; it carries a
  -- live view of a page somebody is typing a password into.
  provider_session_id text not null,
  status text not null default 'open'
    check (status in ('open', 'closed', 'expired')),
  -- Deliberately shorter than the provider's own timeout
  -- (`TAKEOVER_PROVIDER_MINUTES`, 15): ten minutes here leaves two whole
  -- five-minute cron ticks in which the sweep can still stop the browser and
  -- save the jar. Equal values would give the sweep a window of zero and it
  -- could only ever fire after the provider had discarded the cookies.
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  -- The claim, and the proof. Both withheld from every client role, and both
  -- argued for in the header.
  claimed_at timestamptz,
  provider_stopped_at timestamptz
);

comment on table public.browser_takeovers is
  'A browser rented at browser-use for one person to sign in with their own '
  'hands, so a task that hit a login wall can run again (0077). At most one '
  'open row per person, enforced by browser_takeovers_one_open_idx.';

comment on column public.browser_takeovers.provider_session_id is
  'The browser session id at browser-use. Withheld from every client role '
  'for provider_profile_id''s reason, and more urgently: this names a running '
  'browser with a live view URL, pointed at a sign-in page.';

comment on column public.browser_takeovers.provider_stopped_at is
  'When the provider confirmed the browser stopped -- which is what saves the '
  'jar. Distinct from closed_at on purpose: the route marks the row closed '
  'before asking the provider to stop, so that it cannot leave an open row '
  'behind on a failed stop and lock the person out. A closed row with this '
  'column still null is a stop the provider refused, and the sweep retries '
  'it.';

-- One open takeover per person. The coarse half of the guard; the route does
-- the time-aware half, because `now()` is not immutable and a partial index
-- cannot reference it.
--
-- This index is the whole of the abuse story for the feature: without it one
-- account opens browsers until the account-wide concurrency pool is empty and
-- every other tenant's task 429s. But the index alone would lock somebody out
-- for up to a cron interval -- a row stays `open` until the sweep reaches it
-- -- so the route treats a row as in the way only if it is `open` AND still
-- inside its window, and closes an expired one itself before proceeding.
create unique index if not exists browser_takeovers_one_open_idx
  on public.browser_takeovers (user_id) where status = 'open';

-- The sweep's query. Partial for `browser_tasks_due_idx`'s reason.
create index if not exists browser_takeovers_due_idx
  on public.browser_takeovers (expires_at) where status = 'open';

alter table public.browser_takeovers enable row level security;

-- 0073's policy exactly, and for 0073's reasons: the row is the owner's, and
-- the workspace half is what makes a removed member stop seeing it.
drop policy if exists "browser_takeovers_read" on public.browser_takeovers;
create policy "browser_takeovers_read"
  on public.browser_takeovers for select
  using (user_id = auth.uid() and public.is_workspace_member(workspace_id));

revoke all on public.browser_takeovers from anon, authenticated;
-- `provider_session_id` is withheld for the header's reason; `claimed_at`
-- and `provider_stopped_at` because they are the sweep's own bookkeeping
-- about somebody's rented browser, in the same standing as
-- `browser_tasks.claimed_at`.
grant select (
  id, user_id, workspace_id, profile_id, browser_task_id, status, expires_at,
  created_at, closed_at
) on public.browser_takeovers to authenticated;
grant select, insert, update, delete on public.browser_takeovers to service_role;

-- A window that closes before it opens is the one nonsensical row the
-- database can recognise on its own, and it compares two columns rather than
-- calling `now()`, so it is immutable and cheap.
--
-- Deliberately no stronger than that. The invariant that matters is that
-- `expires_at` falls INSIDE the provider's own window -- ten minutes against
-- `TAKEOVER_PROVIDER_MINUTES`'s fifteen, which is what leaves the sweep two
-- cron ticks to save the jar -- and that belongs to the single writer rather
-- than here. Written as a check it would put the window length in a third
-- place, and it would start refusing valid rows the day somebody lengthens
-- the provider window. `openTakeover` owns it, and has a test for it.
--
-- Dropped and re-added rather than declared inline, for 0070's reason: a
-- create guarded by `if not exists` carries its inline constraints only on
-- the run that actually creates the table, so a tree where the table already
-- exists would get the table and not the check.
--
-- Which is not an argument against the inline constraints above -- `status`'s
-- check and `browser_task_id`'s `unique` are declared inline and are right to
-- be. The distinction is whether the constraint arrives with the table: a
-- table THIS migration introduces cannot exist without them, so inline is
-- both safe and where a reader looks for a column's invariants. A constraint
-- added later, to a table that may already be there, is the case that needs
-- the drop-and-add -- and this one is in that case on any tree where an
-- earlier form of 0077 was applied.
--
-- (Spelling that guarded-create phrase out in full here would also make
-- `scripts/check-rls.mjs` read the comment as a table declaration -- its
-- regex does not know prose from SQL.)
alter table public.browser_takeovers
  drop constraint if exists browser_takeovers_window_forward;
alter table public.browser_takeovers
  add constraint browser_takeovers_window_forward check (expires_at > created_at);

alter table public.browser_tasks
  add column if not exists retry_of uuid references public.browser_tasks (id) on delete set null;

comment on column public.browser_tasks.retry_of is
  'The attempt this one replaces, after a takeover. Lets the conversation say '
  '"tried again" rather than showing two failures side by side, and is how '
  'the offerable predicate knows not to offer a second free attempt for a '
  'task that already has a successor (0077).';

-- Lets the screen say "tried again", and is how the offerable predicate knows
-- not to offer a second free attempt. `on delete set null`, because purging an
-- old attempt must not delete the answer the new one produced.
create index if not exists browser_tasks_retry_of_idx
  on public.browser_tasks (retry_of) where retry_of is not null;

-- 0073 names its selectable columns one by one, so a new column is withheld
-- until a migration says otherwise. This says otherwise: `retry_of` is an id
-- of a row in a table the caller can already read under its own policy.
grant select (retry_of) on public.browser_tasks to authenticated;

-- ---- claim_due_browser_takeovers -----------------------------------------
-- The safety net, and the reason it exists is one sentence in the provider's
-- documentation: "if a session is left open or times out, changes may not be
-- persisted." A person who closes the tab instead of pressing done would
-- otherwise lose the login they just performed AND leak a rented browser
-- until its own timeout. A tick claims the abandoned rows, stops them at the
-- provider -- which saves the jar and stops the billing in the same call --
-- and marks them `expired`.
--
-- Character for character the mechanism of `claim_due_browser_tasks`
-- (0073:176-197), because the failure it defends against is the same one:
-- `src/index.ts` and `src/cron.ts` both export a `scheduled` handler against
-- one database, so two ticks genuinely do overlap, and a double claim would
-- mean two stop calls and two deliveries for one takeover. `for update skip
-- locked` inside the sub-select, so terminal rows are never locked and
-- counted against `p_limit` before being discarded (0055's reason).
--
-- `p_stale_after` defaults to the same 15 minutes as
-- `TAKEOVER_PROVIDER_MINUTES` in `lib/browser/profiles.ts`: a claim is
-- treated as abandoned once the provider's own window has run out, because
-- past that point there is nothing left to save and retrying costs one
-- request. The sweep passes the value explicitly, derived from that constant,
-- so the TypeScript is the single source of truth and this default is a
-- fallback nothing relies on.
--
-- The predicate carries one arm the task sweep has no need of. A row that is
-- `closed` with no `provider_stopped_at` is one whose stop the provider
-- refused: the route has already given up its lock on the row, but the
-- browser is still running and still billing, so the sweep is what retries
-- the stop. See the header on `provider_stopped_at` for why that order is the
-- right one.
create or replace function public.claim_due_browser_takeovers(
  p_limit int default 3,
  p_stale_after interval default interval '15 minutes'
)
returns setof public.browser_takeovers
language sql
security definer
set search_path = pg_catalog, public
as $$
  update public.browser_takeovers b
  set claimed_at = now()
  where b.id in (
    select id from public.browser_takeovers
    where (
      -- Abandoned: nobody pressed done, so the sweep is what saves the jar.
      (status = 'open' and expires_at <= now())
      -- Or: the row was closed but the provider refused the stop, so the
      -- browser is still running and still billing.
      or (status = 'closed' and closed_at is not null and provider_stopped_at is null)
    )
      and (claimed_at is null or claimed_at < now() - p_stale_after)
    order by expires_at
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
revoke all on function public.claim_due_browser_takeovers(int, interval) from public, anon, authenticated;
grant execute on function public.claim_due_browser_takeovers(int, interval) to service_role;
