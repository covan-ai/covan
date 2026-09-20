-- =========================================================================
-- A routine something else can poke
--
-- 0054 gave a routine somewhere to send its result. This gives it somewhere to
-- be started from: a URL a sender can POST to — GitHub, Stripe, a CI job, a
-- cron on somebody's own box — which runs the routine there and then.
--
-- Together the two make a routine a thing that sits in the middle of a stack
-- rather than at the end of one. That is the whole of the feature; everything
-- below is about not breaking three things that were already true.
--
-- WHAT THIS DELIBERATELY DOES NOT DO. `schedule_cron` stays `not null`.
-- Dropping it looks like one line and is not: `finish()`, `claim_due_routines`,
-- `PATCH /routines/:id`, `isValidCron`, the schedule picker and `cronToProse`
-- all assume a string is there. A nullable column would make every one of them
-- a null check, and the ones that are SQL would fail at 3am rather than in a
-- typechecker. So a webhook routine keeps a cron it does not run on, and a new
-- column says so instead.
-- =========================================================================

-- ---- routines.trigger_kind -----------------------------------------------
-- Three values rather than a boolean, because `both` is a real thing somebody
-- wants: a digest that runs every morning AND can be poked after a deploy.
-- Default `schedule`, which is what every existing row is by construction.
alter table public.routines
  add column if not exists trigger_kind text not null default 'schedule';

alter table public.routines
  drop constraint if exists routines_trigger_kind_check;

alter table public.routines
  add constraint routines_trigger_kind_check
  check (trigger_kind in ('schedule', 'webhook', 'both'));

comment on column public.routines.trigger_kind is
  'schedule | webhook | both. Whether this routine runs on its cron, only when poked through /routine-hooks/:token, or either. claim_due_routines skips the webhook-only ones.';

-- A poke-able routine must have no source of its own.
--
-- This looks like a restriction and is a refusal to answer a question whose
-- every answer is bad. "The routine has an RSS feed and somebody poked it —
-- does it re-fetch?" If yes, a busy sender charges the owner for a feed read
-- per request and moves a cursor on a schedule nobody chose. If no, the same
-- routine behaves differently depending on what started it, which is a thing
-- nobody will remember in six months.
--
-- Saying it as a constraint means it is said at creation, in the interface,
-- rather than discovered as an inconsistency later. And it is genuinely a
-- creation-time decision: 0027's trigger forbids changing `source_kind` after
-- the fact, so an existing RSS routine can never acquire a webhook trigger —
-- you make a new one. That is the honest shape of it.
alter table public.routines
  drop constraint if exists routines_webhook_needs_no_source_check;

alter table public.routines
  add constraint routines_webhook_needs_no_source_check
  check (trigger_kind = 'schedule' or source_kind = 'none');

-- ---- claim_due_routines skips what has no schedule to be due on ----------
-- The filter goes INSIDE the `for update skip locked` sub-select, not in the
-- outer update's where clause. Outside, the rows would still be locked and
-- counted against `p_limit` before being discarded — so a workspace with four
-- webhook routines could starve its scheduled ones out of every tick on the
-- free plan's batch of four, silently, while every row looked healthy.
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
      and trigger_kind <> 'webhook'
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

-- ---- routine_triggers ----------------------------------------------------
-- The token's hash lives in a table of its own, and this is security rather
-- than tidiness.
--
-- 0023 granted `authenticated` a table-level SELECT on `routines` with **no
-- column list**, and `routines_select_visible` opens a shared routine to every
-- member of its workspace. So had `ingest_token_hash` been a column on
-- `routines`, two things would have followed. A shared routine's hash would be
-- readable by every colleague — and a hash is not the token, but it is the
-- thing the server compares against. And worse: the same migration granted a
-- table-level UPDATE, so the owner of any routine could PATCH their own row's
-- hash to equal a colleague's through PostgREST, with no API involved. That is
-- not a leak, it is a takeover: either their teammate's webhook stops working,
-- or the sender's payload starts arriving at a routine of the attacker's
-- choosing, with the attacker's instruction and the attacker's delivery
-- channel.
--
-- A separate table closes both halves: the hash is granted to nobody, and the
-- `unique` constraint means two routines cannot claim one token even if
-- something did manage to write it.
create table if not exists public.routine_triggers (
  -- The primary key IS the routine: one trigger per routine, enforced by the
  -- shape rather than by a uniqueness rule somebody has to remember to add.
  -- Rotating replaces the hash in place.
  routine_id uuid primary key references public.routines (id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  -- Answers "is this thing actually wired up?" without keeping any record of
  -- what was sent. Written on each accepted poke.
  last_used_at timestamptz
);

comment on table public.routine_triggers is
  'The SHA-256 of a routine''s ingest token. Separate from routines because that table grants authenticated a table-level select AND update with no column list, and routines_select_visible shares a routine with the whole workspace.';

alter table public.routine_triggers enable row level security;

-- Visible to the routine's owner alone — deliberately narrower than the
-- routine's own visibility. Sharing a routine shares what it does and what it
-- sent; it does not share the ability to fire it.
drop policy if exists "routine_triggers_select_own" on public.routine_triggers;
create policy "routine_triggers_select_own"
  on public.routine_triggers for select
  using (
    exists (
      select 1 from public.routines r
      where r.id = routine_triggers.routine_id and r.user_id = auth.uid()
    )
  );

-- Deleting a trigger is turning the webhook off, and that is an ordinary thing
-- for an owner to do without the server's help.
drop policy if exists "routine_triggers_delete_own" on public.routine_triggers;
create policy "routine_triggers_delete_own"
  on public.routine_triggers for delete
  using (
    exists (
      select 1 from public.routines r
      where r.id = routine_triggers.routine_id and r.user_id = auth.uid()
    )
  );

-- The grant, which is the part that matters.
--
-- `token_hash` is in no column list here, so no client can read it and no
-- client can write it — which is the entire reason this table exists. There is
-- no INSERT and no UPDATE grant at all: minting a token means hashing it, and
-- only the server can do that, exactly as with `delivery_channels`
-- (`routes/routines.ts` holds that exemption already).
--
-- Written in this migration rather than inherited: 0023 removed the wide
-- default privileges precisely so that a new table is unreachable until
-- somebody says otherwise here, in writing.
revoke all on public.routine_triggers from anon, authenticated;
grant select (routine_id, created_at, last_used_at) on public.routine_triggers to authenticated;
grant delete on public.routine_triggers to authenticated;
