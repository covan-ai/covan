-- Agent routines: standing orders that run on a schedule, watch a source,
-- and deliver a summary to Slack or email.

-- ---- delivery_channels ---------------------------------------------------
-- One row per configured destination. The secret is encrypted by the worker
-- (AES-GCM) before it is ever written, so this column holds ciphertext of the
-- form "v1.<iv-base64>.<ciphertext-base64>" — the version prefix is what makes
-- a later key rotation readable rather than a wave of decrypt failures. Rows
-- are only ever INSERTed by the
-- service role; `authenticated` gets column-limited SELECT so the secret can
-- never be read back by a client.
create table if not exists public.delivery_channels (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('slack_webhook', 'email')),
  label text not null,
  secret_ciphertext text not null,
  created_at timestamptz not null default now()
);

create index if not exists delivery_channels_owner_idx
  on public.delivery_channels (user_id);

alter table public.delivery_channels enable row level security;

drop policy if exists "delivery_channels_select_own" on public.delivery_channels;
create policy "delivery_channels_select_own"
  on public.delivery_channels for select
  using (user_id = auth.uid());

drop policy if exists "delivery_channels_update_own" on public.delivery_channels;
create policy "delivery_channels_update_own"
  on public.delivery_channels for update
  using (user_id = auth.uid());

drop policy if exists "delivery_channels_delete_own" on public.delivery_channels;
create policy "delivery_channels_delete_own"
  on public.delivery_channels for delete
  using (user_id = auth.uid());

-- RLS is row-level and cannot hide a column. Column-level grants can: strip the
-- blanket grant Supabase gives `authenticated`, then hand back everything
-- except secret_ciphertext. INSERT is deliberately not granted — creation goes
-- through the worker, which has to encrypt the secret anyway.
revoke all on public.delivery_channels from anon, authenticated;
grant select (id, workspace_id, user_id, kind, label, created_at)
  on public.delivery_channels to authenticated;
grant update (label) on public.delivery_channels to authenticated;
grant delete on public.delivery_channels to authenticated;

-- ---- routines ------------------------------------------------------------
create table if not exists public.routines (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  agent_id uuid not null references public.agents (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  visibility text not null default 'private'
    check (visibility in ('private', 'shared')),
  source_kind text not null check (source_kind in ('rss', 'web', 'none')),
  source_config jsonb not null default '{}'::jsonb,
  instruction text not null,
  -- Deferred NO ACTION allows workspace/user cascades to complete before the
  -- FK check fires. Direct channel deletes still error, supporting the API's 409.
  delivery_channel_id uuid not null
    references public.delivery_channels (id)
    on delete no action deferrable initially deferred,
  status text not null default 'active' check (status in ('active', 'paused')),
  paused_reason text,
  schedule_cron text not null,
  timezone text not null default 'UTC',
  next_run_at timestamptz not null default now(),
  last_run_at timestamptz,
  claimed_at timestamptz,
  consecutive_failures int not null default 0,
  cursor jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The due query runs on every tick, forever, whatever the deployment sets its
-- heartbeat to; it is the only hot query in the engine.
create index if not exists routines_due_idx
  on public.routines (status, next_run_at);

create index if not exists routines_agent_idx
  on public.routines (agent_id);

alter table public.routines enable row level security;

-- Visibility mirrors chat_sessions/ideas: the owner always, plus workspace
-- members once the routine is shared. Only the owner may modify or delete.
drop policy if exists "routines_select_visible" on public.routines;
create policy "routines_select_visible"
  on public.routines for select
  using (
    user_id = auth.uid()
    or (visibility = 'shared' and public.is_workspace_member(workspace_id))
  );

-- The FK on agent_id/delivery_channel_id is checked by the system, which
-- bypasses RLS — so without these guards a caller could point their routine at
-- another workspace's agent or another user's Slack webhook. Subqueries inside
-- a policy DO respect the referenced tables' own RLS, so `agents` resolves only
-- to agents the caller can see and `delivery_channels` only to their own.
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
  );

-- The WITH CHECK here has to carry exactly the same guards as the INSERT policy.
-- `authenticated` holds a table-level UPDATE grant through Supabase's default
-- privileges and the anon key ships in the browser bundle, so PostgREST is
-- reachable directly no matter what the worker's PATCH schema allows. A weaker
-- WITH CHECK would let an owner move their own row into another workspace, or
-- repoint it at another workspace's agent, whose persona and model the
-- service-role executor would then read.
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
  );

drop policy if exists "routines_delete_own" on public.routines;
create policy "routines_delete_own"
  on public.routines for delete
  using (user_id = auth.uid());

-- ---- routine_runs --------------------------------------------------------
-- 'skipped' is user-facing, not telemetry: it answers "why didn't my routine
-- send anything?" with "it looked, there was nothing new".
create table if not exists public.routine_runs (
  id uuid primary key default gen_random_uuid(),
  routine_id uuid not null references public.routines (id) on delete cascade,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null check (status in ('ok', 'skipped', 'failed')),
  items_new int not null default 0,
  tokens int not null default 0,
  duration_ms int,
  error text
);

create index if not exists routine_runs_history_idx
  on public.routine_runs (routine_id, started_at desc);

alter table public.routine_runs enable row level security;

drop policy if exists "routine_runs_select_visible" on public.routine_runs;
create policy "routine_runs_select_visible"
  on public.routine_runs for select
  using (
    exists (
      select 1 from public.routines r
      where r.id = routine_runs.routine_id
        and (
          r.user_id = auth.uid()
          or (r.visibility = 'shared' and public.is_workspace_member(r.workspace_id))
        )
    )
  );

-- Writes come from the scheduled executor only (service role bypasses RLS).

-- ---- routine_deliveries --------------------------------------------------
-- The cursor records how far a routine has read; this records what was
-- actually sent. The unique constraint is what makes a retry a no-op instead
-- of a duplicate message.
create table if not exists public.routine_deliveries (
  routine_id uuid not null references public.routines (id) on delete cascade,
  item_key text not null,
  delivered_at timestamptz not null default now(),
  primary key (routine_id, item_key)
);

alter table public.routine_deliveries enable row level security;
revoke all on public.routine_deliveries from anon, authenticated;
-- No policies: clients have no business reading this. The service role used by
-- the executor bypasses RLS.

-- ---- claim_due_routines --------------------------------------------------
-- Atomically hand out due routines. `for update skip locked` means two
-- overlapping cron ticks can never take the same row. A routine whose
-- claimed_at is older than p_stale_after is treated as abandoned (the worker
-- died mid-run) and becomes claimable again.
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
      and next_run_at <= now()
      and (claimed_at is null or claimed_at < now() - p_stale_after)
    order by next_run_at
    for update skip locked
    limit p_limit
  )
  returning r.*;
$$;

-- The grant IS the security boundary here. Revoking from named roles is not
-- enough: Postgres grants EXECUTE to PUBLIC by default and every role inherits
-- it, so a SECURITY DEFINER function stays callable through PostgREST unless
-- PUBLIC is revoked explicitly.
revoke all on function public.claim_due_routines(int, interval) from public, anon, authenticated;
grant execute on function public.claim_due_routines(int, interval) to service_role;
