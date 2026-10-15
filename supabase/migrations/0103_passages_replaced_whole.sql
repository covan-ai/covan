-- A document's passages are replaced whole, and a trashed bundle stops syncing.
--
-- Every writer of `document_chunks` deleted a document's passages and then
-- inserted the new ones, 200 rows at a time. An insert that failed on its third
-- batch left a third of the document searchable while it read as indexed, and a
-- reindex that failed left it with nothing at all. `generation` lets the new
-- set go in beside the old one first (`worker/src/lib/chunk-store.ts`,
-- `replaceChunks`): only once every row of it is in are the older generations
-- deleted, and a failure deletes what it wrote and leaves the old set alone.
-- Retrieval does not filter on it: for the moment between the insert and the
-- delete both sets are visible, and `buildContextBlock` already drops a passage
-- that repeats one it has admitted.
--
-- Rows written before this are generation 0, which is what the default gives
-- them; the next replacement of each document writes 1.

alter table public.document_chunks
  add column if not exists generation int not null default 0;

comment on column public.document_chunks.generation is
  'Which replacement of the document wrote this passage. A new set is written one generation up and the older ones deleted once it is complete (replaceChunks). 0 for rows written before 0103.';

-- The newest-generation read and both deletes are per document.
create index if not exists document_chunks_document_generation_idx
  on public.document_chunks (document_id, generation);

-- 0094 names every column a client may write. The upload and reindex routes
-- write through the caller's own client, so the new column joins the list.
revoke insert on public.document_chunks from anon, authenticated;
grant insert (document_id, bundle_id, workspace_id, chunk_index, content, context, embedding,
              generation)
  on public.document_chunks to authenticated;

-- A connection whose bundle is in Recently Deleted is not handed out.
--
-- It used to be: the sync imported into the trashed bundle, and since an
-- import clears a hidden row it brought the bundle's documents back one at a
-- time — re-embedding each at the workspace's expense. Restoring the bundle is
-- all it takes to resume, which is why this is a filter and not a pause. The
-- worker checks the same thing for "Sync now", which does not come through here.
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
    select cn.id from public.connections cn
    join public.knowledge_bundles b on b.id = cn.bundle_id
    where cn.status = 'active'
      and cn.next_sync_at <= now()
      and (cn.claimed_at is null or cn.claimed_at < now() - p_stale_after)
      and b.deleted_at is null
    order by cn.next_sync_at
    for update of cn skip locked
    limit p_limit
  )
  returning c.*;
$$;

revoke all on function public.claim_due_connections(int, interval) from public, anon, authenticated;
grant execute on function public.claim_due_connections(int, interval) to service_role;
