-- =========================================================================
-- An export you come back for
--
-- Settings › Export and deletion (A27): "Everything as a zip … Ready within
-- an hour; the link is emailed to you and works for 7 days." The download
-- that streams while you wait (`GET /workspaces/:id/export`) stays; this is
-- the one that is prepared in the background, for a workspace too large to
-- wait on, and kept for a week.
--
--   * An admin asks. The row is theirs: `requested_by = auth.uid()`, and one
--     export per workspace is prepared at a time.
--   * The engine prepares it as the person who asked — a short token for
--     them, scoped to this workspace — so the archive holds exactly what they
--     could see, their own private threads and nobody else's. Which is also
--     why only they may download it: every admin sees that an export was
--     made, and by whom, and only its requester gets the file.
--   * Seven days after it is ready the file is deleted and the row says
--     `expired`, which is the board's "Expired".
--   * A preparation that dies is taken again after half an hour, three times,
--     and then the row says `failed`.
-- =========================================================================

create table if not exists public.workspace_exports (
  id           uuid        primary key default gen_random_uuid(),
  workspace_id uuid        not null references public.workspaces (id) on delete cascade,
  requested_by uuid        references auth.users (id) on delete set null,
  status       text        not null default 'queued',
  object_key   text,
  size_bytes   bigint,
  error        text,
  attempts     integer     not null default 0,
  claimed_at   timestamptz,
  created_at   timestamptz not null default now(),
  finished_at  timestamptz,
  expires_at   timestamptz
);

alter table public.workspace_exports drop constraint if exists workspace_exports_status_known;
alter table public.workspace_exports add constraint workspace_exports_status_known
  check (status in ('queued', 'running', 'ready', 'failed', 'expired'));

create index if not exists workspace_exports_workspace_idx
  on public.workspace_exports (workspace_id, created_at desc);

-- One at a time per workspace: a second press while the first is being
-- prepared is the first one.
create unique index if not exists workspace_exports_one_at_a_time
  on public.workspace_exports (workspace_id)
  where status in ('queued', 'running');

alter table public.workspace_exports enable row level security;

drop policy if exists "workspace_exports_select_admin" on public.workspace_exports;
create policy "workspace_exports_select_admin"
  on public.workspace_exports for select
  using (public.is_workspace_admin(workspace_id));

drop policy if exists "workspace_exports_insert_admin" on public.workspace_exports;
create policy "workspace_exports_insert_admin"
  on public.workspace_exports for insert
  with check (public.is_workspace_admin(workspace_id) and requested_by = auth.uid());

drop policy if exists workspace_exports_request_workspace on public.workspace_exports;
create policy workspace_exports_request_workspace on public.workspace_exports
  as restrictive for all to authenticated
  using ((select public.request_workspace()) is null
         or workspace_id = (select public.request_workspace()))
  with check ((select public.request_workspace()) is null
              or workspace_id = (select public.request_workspace()));

revoke all on public.workspace_exports from anon, authenticated;
-- Not `object_key`: where the file is stored is the engine's business, and
-- the download route reads it as the requester.
grant select (id, workspace_id, requested_by, status, size_bytes, error, created_at,
              finished_at, expires_at)
  on public.workspace_exports to authenticated;
grant insert (workspace_id, requested_by) on public.workspace_exports to authenticated;
grant select, insert, update, delete on public.workspace_exports to service_role;

-- The engine's next export: the oldest waiting, or one whose preparation
-- died half an hour ago and has tries left. Gives up on the rest.
create or replace function public.claim_due_workspace_exports(p_limit integer)
returns table (id uuid, workspace_id uuid, requested_by uuid, attempts integer)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.workspace_exports x
     set status = 'failed',
         error = 'the export could not be prepared',
         finished_at = now(),
         claimed_at = null
   where x.status = 'running'
     and x.claimed_at < now() - interval '30 minutes'
     and x.attempts >= 3;

  return query
  with due as (
    select x.id
      from public.workspace_exports x
     where x.status = 'queued'
        or (x.status = 'running' and x.claimed_at < now() - interval '30 minutes')
     order by x.created_at
     limit greatest(least(coalesce(p_limit, 1), 5), 1)
     for update skip locked
  )
  update public.workspace_exports x
     set status = 'running', claimed_at = now(), attempts = x.attempts + 1
    from due
   where x.id = due.id
  returning x.id, x.workspace_id, x.requested_by, x.attempts;
end $$;

revoke all on function public.claim_due_workspace_exports(integer) from public, anon, authenticated;
grant execute on function public.claim_due_workspace_exports(integer) to service_role;
