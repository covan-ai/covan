-- =========================================================================
-- A routine that waits for something to happen
--
-- 0055 let a routine be started from outside: a URL somebody else's system
-- POSTs to. That covers every sender that can be pointed at a URL, and it
-- leaves out the ones that cannot — a Gmail inbox, a calendar, a Slack
-- channel, a Notion database. Those do not call anybody. Something has to go
-- and ask them to, once, on the routine's behalf, and then remember that it
-- asked: which third party, which subscription id it handed back, which
-- secret it signs its deliveries with, and whether the arrangement is still
-- alive.
--
-- This migration is that memory, and the engine changes that go with it. A
-- routine gets a fourth way to start — `event` — and a row saying what it is
-- waiting for. The run itself goes down exactly the road a webhook run does
-- (`runPokedRoutine` → `runRoutine`): the same membership check, the same
-- credit check, the same claim-before-send, the same delivery. Nothing about
-- running is new. What is new is everything around it: subscribing,
-- unsubscribing, renewing, and refusing to let one noisy inbox spend a
-- workspace's month in an afternoon.
--
-- The providers themselves are not here. A row names a provider and an event
-- type out of the worker's catalogue (`lib/routines/events/catalog.ts`), and
-- the code that speaks to each provider is an adapter behind one interface.
-- This file only has to be right about the shape every adapter shares.
--
-- WHAT THIS DELIBERATELY DOES NOT DO.
--
--   * It does not make a routine wait for more than one thing. The primary key
--     is the routine, as it is on `routine_triggers`: one routine, one
--     trigger. An agent can have as many routines as it likes, so "do this
--     when a mail arrives OR when the calendar changes" is two routines with
--     one instruction each, which is also the version whose history says which
--     of the two started a run.
--
--   * It does not let an event routine have a source. 0055's constraint is
--     widened to say so: "a mail arrived and the routine also watches a feed —
--     does it re-fetch?" has the same bad answers it had for a webhook.
--
--   * It does not keep a tombstone for a routine that was hard-deleted. The
--     row cascades with its routine, and with it the id of the subscription at
--     the third party. `DELETE /routines/:id` unsubscribes first, which is the
--     ordinary road; the roads that cannot (a workspace or an account being
--     deleted, which cascade from much further up) leave a subscription at the
--     provider with nobody behind it. Each adapter that can is expected to
--     answer a delivery for a subscription nobody here knows by cancelling it
--     at the source — the next event cleans it up — and that is cheaper and
--     more honest than a table of things we used to be subscribed to.
--
--   * It does not store what arrived. The payload reaches the model and
--     nothing else, exactly as a webhook's does (0055). The only things written
--     about an event are a clock reading and two counters.
--
--   * It does not give `paused_reason` a code. A routine that drowned in events
--     is paused with a sentence a person reads, the same as every other engine
--     pause on `routines`; 0057's `paused_code` exists on `connections`
--     because the interface branches on it there, and nothing branches on this.
-- =========================================================================

-- ---- routines.trigger_kind -----------------------------------------------
--
-- Dropped by NAME, which 0075 explains at length and which matters here for
-- the same reason: there are several check constraints on this table, and a
-- discovery loop that drops every one mentioning `trigger_kind` would take
-- `routines_webhook_needs_no_source_check` with it on the way past.
alter table public.routines drop constraint if exists routines_trigger_kind_check;
alter table public.routines
  add constraint routines_trigger_kind_check
  check (trigger_kind in ('schedule', 'webhook', 'both', 'event'));

comment on column public.routines.trigger_kind is
  'schedule | webhook | both | event. Whether this routine runs on its cron, only when poked through /routine-hooks/:token, either, or only when the third-party event in routine_event_subscriptions arrives. claim_due_routines skips webhook and event.';

-- Written as "only `schedule` may have a source" rather than by adding `event`
-- to a list of the kinds that may not. The next way to start a routine will
-- want the same rule, and a constraint that names what is allowed fails closed
-- for a value nobody thought about; one that names what is forbidden fails
-- open.
--
-- Same name as 0055's, on purpose: it is the same rule, about one more value,
-- and the comments that point at it by name (0075, `routes/routines.ts`) stay
-- true.
alter table public.routines drop constraint if exists routines_webhook_needs_no_source_check;
alter table public.routines
  add constraint routines_webhook_needs_no_source_check
  check (trigger_kind in ('schedule') or source_kind = 'none');

-- ---- claim_due_routines skips what is waiting for an event ----------------
--
-- 0055's function with one word changed, and the filter stays INSIDE the
-- `for update skip locked` sub-select for 0055's reason: outside, event-only
-- rows would be locked and counted against `p_limit` before being thrown away,
-- and a workspace with a few of them could starve its scheduled routines out
-- of every tick on the free plan's batch of four.
--
-- An event routine still has a `schedule_cron` and a `next_run_at`, for the
-- reason 0055 kept them on a webhook routine — six places assume a string is
-- there. They are simply never due.
create or replace function public.claim_due_routines(
  p_limit int default 10,
  p_stale_after interval default interval '15 minutes'
)
returns setof public.routines
language sql
security definer
set search_path = pg_catalog, public
as $$
  update public.routines r
  set claimed_at = now()
  where r.id in (
    select id from public.routines
    where status = 'active'
      and deleted_at is null
      and trigger_kind not in ('webhook', 'event')
      and next_run_at <= now()
      and (claimed_at is null or claimed_at < now() - p_stale_after)
    order by next_run_at
    for update skip locked
    limit p_limit
  )
  returning r.*;
$$;

revoke all on function public.claim_due_routines(int, interval) from public, anon, authenticated;
grant execute on function public.claim_due_routines(int, interval) to service_role;

-- ---- routine_event_subscriptions -----------------------------------------
--
-- A table of its own for `routine_triggers`' reason, which applies here with
-- more force. 0023 granted `authenticated` a table-level SELECT and UPDATE on
-- `routines` with no column list, and a shared routine is readable by its
-- whole workspace. A bot token, a webhook signing secret or a subscription id
-- at a third party sitting on that row would be readable by every colleague
-- and rewritable by its owner — and an owner who can rewrite their own row's
-- subscription id can point it at somebody else's, which is the same takeover
-- 0055 describes for a token hash.
create table if not exists public.routine_event_subscriptions (
  -- The routine IS the key: one routine waits for one thing. Changing what it
  -- waits for replaces the row, so nothing about the old subscription can
  -- survive into the new one.
  routine_id uuid primary key references public.routines (id) on delete cascade,
  -- Who sends it — `composio`, `slack`, `github`, `telegram` — which picks the
  -- adapter. Free text checked by the worker against its own registry rather
  -- than by a CHECK here, for `connection_capabilities`' reason: a value is
  -- only meaningful if this build has the code for it, and a list in SQL would
  -- claim providers a self-hosted build never shipped.
  provider text not null check (length(provider) between 1 and 40),
  -- What it waits for, as an id out of the worker's catalogue:
  -- `gmail.new_message`, `slack.reaction_added`. The catalogue, not this
  -- column, knows what the id means and which config it takes.
  event_type text not null check (length(event_type) between 1 and 80),
  -- The person's choices: a Gmail query, a channel, a branch, a keyword. What
  -- the provider is asked to filter on and what the worker filters on after.
  -- Never a secret — that is the next column but one — because the owner can
  -- read this one back.
  config jsonb not null default '{}'::jsonb,
  -- The provider's own id for the arrangement: a Composio trigger instance
  -- (`ti_...`), a Drive channel id, a Telegram bot's id. What a delivery is
  -- matched against when it arrives, and what unsubscribing names.
  external_id text,
  -- A bot token or a signing secret, sealed by `lib/secret-box.ts` with
  -- ROUTINE_SECRET_KEY exactly as `delivery_channels.secret_ciphertext` is.
  -- Readable by no client role; see the grants.
  secret_ciphertext text,
  -- The provider's cursor, when it has one: Drive's `pageToken`, a WebSub
  -- lease. Engine-owned, like `routines.cursor`.
  state jsonb not null default '{}'::jsonb,
  -- Where the arrangement stands at the provider. `pending` until the first
  -- subscribe succeeds; `active` while events are expected; `failed` when the
  -- provider refused or could not be reached (and the sweeper will try again);
  -- `expired` when the connection behind it lapsed and a person has to
  -- reconnect; `disabled` while the routine is paused or binned, so a paused
  -- routine is not billed for events nobody will act on.
  status text not null default 'pending'
    check (status in ('pending', 'active', 'failed', 'expired', 'disabled')),
  -- The sentence that goes with a `failed` or `expired`, written for the
  -- owner to read. Null otherwise.
  status_detail text,
  -- When the provider will forget this arrangement unless it is renewed —
  -- Drive channels last a week, WebSub leases days. Null for the ones that
  -- never lapse.
  expires_at timestamptz,
  -- How many times in a row the last subscribe or renew failed, and when the
  -- sweeper may try again. Doubles per attempt; also used as a short lease
  -- while one tick is working on the row, so two ticks do not both subscribe.
  attempts int not null default 0,
  next_attempt_at timestamptz,
  -- The flood guard's two windows. Fixed windows that start at the first
  -- event after the previous one closed, which is coarser than a sliding
  -- window and needs no history: two integers and two clocks, updated in the
  -- same statement that decides whether the event may run.
  hour_started_at timestamptz,
  hour_count int not null default 0,
  day_started_at timestamptz,
  day_count int not null default 0,
  -- The last event that passed its filter and started a run. "Is this
  -- actually wired up?" without keeping any record of what was sent — the
  -- same answer `routine_triggers.last_used_at` gives.
  last_event_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table public.routine_event_subscriptions is
  'What an event-triggered routine is waiting for, and the arrangement made with the third party that will tell us. Separate from routines because that table grants authenticated a table-level select and update with no column list, and a shared routine is readable by its whole workspace.';

-- The sweeper's question, and the one Composio-style deliveries ask: which
-- row holds this provider's id. Partial, because most rows have one and the
-- `pending` ones do not yet.
create unique index if not exists routine_event_subscriptions_external_idx
  on public.routine_event_subscriptions (provider, external_id)
  where external_id is not null;

create index if not exists routine_event_subscriptions_attention_idx
  on public.routine_event_subscriptions (next_attempt_at)
  where status in ('pending', 'failed');

alter table public.routine_event_subscriptions enable row level security;

-- Visible to the routine's owner alone, deliberately narrower than the
-- routine's own visibility, for 0055's reason: sharing a routine shares what
-- it does and what it sent, not the arrangement that fires it — and here, not
-- the fact of which inbox or channel it is listening to either.
drop policy if exists "routine_event_subscriptions_select_own" on public.routine_event_subscriptions;
create policy "routine_event_subscriptions_select_own"
  on public.routine_event_subscriptions for select
  using (
    exists (
      select 1 from public.routines r
      where r.id = routine_event_subscriptions.routine_id and r.user_id = auth.uid()
    )
  );

-- An API key stays in the workspace it was made in (0087), and so does what
-- it can read here: the same restrictive policy `routine_triggers` carries.
drop policy if exists routine_event_subscriptions_request_workspace on public.routine_event_subscriptions;
create policy routine_event_subscriptions_request_workspace on public.routine_event_subscriptions
  as restrictive for all to authenticated
  using ((select public.request_workspace()) is null or exists (
    select 1 from public.routines r
     where r.id = routine_event_subscriptions.routine_id
       and r.workspace_id = (select public.request_workspace())));

-- The grants.
--
-- No DELETE for `authenticated`, which is where this differs from
-- `routine_triggers`. Turning a webhook off is deleting a hash; turning an
-- event off is telling a third party to stop, and a row deleted by a client
-- would leave the subscription running at the provider with nothing here to
-- name it. So it goes through `DELETE /routines/:id/event`, which unsubscribes
-- and then deletes, with the service role.
--
-- `external_id`, `secret_ciphertext`, `state` and the counters are in no
-- column list. The secret for the obvious reason; the external id for
-- `connected_account_id`'s (0063) — with one deployment-wide provider key it
-- is the whole address of the arrangement — and the state and counters
-- because they are the engine's bookkeeping and say nothing a person needs.
revoke all on public.routine_event_subscriptions from anon, authenticated;
grant select (routine_id, provider, event_type, config, status, status_detail,
              expires_at, last_event_at, created_at)
  on public.routine_event_subscriptions to authenticated;

-- All four for the engine: SELECT to resolve a delivery that arrives with no
-- caller, INSERT and UPDATE because subscribing is the server's job, DELETE
-- because changing what a routine waits for replaces the row. 0023 is why
-- this has to be said at all; `src/lib/migration-grants.test.ts` is why it
-- would be caught if it were not.
grant select, insert, update, delete on public.routine_event_subscriptions to service_role;

-- ---- the sweeper's claim -------------------------------------------------
--
-- Which subscriptions need the engine's attention, handed out with
-- `for update skip locked` so two ticks — the API Worker's and the cron
-- Worker's, which `cron.ts` explains — never work on the same row.
--
-- "Attention" is a drift between what the row says and what it should say:
--
--   * `pending` or `failed`, and due another try;
--   * `active` with an expiry inside the next day, so it is renewed before it
--     lapses rather than after;
--   * `active` on a routine that is no longer running — paused, binned with
--     its agent, or switched to another trigger — so the provider is told to
--     stop;
--   * `disabled` on a routine that is running again — an agent restored from
--     the bin brings its routines back without anybody pressing Resume — so
--     the provider is told to start.
--
-- The claim is a lease: `next_attempt_at` moves ten minutes out, and the
-- worker writes the real value when it is done. A tick that dies mid-way
-- leaves the row to be picked up again after the lease, not stranded.
--
-- SECURITY INVOKER, deliberately. The only caller is the service role, which
-- holds every grant this needs; as definer it would be one more function whose
-- whole boundary is a revoke, and `definer-grant.static.test.ts` exists
-- because those get forgotten. Revoked from the client roles anyway: as
-- invoker it could do nothing for them, and "could do nothing" is not a thing
-- to leave a reader to verify.
create or replace function public.claim_event_subscriptions(p_limit int default 3)
returns setof public.routine_event_subscriptions
language sql
security invoker
set search_path = pg_catalog, public
as $$
  update public.routine_event_subscriptions s
  set next_attempt_at = now() + interval '10 minutes'
  where s.routine_id in (
    select e.routine_id
      from public.routine_event_subscriptions e
      left join public.routines r on r.id = e.routine_id
     where coalesce(e.next_attempt_at, '-infinity'::timestamptz) <= now()
       and (
         e.status in ('pending', 'failed')
         or (e.status = 'active' and e.expires_at is not null
             and e.expires_at <= now() + interval '1 day')
         or (e.status = 'active' and not (r.status = 'active' and r.deleted_at is null
                                          and r.trigger_kind = 'event'))
         or (e.status = 'disabled' and r.status = 'active' and r.deleted_at is null
             and r.trigger_kind = 'event')
       )
     order by e.next_attempt_at nulls first
     for update of e skip locked
     limit p_limit
  )
  returning s.*;
$$;

revoke all on function public.claim_event_subscriptions(int) from public, anon, authenticated;
grant execute on function public.claim_event_subscriptions(int) to service_role;

-- ---- the flood guard -----------------------------------------------------
--
-- One event, counted, and the answer to whether it may run: `ok`, `hour` or
-- `day` for the window it broke, or `missing` when the row is gone.
--
-- One statement, because the count and the decision have to be the same
-- moment. Counting the runs in `routine_runs` instead would count only runs
-- that had FINISHED — a burst of a hundred mails arriving inside the minute
-- the first run takes would all see a count of zero and all start. Counting
-- here, before the run is deferred, is what makes a burst stop at the limit.
--
-- `last_event_at` moves only on an event that is allowed. A routine paused for
-- a flood should say when it last ran, not when the flood last knocked.
--
-- Invoker and service-role only, for the claim's reason above.
create or replace function public.count_routine_event(
  p_routine_id uuid,
  p_per_hour int,
  p_per_day int
)
returns text
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_hour int;
  v_day int;
begin
  update public.routine_event_subscriptions s
     set hour_started_at = case
           when s.hour_started_at is null or s.hour_started_at <= now() - interval '1 hour'
           then now() else s.hour_started_at end,
         hour_count = case
           when s.hour_started_at is null or s.hour_started_at <= now() - interval '1 hour'
           then 1 else s.hour_count + 1 end,
         day_started_at = case
           when s.day_started_at is null or s.day_started_at <= now() - interval '1 day'
           then now() else s.day_started_at end,
         day_count = case
           when s.day_started_at is null or s.day_started_at <= now() - interval '1 day'
           then 1 else s.day_count + 1 end
   where s.routine_id = p_routine_id
  returning s.hour_count, s.day_count into v_hour, v_day;

  if not found then
    return 'missing';
  end if;
  if v_hour > p_per_hour then
    return 'hour';
  end if;
  if v_day > p_per_day then
    return 'day';
  end if;

  update public.routine_event_subscriptions
     set last_event_at = now()
   where routine_id = p_routine_id;
  return 'ok';
end;
$$;

revoke all on function public.count_routine_event(uuid, int, int) from public, anon, authenticated;
grant execute on function public.count_routine_event(uuid, int, int) to service_role;

-- ---- routine_runs: what started this one ---------------------------------
--
-- Until now a run's history could say how it went and what the model did
-- (0070), and not why it happened at all. With one way to start, that was
-- obvious; with a cron, a button, a webhook and every app in the catalogue,
-- "why did this run at 03:12?" is the first question somebody asks of a row,
-- and the answer existed only in the webhook receiver's payload.
--
-- `triggered_by` is the vocabulary a program branches on, and the same words
-- `run.triggeredBy` already carries to a webhook receiver; `trigger_label` is
-- what a person reads — "Gmail · New mail". Null for every run before this,
-- which is the truth: nothing recorded it.
--
-- `reply` is here before the code that writes it, so the build that does is
-- not refused by a constraint nobody remembered to widen — 0101's ordering
-- lesson, taken in advance.
alter table public.routine_runs
  add column if not exists triggered_by text,
  add column if not exists trigger_label text;

alter table public.routine_runs drop constraint if exists routine_runs_triggered_by_known;
alter table public.routine_runs add constraint routine_runs_triggered_by_known
  check (
    triggered_by is null
    or triggered_by in ('schedule', 'manual', 'webhook', 'event', 'reply')
  );

alter table public.routine_runs drop constraint if exists routine_runs_trigger_label_short;
alter table public.routine_runs add constraint routine_runs_trigger_label_short
  check (trigger_label is null or length(trigger_label) <= 120);

comment on column public.routine_runs.triggered_by is
  'What started this run: schedule, manual (Run now), webhook, event (routine_event_subscriptions), or reply. Null for runs before 0108.';
comment on column public.routine_runs.trigger_label is
  'The same, for a person: the event''s catalogue label, such as "Gmail · New mail". Null for scheduled and manual runs.';

-- No grant change. 0094 revoked every client write on `routine_runs` — it is
-- written by the engine alone — and 0023's table-level SELECT, scoped by
-- `routine_runs_select_visible` (0012), covers two more columns the moment
-- they exist, as 0070 noted for its own two.
