-- =========================================================================
-- A routine can watch what the workspace already syncs
--
-- Two changes, both about a routine reporting less than it saw.
--
-- The first is a fourth source kind. A routine could watch an RSS feed or a
-- web page — the open internet — and not the places the team's own work
-- actually lives, even when a connection (0043) was already re-reading those
-- places on a schedule and filing the results in a bundle. So "tell me what
-- changed in the handbook" was not expressible, while "tell me what changed on
-- a competitor's blog" was.
--
-- What this deliberately does NOT do is give the routine engine its own Notion
-- or Drive client. 0043 says it plainly: nothing here queries a provider at
-- question time, and there is one substrate rather than a second retrieval
-- path with its own permissions to get wrong. A `connection` routine reads
-- `documents` — rows the reconciler has already fetched, versioned, chunked
-- and (when a document is withdrawn at the source) removed. The routine adds
-- no provider call, no second token decrypt, and nothing to the sync's
-- subrequest budget.
--
-- The cost of that choice is latency, and it is worth naming: a connection
-- syncs every `sync_interval_minutes` (six hours by default), so a routine
-- pointed at one sees a change no sooner than the sync does, whatever its own
-- cron says. The create dialog says so.
--
-- The second change is `items_overflow`. A run delivers at most ten new
-- entries but marks everything it saw as seen, so a burst of forty reports ten
-- and silently drops thirty. `diffItems` has always computed that number and
-- the executor has always thrown it away, which made a documented behaviour
-- invisible in the one place someone would look for it.
-- =========================================================================

-- ---- routines.source_kind: 'connection' ----------------------------------
-- `source_config` carries {"connectionId": "<uuid>"} for this kind, the way it
-- carries {"url": "..."} for the other two. A column would be tidier and is
-- deliberately not added: the FK it would want is exactly what the policy
-- below has to re-check anyway (the system checks FKs with RLS bypassed), so a
-- column would buy referential integrity and still leave the tenancy guard to
-- be written by hand.
-- Found rather than named. 0012 wrote the check inline on the column, so its
-- name is whatever Postgres generated — `routines_source_kind_check` today, and
-- something else on any database where the column was ever rebuilt. A
-- `drop constraint if exists` against a guessed name does not fail loudly if it
-- guesses wrong: it skips, the new constraint is added alongside the old one,
-- and every `connection` routine is then refused by a constraint nobody is
-- looking at. So the old one is looked up by what it constrains.
do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select con.conname
    from pg_constraint con
    where con.conrelid = 'public.routines'::regclass
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%source_kind%'
  loop
    execute format('alter table public.routines drop constraint %I', constraint_name);
  end loop;
end;
$$;

alter table public.routines
  add constraint routines_source_kind_check
  check (source_kind in ('rss', 'web', 'none', 'connection'));

-- A routine of this kind must name a connection, and one that exists in its own
-- workspace. Without the first half, `source_config->>'connectionId'` is null
-- and the executor fails every run of a routine that looked fine when it was
-- saved; without the second, the guard is left entirely to the policies below,
-- and a check constraint is the cheaper place to catch the shape.
alter table public.routines
  drop constraint if exists routines_connection_config_check;

alter table public.routines
  add constraint routines_connection_config_check
  check (
    source_kind <> 'connection'
    -- `coalesce`, not a bare `->>`. A missing key yields NULL, `NULL ~ ...` is
    -- NULL, and a CHECK constraint only refuses FALSE — so without this a
    -- connection routine with no connectionId at all passes the one guard that
    -- still applies when row level security does not. The policy below catches
    -- it for an ordinary client; the service role is why that is not enough.
    or coalesce(source_config ->> 'connectionId', '')
       ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  );

-- ---- the tenancy guard ---------------------------------------------------
-- Same reasoning as the agent and delivery-channel guards these policies
-- already carry, and the same mechanism: a subquery inside a policy respects
-- the referenced table's own RLS, so `connections` resolves only to rows the
-- caller can already see — which for connections means their workspace's
-- (`connections_select_member`).
--
-- Without this, `authenticated` holds a table-level INSERT/UPDATE grant and the
-- anon key ships in the browser bundle, so a crafted PostgREST write could
-- point a routine at another workspace's connection. The service-role executor
-- would then read that connection's documents and mail their titles and
-- excerpts to a channel in this workspace. The routine never touches the
-- provider, so nothing else in the stack would have refused it.
--
-- Written as a helper because the same expression belongs in both policies, and
-- two hand-copied subqueries drift.
create or replace function public.routine_source_is_visible(
  p_source_kind text,
  p_source_config jsonb,
  p_workspace_id uuid
) returns boolean
language sql
stable
-- Deliberately NOT security definer. This has to run as the caller so the
-- subquery is filtered by the caller's own RLS; as definer it would see every
-- connection in the database and answer true for all of them.
as $$
  select
    p_source_kind <> 'connection'
    or exists (
      select 1 from public.connections cn
      -- Cast the row's id to text rather than the input to uuid. A malformed
      -- string in `source_config` would make `::uuid` raise, and an exception
      -- from inside a policy reaches the client as a 500 — a crafted write
      -- would be answered with "server error" instead of "refused". Comparing
      -- as text cannot raise, so a nonsense id simply matches nothing.
      where cn.id::text = (p_source_config ->> 'connectionId')
        and cn.workspace_id = p_workspace_id
    );
$$;

comment on function public.routine_source_is_visible(text, jsonb, uuid) is
  'True unless the routine watches a connection the caller cannot see in that workspace. Runs as the caller so the subquery is RLS-filtered; must not become SECURITY DEFINER.';

drop policy if exists "routines_insert_own" on public.routines;
create policy "routines_insert_own"
  on public.routines for insert
  with check (
    user_id = auth.uid()
    and public.is_workspace_member(workspace_id)
    and exists (
      select 1 from public.agents a
      where a.id = routines.agent_id and a.workspace_id = routines.workspace_id
    )
    and exists (
      select 1 from public.delivery_channels dc
      where dc.id = routines.delivery_channel_id and dc.user_id = auth.uid()
    )
    and public.routine_source_is_visible(
      routines.source_kind, routines.source_config, routines.workspace_id
    )
  );

-- The WITH CHECK carries exactly the same guards as the INSERT policy, for the
-- reason 0012 gives: a weaker one lets an owner repoint their own row at
-- something the INSERT would have refused.
--
-- The connection half of it is, today, unreachable: 0027's trigger raises on
-- any update that changes `source_kind` or `source_config`, so an existing
-- routine cannot be repointed at another workspace's connection whatever this
-- policy says. It is written anyway, for the reason 0043 gives about writing a
-- policy for a grant nobody holds — a trigger is one `drop trigger` away from
-- being removed by somebody solving a different problem, and a guard that was
-- never written is not there to catch that.
drop policy if exists "routines_update_own" on public.routines;
create policy "routines_update_own"
  on public.routines for update
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and public.is_workspace_member(workspace_id)
    and exists (
      select 1 from public.agents a
      where a.id = routines.agent_id and a.workspace_id = routines.workspace_id
    )
    and exists (
      select 1 from public.delivery_channels dc
      where dc.id = routines.delivery_channel_id and dc.user_id = auth.uid()
    )
    and public.routine_source_is_visible(
      routines.source_kind, routines.source_config, routines.workspace_id
    )
  );

-- ---- what the cap declined -----------------------------------------------
-- Counted separately from `items_new` rather than folded into it, because the
-- two answer different questions: `items_new` is what the summary is about, and
-- this is what the summary is missing. Nothing recomputes it later — the seen
-- window has moved on by then — so a run that does not record it has lost it.
alter table public.routine_runs
  add column if not exists items_overflow int not null default 0;

comment on column public.routine_runs.items_overflow is
  'New entries this run saw and did not deliver, dropped by the per-run cap. Marked seen regardless, so they are never delivered later.';
