-- =========================================================================
-- Passages counted once
--
-- `dc_select_member` (0106) asked three questions of every passage it was
-- shown: is the reader in the passage's workspace, can they see its bundle,
-- and is its document still there. Each answer was a function call or a
-- correlated subquery, so the cost of reading passages grew with the number
-- of passages, not the number of documents. The agents list embeds
-- `document_chunks(count)` for every document of every agent's bundles, and a
-- workspace with 55 documents and 7,300 passages took 4.3 s to list its
-- agents as a member — past PostgREST's statement timeout once a few agents
-- shared the same bundles. The sidebar answered 500.
--
-- The rule is unchanged. The passage is visible when its (bundle, workspace)
-- is a bundle the reader can see, and its document is a document the reader
-- can see. What changes is when the questions are asked: once per statement,
-- over the reader's bundles and documents, and each passage is then a lookup
-- in two hashed sets. The same listing takes about 0.1 s.
--
--   visible_bundles()    exactly bundle_is_visible()'s predicate, as a set.
--   visible_documents()  exactly documents_select_member's predicate, as a
--                        set: not deleted, in a visible bundle.
--
-- Both are SECURITY DEFINER for the same reason bundle_is_visible() is: a
-- set-returning helper that ran under the caller's RLS would ask the
-- per-row questions again. Neither returns anything bundle_is_visible() and
-- documents_select_member would not have shown the caller.
--
-- The restrictive key-scope policy on document_chunks (0087) is untouched and
-- still applies.
-- =========================================================================

create or replace function public.visible_bundles()
returns table (id uuid, workspace_id uuid)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select b.id, b.workspace_id
  from public.knowledge_bundles b
  where public.is_workspace_member(b.workspace_id)
    and (b.scope = 'workspace' or b.created_by = auth.uid());
$$;

create or replace function public.visible_documents()
returns setof uuid
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select d.id
  from public.documents d
  join public.visible_bundles() v on v.id = d.bundle_id
  where d.deleted_at is null;
$$;

revoke all on function public.visible_bundles() from public, anon;
grant execute on function public.visible_bundles() to authenticated, service_role;
revoke all on function public.visible_documents() from public, anon;
grant execute on function public.visible_documents() to authenticated, service_role;

drop policy if exists "dc_select_member" on public.document_chunks;
create policy "dc_select_member"
  on public.document_chunks for select
  using (
    (document_chunks.bundle_id, document_chunks.workspace_id)
      in (select v.id, v.workspace_id from public.visible_bundles() v)
    and document_chunks.document_id in (select public.visible_documents())
  );
