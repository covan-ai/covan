-- =========================================================================
-- A delivery to more than one place, and a run you can try first
--
-- The routine editor (A28) says where a run's result goes as a list — "Email
-- mina@acme.test, can@acme.test · Slack #support · Inbox" — and a routine has
-- had exactly one destination, `routines.delivery_channel_id`, since 0012.
-- That column stays, NOT NULL, as the primary: the one a notice about the
-- routine goes to and the one whose failure fails the run. `routine_channels`
-- names the others. A run delivers to the primary first and then to each of
-- these; one that cannot be reached is a sentence on the run
-- (`routine_runs.delivery_note`), not a failed run, because the result did
-- arrive where it was first meant to.
--
--   * A delivery channel is a person's (0019), so only somebody who owns both
--     the routine and the channel may add it to the list, and only the
--     routine's owner may take one off. Anybody who can see the routine can
--     see which channels it names — not what they are: `delivery_channels`
--     stays its owner's to read.
--   * Deleting a channel takes it off every list (cascade); a disabled one
--     (0088) is skipped at delivery.
--
-- "Run a test" (A28: "A test run costs the same and goes only to you") is a
-- run like any other — the same source, model and charge — that delivers to
-- nobody, files nothing, moves no cursor and leaves the schedule as it was.
-- Its result is a private thread for its owner, and its row says
-- `triggered_by = 'test'`.
--
-- And what a run cost. A run kept its total tokens (0012) and its model
-- (0070); a price needs the prompt and completion apart, so each run now
-- keeps them, which is what the editor's estimate ("About 15 to 25 credits per
-- run") and the list's footer ("14 runs in the last 7 days · 118 credits")
-- are priced from. `routine_run_totals` adds the window up by status and
-- model, over the runs the caller can see.
-- =========================================================================

create table if not exists public.routine_channels (
  routine_id          uuid        not null references public.routines (id) on delete cascade,
  delivery_channel_id uuid        not null references public.delivery_channels (id) on delete cascade,
  created_at          timestamptz not null default now(),
  primary key (routine_id, delivery_channel_id)
);

create index if not exists routine_channels_channel_idx
  on public.routine_channels (delivery_channel_id);

alter table public.routine_channels enable row level security;

-- `routines` answers under its own policies inside each of these, so a
-- routine the caller cannot see is a list they cannot see.
drop policy if exists "routine_channels_select_visible" on public.routine_channels;
create policy "routine_channels_select_visible"
  on public.routine_channels for select
  using (exists (select 1 from public.routines r where r.id = routine_channels.routine_id));

drop policy if exists "routine_channels_insert_own" on public.routine_channels;
create policy "routine_channels_insert_own"
  on public.routine_channels for insert
  with check (
    exists (
      select 1 from public.routines r
      where r.id = routine_channels.routine_id
        and r.user_id = auth.uid()
    )
    and exists (
      select 1 from public.delivery_channels dc
      where dc.id = routine_channels.delivery_channel_id
        and dc.user_id = auth.uid()
        and dc.disabled_at is null
    )
  );

drop policy if exists "routine_channels_delete_own" on public.routine_channels;
create policy "routine_channels_delete_own"
  on public.routine_channels for delete
  using (
    exists (
      select 1 from public.routines r
      where r.id = routine_channels.routine_id
        and r.user_id = auth.uid()
    )
  );

-- Held to an API key's workspace like every workspace table (0087). The
-- select policy already reaches the routine through its own RLS, but the
-- table carries no workspace_id, so the scope is written out here.
drop policy if exists routine_channels_request_workspace on public.routine_channels;
create policy routine_channels_request_workspace on public.routine_channels
  as restrictive for all to authenticated
  using ((select public.request_workspace()) is null
         or exists (select 1 from public.routines r
                     where r.id = routine_channels.routine_id
                       and r.workspace_id = (select public.request_workspace())));

revoke all on public.routine_channels from anon, authenticated;
grant select on public.routine_channels to authenticated;
grant insert (routine_id, delivery_channel_id) on public.routine_channels to authenticated;
grant delete on public.routine_channels to authenticated;
grant select, insert, update, delete on public.routine_channels to service_role;

-- ---- what a run cost, and a run that was a test --------------------------

alter table public.routine_runs
  add column if not exists prompt_tokens     integer,
  add column if not exists completion_tokens integer,
  add column if not exists cached_tokens     integer,
  add column if not exists delivery_note     text;

alter table public.routine_runs drop constraint if exists routine_runs_triggered_by_known;
alter table public.routine_runs add constraint routine_runs_triggered_by_known
  check (
    triggered_by is null
    or triggered_by in ('schedule', 'manual', 'webhook', 'event', 'reply', 'test')
  );

-- The window's runs, by status and model, over what the caller can see:
-- invoker, so `routine_runs_select_visible` and `routines_select_visible`
-- decide, exactly as they do for the runs list.
create or replace function public.routine_run_totals(p_workspace_id uuid, p_days integer)
returns table (
  status            text,
  model             text,
  runs              integer,
  tokens            bigint,
  prompt_tokens     bigint,
  completion_tokens bigint,
  cached_tokens     bigint,
  unsplit_tokens    bigint
)
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select rr.status,
         rr.model,
         count(*)::integer,
         coalesce(sum(rr.tokens), 0)::bigint,
         coalesce(sum(rr.prompt_tokens), 0)::bigint,
         coalesce(sum(rr.completion_tokens), 0)::bigint,
         coalesce(sum(rr.cached_tokens), 0)::bigint,
         -- Runs from before the split kept a total only.
         coalesce(sum(rr.tokens) filter (where rr.prompt_tokens is null), 0)::bigint
    from public.routine_runs rr
    join public.routines r on r.id = rr.routine_id
   where r.workspace_id = p_workspace_id
     and rr.started_at >= now() - make_interval(days => greatest(least(coalesce(p_days, 7), 90), 1))
   group by rr.status, rr.model;
$$;

revoke all on function public.routine_run_totals(uuid, integer) from public, anon;
grant execute on function public.routine_run_totals(uuid, integer) to authenticated, service_role;

-- Each routine's newest run, for the list's "Last run today, 09:00 · Done".
-- Invoker, for `routine_run_totals`' reason.
create or replace function public.routine_last_runs(p_routine_ids uuid[])
returns table (
  routine_id  uuid,
  id          uuid,
  status      text,
  started_at  timestamptz,
  finished_at timestamptz,
  session_id  uuid
)
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select distinct on (rr.routine_id)
         rr.routine_id, rr.id, rr.status, rr.started_at, rr.finished_at, rr.session_id
    from public.routine_runs rr
   where rr.routine_id = any(coalesce(p_routine_ids, '{}'::uuid[]))
   order by rr.routine_id, rr.started_at desc;
$$;

revoke all on function public.routine_last_runs(uuid[]) from public, anon;
grant execute on function public.routine_last_runs(uuid[]) to authenticated, service_role;
