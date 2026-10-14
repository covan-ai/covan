-- A passage stays with its document: a row in `document_chunks` names a
-- document and a bundle in the workspace it says it is in.
--
-- A chunk carries three references -- its document, its bundle, its workspace
-- -- and the policies only ever asked about the third (`can_write_in_workspace
-- (workspace_id)`). So a member of one workspace could write a chunk filed
-- under their own workspace that named another workspace's document or
-- bundle. Nothing reads across that today: retrieval goes by bundle, and the
-- select policy by workspace. But a passage whose document id points into
-- somebody else's workspace is a citation waiting to name a file the reader
-- has no right to know exists, and the next read path written against it would
-- not know to check.
--
-- A trigger holds the three together for every writer. The bundle has to be
-- in the chunk's workspace and so does the document's bundle -- the same
-- workspace, not the same bundle, because moving a document moves its chunks
-- first and the document a statement later (`routes/documents.ts`).
--
-- Not `security definer`: a client's lookups go through its own policies,
-- which show it exactly the bundles and documents of its own workspaces, and a
-- reference it cannot see is one it may not make.
--
-- Chunks that already break the rule are deleted, with a notice. A chunk is
-- derived data: reindexing the document rebuilds it in the right place.

do $$
declare
  v_count bigint;
begin
  with stray as (
    select c.id
      from public.document_chunks c
      left join public.knowledge_bundles cb on cb.id = c.bundle_id
      left join public.documents d on d.id = c.document_id
      left join public.knowledge_bundles db on db.id = d.bundle_id
     where cb.workspace_id is distinct from c.workspace_id
        or db.workspace_id is distinct from c.workspace_id
  ), gone as (
    delete from public.document_chunks c using stray where c.id = stray.id returning 1
  )
  select count(*) into v_count from gone;
  if v_count > 0 then
    raise notice 'document_chunks: % chunk(s) deleted that named another workspace''s document or bundle', v_count;
  end if;
end $$;

create or replace function public.document_chunks_stay_in_their_workspace()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if not exists (
       select 1 from public.knowledge_bundles b
        where b.id = new.bundle_id and b.workspace_id = new.workspace_id)
     or not exists (
       select 1 from public.documents d
         join public.knowledge_bundles b on b.id = d.bundle_id
        where d.id = new.document_id and b.workspace_id = new.workspace_id)
  then
    raise exception 'a passage belongs to a document and a bundle in its own workspace'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function public.document_chunks_stay_in_their_workspace() from public;

drop trigger if exists trg_document_chunks_stay_in_their_workspace on public.document_chunks;
create trigger trg_document_chunks_stay_in_their_workspace
  before insert or update of document_id, bundle_id, workspace_id on public.document_chunks
  for each row execute function public.document_chunks_stay_in_their_workspace();
