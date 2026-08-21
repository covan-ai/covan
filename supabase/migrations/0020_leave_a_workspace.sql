-- 0020_leave_a_workspace.sql
--
-- Nobody could leave a workspace.
--
-- `workspace_members` had exactly three policies: select-fellow (0001),
-- update-admin and delete-admin (0003). Every one of them is about what an
-- admin may do TO somebody. There was no policy under which a person could
-- remove their own row, and no route offered it — so joining a workspace was
-- one-way, and the only exit was asking an admin to remove you. An admin could
-- leave through the API by removing themselves, but the team screen hides the
-- control on your own row, so in practice nobody could.
--
-- The policy below is the whole fix, and it is deliberately the narrowest one
-- that works: your own row, nothing else. It does not weaken delete-admin and
-- it does not touch the last-admin guard.
--
-- WHAT HAPPENS TO THE LAST ADMIN: nothing new. `trg_prevent_last_admin` (0003,
-- rewritten in 0016) already refuses to remove the last admin of a workspace
-- that still exists, whoever asks and however they ask. So the last admin of a
-- live workspace still cannot leave, and has to hand the role over first. That
-- is the behaviour 0016's header left open as a product question, now decided:
-- block until the role is handed over, rather than auto-promoting somebody who
-- never agreed to it or deleting a workspace other people are still working in.
-- The screen's job is to say so before the button is pressed; the trigger is
-- the backstop for everything that does not go through the screen.
--
-- WHAT HAPPENS TO WHAT THEY MADE: it stays, unattributed where it was
-- attributed — the arrangement 0016 already built for a deleted account, and
-- for the same reason. Agents, bundles and shared sessions belong to the
-- workspace, not to whoever typed them. What was theirs alone is keyed to
-- their user id rather than their membership, so it neither moves nor
-- vanishes; they simply stop being able to see it, which membership.test.ts
-- already asserts for a member who is removed.

drop policy if exists "workspace_members_delete_self" on public.workspace_members;

create policy "workspace_members_delete_self"
  on public.workspace_members for delete
  using (user_id = auth.uid());
