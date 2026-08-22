-- 0024_a_document_can_change_bundles.sql
--
-- A file dropped into a conversation lands in the agent's chat bundle, because
-- at the moment of dropping it nobody knows yet whether it is worth keeping.
-- The answer arrives a minute later, and the interface offers to move the file
-- into a real bundle then. This is the policy that move needs.
--
-- Moving a document is not one write but two, and the second is the one that
-- decides anything. Retrieval scope is read from `document_chunks.bundle_id`
-- (`match_chunks`, 0005), not from the document row: the chunks say which
-- bundle a passage is searchable under, and the document row only says where
-- the file is filed. A move that re-points the row and leaves the chunks
-- behind therefore looks completely correct — the document appears under its
-- new bundle, answers still cite it — right up until the old bundle is
-- detached from the agent, at which point the passages stop being findable, or
-- the old bundle is deleted, at which point the cascade takes the chunks with
-- it. Both are silent.
--
-- `document_chunks` had select, insert and delete policies and no update
-- policy. RLS denies by default, so the re-pointing update matched zero rows
-- and returned no error — the exact shape of failure described above, arrived
-- at by omission rather than by a wrong policy.
--
-- Copying the chunks instead (insert the new, delete the old, both of which
-- were already permitted) was the alternative, and it does not scale: a 10 MB
-- text file is on the order of ten thousand chunks of 1536-dimension vectors,
-- and every one of them would have to be read out of the database and written
-- back through the worker to change one uuid column.
--
-- `can_write_in_workspace` rather than `is_workspace_member`, matching what
-- 0021 did to this table's insert and delete policies: a viewer reads a
-- workspace's knowledge and does not rearrange it.

drop policy if exists "dc_update_member" on public.document_chunks;
create policy "dc_update_member"
  on public.document_chunks for update
  using (public.can_write_in_workspace(workspace_id))
  with check (public.can_write_in_workspace(workspace_id));
