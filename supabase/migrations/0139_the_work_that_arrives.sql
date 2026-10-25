-- =========================================================================
-- The work that arrives
--
-- A person who connects their mailbox or calendar is shown the last thirty
-- days of what came in, sorted into ten kinds that are the same for everyone
-- (a question to you, a request, a meeting, an invoice...), with one routine
-- proposed for each kind worth one. A scan is what produces that picture.
--
--   arrival_scans    one row per scan: who asked, which connections it read,
--                    where it is (queued, running, done, failed), and the two
--                    headline numbers.
--   arrival_buckets  one row per kind that had anything in it: how many, how
--                    many of them never got a reply, a label the model wrote
--                    for this person's version of the kind, at most three
--                    subjects as examples, and the routine made from it.
--
-- NOTHING ELSE FROM THE MAILBOX IS KEPT. No sender addresses, no snippets, no
-- bodies, no thread ids: the scan reads them in memory and writes counts. The
-- example subjects are the only free text, and they go with the buckets,
-- which the tick deletes after 90 days. The scan row stays, for the funnel.
--
-- ONE PERSON'S. A scan counts somebody's own mail, so it is theirs the way a
-- personal connection is (0098): a teammate does not read it, and neither
-- does an admin. Deleting the connection a scan read from leaves the scan
-- (the counts say nothing the person had not already seen); deleting the
-- workspace or the account takes it.
--
-- WHO WRITES WHAT. The person queues a scan through their own client, and the
-- insert policy holds it to `queued`, so a client cannot write a finished one.
-- Everything after that — claiming it, the counts, the buckets, the failure —
-- is the engine's, with the service role, as `routine_runs` are. The one thing
-- the person writes afterwards is which routine they made from a bucket, and
-- only a routine of their own in the same workspace.
--
-- NO KEY. Every other workspace table holds a key's token to the key's
-- workspace (0087). These two refuse a key's token outright: a scan is
-- something a person looks at in the product, and an API that hands out how
-- many unanswered questions somebody has is not one this needs. The function
-- in 0090 refuses a key the same way; this is the first policy that does.
--
-- WHAT A SCAN COSTS. Measured once against a real mailbox, see Task 5 of the
-- plan: (not yet measured).
-- =========================================================================

create table if not exists public.arrival_scans (
  id           uuid        primary key default gen_random_uuid(),
  workspace_id uuid        not null references public.workspaces (id) on delete cascade,
  user_id      uuid        not null references auth.users (id) on delete cascade,
  status       text        not null default 'queued',
  taxonomy     integer     not null,
  -- [{ "connection_id": uuid, "toolkit": "gmail" | "outlook" | "googlecalendar" }]
  sources      jsonb       not null,
  window_days  integer     not null default 30,
  total        integer,
  unanswered   integer,
  error        text,
  attempts     integer     not null default 0,
  lease_until  timestamptz,
  started_at   timestamptz,
  finished_at  timestamptz,
  created_at   timestamptz not null default now()
);

alter table public.arrival_scans drop constraint if exists arrival_scans_status_known;
alter table public.arrival_scans add constraint arrival_scans_status_known
  check (status in ('queued', 'running', 'done', 'failed'));

alter table public.arrival_scans drop constraint if exists arrival_scans_window;
alter table public.arrival_scans add constraint arrival_scans_window
  check (window_days between 1 and 90);

-- The newest scan of one person in one workspace is what every read asks for.
create index if not exists arrival_scans_owner_idx
  on public.arrival_scans (workspace_id, user_id, created_at desc);

-- The sweep looks for leases that ran out.
create index if not exists arrival_scans_running_idx
  on public.arrival_scans (lease_until) where status = 'running';

create table if not exists public.arrival_buckets (
  scan_id     uuid    not null references public.arrival_scans (id) on delete cascade,
  kind        text    not null,
  label       text    not null,
  count       integer not null,
  unanswered  integer not null,
  examples    text[]  not null default '{}',
  template_id text,
  routine_id  uuid    references public.routines (id) on delete set null,
  primary key (scan_id, kind)
);

alter table public.arrival_buckets drop constraint if exists arrival_buckets_kind_known;
alter table public.arrival_buckets add constraint arrival_buckets_kind_known
  check (kind in ('question', 'request', 'scheduling', 'update', 'admin',
                  'people', 'pitch', 'automated', 'internal', 'other'));

alter table public.arrival_buckets drop constraint if exists arrival_buckets_examples_few;
alter table public.arrival_buckets add constraint arrival_buckets_examples_few
  check (coalesce(array_length(examples, 1), 0) <= 3);

comment on table public.arrival_scans is
  'One scan of what arrived in a person''s own mailbox and calendar (0139). Read by that person only, no admin read; queued by them, written by the engine.';
comment on table public.arrival_buckets is
  'Counts per kind for one arrival scan (0139): a label, at most three subjects, the routine made from it. Nothing else from the mailbox is kept. Deleted after 90 days.';

alter table public.arrival_scans enable row level security;
alter table public.arrival_buckets enable row level security;

-- ===========================================================================
-- policies
-- ===========================================================================

drop policy if exists "arrival_scans_read_own" on public.arrival_scans;
create policy "arrival_scans_read_own"
  on public.arrival_scans for select
  to authenticated
  using (user_id = auth.uid() and public.is_workspace_member(workspace_id));

drop policy if exists "arrival_scans_queue_own" on public.arrival_scans;
create policy "arrival_scans_queue_own"
  on public.arrival_scans for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and public.is_workspace_member(workspace_id)
    and status = 'queued'
  );

drop policy if exists "arrival_buckets_read_own" on public.arrival_buckets;
create policy "arrival_buckets_read_own"
  on public.arrival_buckets for select
  to authenticated
  using (
    exists (
      select 1 from public.arrival_scans s
       where s.id = arrival_buckets.scan_id
         and s.user_id = auth.uid()
         and public.is_workspace_member(s.workspace_id)
    )
  );

-- The grant below lets `routine_id` and nothing else be named; this says
-- whose bucket, and that the routine is the owner's own in the same
-- workspace (or null, to forget it).
drop policy if exists "arrival_buckets_set_routine" on public.arrival_buckets;
create policy "arrival_buckets_set_routine"
  on public.arrival_buckets for update
  to authenticated
  using (
    exists (
      select 1 from public.arrival_scans s
       where s.id = arrival_buckets.scan_id
         and s.user_id = auth.uid()
         and public.is_workspace_member(s.workspace_id)
    )
  )
  with check (
    exists (
      select 1 from public.arrival_scans s
       where s.id = arrival_buckets.scan_id
         and s.user_id = auth.uid()
         and public.is_workspace_member(s.workspace_id)
         and (
           arrival_buckets.routine_id is null
           or exists (
             select 1 from public.routines r
              where r.id = arrival_buckets.routine_id
                and r.user_id = auth.uid()
                and r.workspace_id = s.workspace_id
           )
         )
    )
  );

-- A key's token reaches neither table, in any workspace; see the header.
drop policy if exists arrival_scans_request_workspace on public.arrival_scans;
create policy arrival_scans_request_workspace on public.arrival_scans
  as restrictive for all to authenticated
  using ((select public.request_workspace()) is null)
  with check ((select public.request_workspace()) is null);

drop policy if exists arrival_buckets_request_workspace on public.arrival_buckets;
create policy arrival_buckets_request_workspace on public.arrival_buckets
  as restrictive for all to authenticated
  using ((select public.request_workspace()) is null)
  with check ((select public.request_workspace()) is null);

-- ===========================================================================
-- grants
-- ===========================================================================

-- Named for all three roles, as 0138 does: a new table's default privileges
-- hand `service_role` truncate and trigger too (0076).
revoke all on public.arrival_scans from anon, authenticated, service_role;
revoke all on public.arrival_buckets from anon, authenticated, service_role;

grant select on public.arrival_scans to authenticated;
grant insert (workspace_id, user_id, sources, taxonomy, window_days)
  on public.arrival_scans to authenticated;
grant select on public.arrival_buckets to authenticated;
grant update (routine_id) on public.arrival_buckets to authenticated;

grant select, insert, update, delete on public.arrival_scans to service_role;
grant select, insert, update, delete on public.arrival_buckets to service_role;
