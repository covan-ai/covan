-- A document is indexed after its upload, a step at a time, and says how far
-- it has got.
--
-- Indexing used to happen inside the upload request: the file was buffered
-- twice, its text chunked and every passage embedded and inserted before the
-- response went back. That put a ceiling on the file far below what anyone
-- uploads — 10 MB of text was already most of a Worker's 128 MB of memory once
-- its vectors were held — and a request that ran out of anything (memory,
-- subrequests, the browser's patience) left a document half-indexed with
-- nothing anywhere saying so.
--
-- Now the upload stores the file and stops. Indexing is a job on the document
-- row, advanced one unit at a time by whatever clock the deployment has — a
-- Durable Object alarm, a timer on Node, the cron (`worker/src/lib/indexing`).
-- Each unit embeds a few hundred passages under the generation 0103 added, and
-- the older generations go only when the last unit is in.
--
--   index_status   null       a document from before this, indexed or not —
--                              its chunk count says which, as it always has
--                  queued     stored, waiting for its first unit
--                  indexing   part-way; index_cursor says how far
--                  ready      every passage is in
--                  partial    every passage of the text that was kept is in,
--                             and the text was cut at the indexing limit
--                  failed     gave up; index_error says why. Reindex retries.

alter table public.documents
  add column if not exists index_status text,
  add column if not exists index_error text,
  add column if not exists index_cursor int not null default 0,
  add column if not exists index_total int,
  add column if not exists index_generation int,
  add column if not exists index_attempts int not null default 0,
  add column if not exists index_lease_until timestamptz,
  add column if not exists index_next_run_at timestamptz,
  -- The text was cut at the indexing limit (`MAX_INDEX_CHARS`). Known at the
  -- first unit, which is when the text is read; said at the last, as `partial`.
  add column if not exists index_truncated boolean not null default false;

alter table public.documents drop constraint if exists documents_index_status_known;
alter table public.documents add constraint documents_index_status_known
  check (index_status is null
         or index_status in ('queued', 'indexing', 'ready', 'partial', 'failed'));

create index if not exists documents_index_due_idx
  on public.documents (index_next_run_at)
  where index_status in ('queued', 'indexing');

comment on column public.documents.index_status is
  'Where indexing has got: queued, indexing, ready, partial (indexed up to the text limit), failed. Null for documents indexed before 0105.';

-- Clients read these. The upload writes the document through the caller's own
-- client, so `index_status` joins 0085's insert list — that is how a new row
-- arrives already queued — and 0085's guard is extended so `queued` is the
-- only thing a client can say there. Every later write is the job's, through
-- the service role.
revoke insert on public.documents from anon, authenticated;
grant insert (bundle_id, content, created_by, name, r2_key, size, index_status)
  on public.documents to authenticated;

create or replace function public.documents_guard_client_writes()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_from uuid;
  v_to uuid;
begin
  -- Service role, definer functions and foreign-key actions. See 0085.
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.r2_key is not null
       and new.r2_key !~ ('^' || new.bundle_id::text
                          || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
                          || '-[A-Za-z0-9._-]{1,200}$') then
      raise exception 'r2_key must be a new key under the document''s own bundle'
        using errcode = 'check_violation';
    end if;
    -- 0105: a new document is queued for indexing or says nothing. Ready,
    -- partial and failed are the job's to say.
    if new.index_status is not null and new.index_status <> 'queued' then
      raise exception 'a new document can only be queued for indexing'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if new.bundle_id is distinct from old.bundle_id then
    -- Read through the caller's own policies: both bundles are ones the
    -- documents policies already required them to be able to write.
    select workspace_id into v_from from public.knowledge_bundles where id = old.bundle_id;
    select workspace_id into v_to from public.knowledge_bundles where id = new.bundle_id;
    if v_from is null or v_to is null or v_from <> v_to then
      raise exception 'a document cannot move to a bundle in another workspace'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.documents_guard_client_writes() from public;

-- ---- claim_index_job ----------------------------------------------------------
-- One unit of one document's indexing, under a lease so two clocks never run
-- the same unit twice.
create or replace function public.claim_index_job(
  p_document_id uuid,
  p_lease interval default interval '5 minutes'
)
returns setof public.documents
language sql
security definer
set search_path = pg_catalog, public
as $$
  update public.documents d
  set index_lease_until = now() + p_lease
  where d.id = p_document_id
    and d.index_status in ('queued', 'indexing')
    and d.deleted_at is null
    and (d.index_lease_until is null or d.index_lease_until < now())
  returning d.*;
$$;

revoke all on function public.claim_index_job(uuid, interval) from public, anon, authenticated;
grant execute on function public.claim_index_job(uuid, interval) to service_role;

-- ---- claim_due_index_jobs -----------------------------------------------------
-- The cron's fallback, for indexing nobody is driving. The status filter sits
-- inside the `for update skip locked` sub-select for 0055's reason.
create or replace function public.claim_due_index_jobs(
  p_limit int default 2,
  p_lease interval default interval '5 minutes'
)
returns setof public.documents
language sql
security definer
set search_path = pg_catalog, public
as $$
  update public.documents d
  set index_lease_until = now() + p_lease
  where d.id in (
    select id from public.documents
    where index_status in ('queued', 'indexing')
      and deleted_at is null
      and coalesce(index_next_run_at, '-infinity') <= now()
      and (index_lease_until is null or index_lease_until < now())
    order by index_next_run_at nulls first
    for update skip locked
    limit p_limit
  )
  returning d.*;
$$;

revoke all on function public.claim_due_index_jobs(int, interval) from public, anon, authenticated;
grant execute on function public.claim_due_index_jobs(int, interval) to service_role;

-- ---- queue_document_index ------------------------------------------------------
-- Reindex: put a document back in the queue from the start. A client cannot
-- write the index columns, so this is the one door, and it checks what the
-- documents policies would: the document is live and the caller can write in
-- its workspace. A unit running right now (its lease held) is left alone —
-- the document is already being indexed, and resetting the cursor under it
-- would have the unit write its progress over the reset. Between units it is
-- reset, and the next claim starts again at a higher generation.
create or replace function public.queue_document_index(p_document_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_workspace_id uuid;
begin
  select b.workspace_id into v_workspace_id
  from public.documents d
  join public.knowledge_bundles b on b.id = d.bundle_id
  where d.id = p_document_id and d.deleted_at is null;

  if v_workspace_id is null then
    raise exception 'no such document' using errcode = 'P0002';
  end if;
  if not public.can_write_in_workspace(v_workspace_id) then
    raise exception 'you cannot reindex documents in this workspace' using errcode = '42501';
  end if;

  update public.documents
     set index_status = 'queued',
         index_cursor = 0,
         index_total = null,
         index_attempts = 0,
         index_error = null,
         index_truncated = false,
         index_next_run_at = now()
   where id = p_document_id
     and (index_lease_until is null or index_lease_until < now());
end $$;

revoke all on function public.queue_document_index(uuid) from public, anon;
grant execute on function public.queue_document_index(uuid) to authenticated, service_role;
