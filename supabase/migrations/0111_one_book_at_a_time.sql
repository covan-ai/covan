-- =========================================================================
-- One book at a time
--
-- 0105 made indexing a job on the document row, a unit at a time, and said
-- nothing about how many documents could be indexed at once. Every upload
-- kicks its own clock, so a workspace that uploads five long books gets five
-- jobs inserting passages into `document_chunks` side by side. Each passage
-- carries an embedding, and each embedding is a write into the table's vector
-- index, which is the expensive part of an insert. Five of those streams
-- together kept the database busy enough that their own inserts ran past the
-- statement timeout, every retry put the same load straight back, the books
-- failed after their last attempt, and everything else the database was
-- answering in the meantime — chat, pages, routines — waited behind them.
--
-- Now a workspace indexes one document at a time. The rest stay `queued`,
-- their clocks look again every so often (`lib/indexing/job.ts`), and the next
-- one starts once the running one is `ready`, `partial` or `failed`. The
-- smaller half of the same fix is in the worker: passages go into the table
-- in smaller inserts (`CHUNK_INSERT_BATCH`), so a single statement is far from
-- the timeout even when the database is busy.
--
-- WHO WAITS FOR WHOM — `index_job_waits`.
--
--   A document waits when another live document in its workspace
--
--     * holds a lease right now — a unit of it is running, or it is being
--       started; or
--     * is `indexing` — part-way, between units or backing off after a failed
--       one — and this one is still `queued`, or that one is older.
--
--   The second clause has an order in it because two documents can both be
--   `indexing` — any that were when this migration ran, or one that started
--   while the other held its lease for a moment. Without an order each would
--   wait for the other for ever; with it the older carries on, the younger
--   waits, and a lease runs out on its own after five minutes, so nothing can
--   wait for good.
--
--   Per workspace, not per deployment: a workspace's own uploads should not
--   overload the database, and one workspace's library should not hold up
--   every other workspace's first upload either. The workspace is the
--   bundle's, which is already where the job finds who pays for it.
--
-- WHY A LOCK. Two `queued` documents claimed in the same moment would each
-- see no other document leased or `indexing`, and both would start — the
-- exact thing this is for. `claim_index_job` therefore takes a transaction
-- advisory lock on the workspace before it looks. The second claim waits a
-- few milliseconds for the first to commit, and then sees its lease. The lock
-- is held only for the claim itself, never for a unit.
--
-- WHAT THIS DELIBERATELY DOES NOT DO.
--
--   * It does not queue in upload order. Whichever waiting document looks
--     next after the running one finishes goes next. Strict order would make
--     a document that is backing off after a failed start hold up everything
--     uploaded after it, which is a worse trade than an order nobody sees.
--
--   * It does not change who may call these functions. Both stay the service
--     role's, as 0105 left them, and `index_job_waits` is nobody else's either.
-- =========================================================================

create or replace function public.index_job_waits(p_doc public.documents, p_workspace_id uuid)
returns boolean
language sql
stable
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.documents o
    join public.knowledge_bundles ob on ob.id = o.bundle_id
    where ob.workspace_id = p_workspace_id
      and o.id <> p_doc.id
      and o.deleted_at is null
      and o.index_status in ('queued', 'indexing')
      and (
        o.index_lease_until > now()
        or (
          o.index_status = 'indexing'
          and (p_doc.index_status = 'queued'
               or (o.created_at, o.id) < (p_doc.created_at, p_doc.id))
        )
      )
  );
$$;

revoke all on function public.index_job_waits(public.documents, uuid)
  from public, anon, authenticated;
grant execute on function public.index_job_waits(public.documents, uuid) to service_role;

-- ---- claim_index_job ----------------------------------------------------------
-- 0105's, plus the wait. Still one unit of one document, under a lease.
create or replace function public.claim_index_job(
  p_document_id uuid,
  p_lease interval default interval '5 minutes'
)
returns setof public.documents
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
  where d.id = p_document_id;

  -- A document whose bundle is gone is claimed as before: the job fails it
  -- with the reason, which is better than it waiting for nothing.
  if v_workspace_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('index:' || v_workspace_id::text, 0));
  end if;

  return query
  update public.documents d
  set index_lease_until = now() + p_lease
  where d.id = p_document_id
    and d.index_status in ('queued', 'indexing')
    and d.deleted_at is null
    and (d.index_lease_until is null or d.index_lease_until < now())
    and (v_workspace_id is null or not public.index_job_waits(d, v_workspace_id))
  returning d.*;
end $$;

revoke all on function public.claim_index_job(uuid, interval) from public, anon, authenticated;
grant execute on function public.claim_index_job(uuid, interval) to service_role;

-- ---- claim_due_index_jobs -----------------------------------------------------
-- The cron's fallback, which now skips a document that is waiting its turn. It
-- can still pick two waiting documents of one workspace in the same tick; the
-- job's own claim (above) is the one that decides, and lets only one of them
-- through.
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
    select x.id from public.documents x
    join public.knowledge_bundles xb on xb.id = x.bundle_id
    where x.index_status in ('queued', 'indexing')
      and x.deleted_at is null
      and coalesce(x.index_next_run_at, '-infinity') <= now()
      and (x.index_lease_until is null or x.index_lease_until < now())
      and not public.index_job_waits(x, xb.workspace_id)
    order by x.index_next_run_at nulls first
    for update of x skip locked
    limit p_limit
  )
  returning d.*;
$$;

revoke all on function public.claim_due_index_jobs(int, interval) from public, anon, authenticated;
grant execute on function public.claim_due_index_jobs(int, interval) to service_role;
