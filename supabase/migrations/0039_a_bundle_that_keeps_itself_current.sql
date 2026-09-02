-- =========================================================================
-- A bundle that keeps itself current
--
-- Every document in Covan arrived because somebody dragged it into a bundle.
-- That is a good default and a bad ceiling: the contract, the handbook and the
-- pricing sheet all live somewhere else and change without anybody thinking to
-- re-upload them, so a bundle is accurate on the day it is filled and quietly
-- wrong a month later. `stale-documents.ts` already exists to warn about that,
-- which is the interface admitting the problem rather than fixing it.
--
-- A connection is the fix: a place the documents come from, re-read on a
-- schedule. It is deliberately NOT a search connector — nothing here queries
-- Notion or Drive at question time. The external document is copied into a
-- bundle, chunked and embedded like any other, and everything downstream —
-- retrieval, citations, export, RLS — carries on working without knowing where
-- the file came from. That is the whole design: one substrate, not a second
-- retrieval path with its own permissions to get wrong.
--
-- The shape is `routines` (0012) almost exactly, and on purpose. Both are
-- background work owned by a person, claimed by a worker, and paused when it
-- fails often enough to be broken rather than unlucky — so the same claim
-- function, the same stale-claim recovery, and the same run log. What differs
-- is only what the work does.
-- =========================================================================

-- ---- connections ---------------------------------------------------------
-- One row per connected external account-and-scope pair: a Notion workspace,
-- a Drive folder. `secret_ciphertext` holds the OAuth token envelope, encrypted
-- by the worker (AES-GCM) under ROUTINE_SECRET_KEY before it is ever written —
-- the same envelope format and the same key as `delivery_channels`, because
-- an operator managing two secrets rotates one of them.
create table if not exists public.connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  -- Where synced documents land. A connection feeds exactly one bundle, so
  -- "which agents can see my Drive folder" is answered by the bundle
  -- attachments that already exist rather than by a second sharing model.
  bundle_id uuid not null references public.knowledge_bundles (id) on delete cascade,
  -- The owner: whose OAuth grant this is and whose allowance the embeddings
  -- are charged to. Same standing as routines.user_id.
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider in ('notion', 'google_drive')),
  -- What the person sees: "Covan HQ" (Notion workspace), "Handbook" (Drive
  -- folder). Written at connect time from the provider's own answer, never
  -- from the client.
  account_label text not null,
  secret_ciphertext text not null,
  -- Provider-specific scope. Drive: {"folderId","folderName"}. Notion: {} —
  -- Notion's own picker decides what the integration can see, so there is
  -- nothing left for us to scope.
  config jsonb not null default '{}'::jsonb,
  status text not null default 'active' check (status in ('active', 'paused')),
  -- Why the engine paused this itself. Null when a person paused it.
  paused_reason text,
  -- There is deliberately no cursor column here, and `routines` having one is
  -- what makes its absence worth writing down. A routine reads a feed and has
  -- to remember where it stopped, because nothing else can tell it. A
  -- connection reconciles: it lists what the source holds now and compares each
  -- file's version against `documents.external_version`. The bookmark is
  -- therefore already stored, once per document, by the rows the sync is about.
  --
  -- Which also buys the thing a cursor cannot. A cursor answers "what changed";
  -- a listing answers "what is there" — so a document deleted at the source is
  -- noticed, where a cursor-driven sync would keep serving it forever.
  -- Minutes between syncs. A number rather than a cron expression: a routine
  -- fires at 9am because a person wants to read it at 9am, and a sync has no
  -- such hour — it only has a staleness the owner is willing to tolerate.
  -- Bounded below so nobody can point a 1-minute sync at Google's rate limits.
  sync_interval_minutes int not null default 360
    check (sync_interval_minutes between 15 and 10080),
  next_sync_at timestamptz not null default now(),
  last_sync_at timestamptz,
  claimed_at timestamptz,
  consecutive_failures int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The due query, run on every tick forever. Same index shape as routines_due_idx.
create index if not exists connections_due_idx
  on public.connections (status, next_sync_at);

create index if not exists connections_bundle_idx
  on public.connections (bundle_id);

alter table public.connections enable row level security;

-- Visibility is the workspace's, not the owner's — and this is the one place
-- the shape deliberately departs from `routines`.
--
-- A routine is a standing order somebody wrote for themselves, so private is
-- the right default. A connection is the reason a shared bundle says what it
-- says. A member who cannot see that the Handbook bundle is fed by a Drive
-- folder cannot explain why a document they deleted came back, and would have
-- to ask the person who set it up — who may have left.
drop policy if exists "connections_select_member" on public.connections;
create policy "connections_select_member"
  on public.connections for select
  using (public.is_workspace_member(workspace_id));

-- The FK on bundle_id is checked by the system, which bypasses RLS — so
-- without the subquery below a caller could point a connection at a bundle in
-- a workspace they are not in, and the service-role engine would then write
-- documents into it. The subquery respects `knowledge_bundles`' own policies,
-- so it resolves only to bundles the caller can already see.
--
-- INSERT is not granted to `authenticated` at all (see the grants below), so
-- this policy is the second lock rather than the first. It is written out in
-- full anyway: a grant is one line away from being restored by somebody
-- solving a different problem, and a policy that was never written is not
-- there to catch that.
drop policy if exists "connections_insert_writer" on public.connections;
create policy "connections_insert_writer"
  on public.connections for insert
  with check (
    user_id = auth.uid()
    and public.can_write_in_workspace(workspace_id)
    and exists (
      select 1 from public.knowledge_bundles b
      where b.id = connections.bundle_id and b.workspace_id = connections.workspace_id
    )
  );

-- Pausing and re-scheduling belong to the owner and to an admin. An admin is
-- included because a connection outlives the person who made it: somebody
-- leaves, their Notion grant stops working, and the workspace needs a way to
-- turn it off that is not "ask the ex-employee to log in".
--
-- The WITH CHECK repeats every guard from the INSERT policy. `authenticated`
-- holds a table-level UPDATE grant through Supabase's default privileges and
-- the anon key ships in the browser bundle, so PostgREST is reachable directly
-- whatever the worker's PATCH schema allows. A weaker WITH CHECK would let a
-- row be moved into another workspace, or repointed at another workspace's
-- bundle — which the engine would then fill with this account's documents.
drop policy if exists "connections_update_owner_or_admin" on public.connections;
create policy "connections_update_owner_or_admin"
  on public.connections for update
  using (user_id = auth.uid() or public.is_workspace_admin(workspace_id))
  with check (
    (user_id = auth.uid() or public.is_workspace_admin(workspace_id))
    and public.can_write_in_workspace(workspace_id)
    and exists (
      select 1 from public.knowledge_bundles b
      where b.id = connections.bundle_id and b.workspace_id = connections.workspace_id
    )
  );

drop policy if exists "connections_delete_owner_or_admin" on public.connections;
create policy "connections_delete_owner_or_admin"
  on public.connections for delete
  using (user_id = auth.uid() or public.is_workspace_admin(workspace_id));

-- RLS is row-level and cannot hide a column; column-level grants can. Strip the
-- blanket grant Supabase gives `authenticated`, then hand back everything
-- except secret_ciphertext — so an OAuth refresh token is not one crafted
-- PostgREST select away, even for the member who owns it. Identical reasoning
-- to `delivery_channels` in 0012.
--
-- INSERT is deliberately not granted: creation goes through the worker, which
-- has to complete the OAuth exchange and encrypt the result anyway. UPDATE is
-- granted on the three columns a person legitimately changes from the
-- interface; the cursor, the token and the schedule bookkeeping belong to the
-- engine.
revoke all on public.connections from anon, authenticated;
grant select (
  id, workspace_id, bundle_id, user_id, provider, account_label, config,
  status, paused_reason, sync_interval_minutes, next_sync_at, last_sync_at,
  consecutive_failures, created_at, updated_at
) on public.connections to authenticated;
grant update (status, paused_reason, sync_interval_minutes) on public.connections to authenticated;
grant delete on public.connections to authenticated;

-- ---- documents: where this one came from ---------------------------------
--
-- The provenance a synced document needs, and nothing more. A document with a
-- null `connection_id` is a manual upload and behaves exactly as it did
-- before — every column here is nullable for that reason, and no existing row
-- changes meaning.
alter table public.documents
  -- `set null` rather than `cascade`, and it is a product decision rather than
  -- a schema one: disconnecting Drive must not delete the team's knowledge. The
  -- documents stay, become ordinary uploads, and stop being refreshed. The API
  -- offers deleting them as a separate, explicit choice.
  add column if not exists connection_id uuid references public.connections (id) on delete set null,
  -- The provider's id for the file. Kept even after the connection is gone,
  -- which is what lets a reconnect adopt the documents it already imported
  -- instead of importing a second copy of everything.
  add column if not exists external_id text,
  -- Whatever the provider calls "this version": Drive's `modifiedTime`,
  -- Notion's `last_edited_time`. Compared as an opaque string — the engine
  -- asks "different from last time?", never "newer than".
  add column if not exists external_version text,
  -- A link back to the original, so a citation can open the real document
  -- rather than our copy of it.
  add column if not exists external_url text,
  add column if not exists synced_at timestamptz;

comment on column public.documents.connection_id is
  'The connection that imported this document, or null for a manual upload. '
  'Nulled rather than cascaded when a connection is removed: disconnecting a '
  'source must not delete what the team has already learned from it.';

-- The lookup the sync engine does once per remote file per run, and the
-- constraint that makes an interrupted run safe to repeat: a second import of
-- the same remote file updates the row it made last time instead of adding a
-- duplicate. Partial, because manual uploads have no external id and there are
-- many of them.
create unique index if not exists documents_connection_external_idx
  on public.documents (connection_id, external_id)
  where connection_id is not null;

-- Adoption on reconnect reads by bundle, not by connection — the connection it
-- is looking for is the one that no longer exists.
create index if not exists documents_external_id_idx
  on public.documents (bundle_id, external_id)
  where external_id is not null;

-- ---- connection_runs -----------------------------------------------------
-- What happened, in the words the person who set it up would use. 'skipped'
-- means "looked, nothing had changed" and is not a failure — the same
-- distinction routine_runs draws, and for the same reason: without it, a
-- healthy connection that syncs an unchanged folder looks like a broken one.
create table if not exists public.connection_runs (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.connections (id) on delete cascade,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null check (status in ('ok', 'skipped', 'failed')),
  documents_added int not null default 0,
  documents_updated int not null default 0,
  documents_removed int not null default 0,
  tokens int not null default 0,
  duration_ms int,
  error text
);

create index if not exists connection_runs_history_idx
  on public.connection_runs (connection_id, started_at desc);

alter table public.connection_runs enable row level security;

-- A run is as visible as its connection, which is workspace-wide. Nothing
-- writes here but the service role.
drop policy if exists "connection_runs_select_member" on public.connection_runs;
create policy "connection_runs_select_member"
  on public.connection_runs for select
  using (
    exists (
      select 1 from public.connections c
      where c.id = connection_runs.connection_id
        and public.is_workspace_member(c.workspace_id)
    )
  );

revoke all on public.connection_runs from anon, authenticated;
grant select on public.connection_runs to authenticated;

-- ---- claim_due_connections -----------------------------------------------
-- Atomically hand out due connections. `for update skip locked` means two
-- overlapping ticks can never take the same row, and a claim older than
-- p_stale_after is treated as abandoned — the worker died mid-sync — and
-- becomes claimable again. Character for character the same mechanism as
-- claim_due_routines, because the failure it defends against is the same one.
create or replace function public.claim_due_connections(
  p_limit int default 5,
  p_stale_after interval default interval '30 minutes'
)
returns setof public.connections
language sql
security definer
set search_path = pg_catalog, public
as $$
  update public.connections c
  set claimed_at = now()
  where c.id in (
    select id from public.connections
    where status = 'active'
      and next_sync_at <= now()
      and (claimed_at is null or claimed_at < now() - p_stale_after)
    order by next_sync_at
    for update skip locked
    limit p_limit
  )
  returning c.*;
$$;

-- The grant IS the security boundary. Revoking from named roles is not enough:
-- Postgres grants EXECUTE to PUBLIC by default and every role inherits it, so a
-- SECURITY DEFINER function returning rows with an encrypted OAuth token in
-- them stays callable through PostgREST unless PUBLIC is revoked explicitly.
revoke all on function public.claim_due_connections(int, interval) from public, anon, authenticated;
grant execute on function public.claim_due_connections(int, interval) to service_role;
