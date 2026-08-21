-- 0016_deletable_users_and_workspaces.sql
--
-- Two things in this schema could not be deleted at all. Neither is reachable
-- from the app today — there is no "delete workspace" route and no "delete
-- account" route — which is exactly why it went unnoticed: the first person to
-- need either would have been someone exercising a legal right to erasure.
--
-- 1. A WORKSPACE could not be deleted. Deleting one cascades to
--    workspace_members, and trg_prevent_last_admin refuses to remove a
--    workspace's last admin. The guard is right for a member leaving and wrong
--    for a workspace being dismantled, but it could not tell the two apart, so
--    even a single-member personal workspace was undeletable.
--
-- 2. A USER could not be deleted. Six columns recording who made something
--    referenced auth.users with NO ACTION, so `delete from auth.users` was
--    refused by the first workspace, agent, bundle, idea or invitation they had
--    ever touched — including ones in workspaces they had long since left.
--
-- What this does NOT change: a user who is the last admin of a workspace that
-- still exists remains undeletable, and deliberately so. Deciding whether that
-- should promote the oldest remaining member, block until the role is handed
-- over, or take the workspace with it is a product question, not a schema one.
-- Everything else stops standing in its way.

-- =========================================================================
-- Attribution survives its author
-- =========================================================================
--
-- All six columns are nullable and none is load-bearing: they say who made a
-- thing, not whose it is. Ownership goes through workspace_members and the
-- per-user tables, which already cascade. So the row stays and the name drops
-- — a workspace does not evaporate because the person who opened it left.

alter table public.workspaces
  drop constraint if exists workspaces_created_by_fkey,
  add constraint workspaces_created_by_fkey
    foreign key (created_by) references auth.users (id) on delete set null;

alter table public.agents
  drop constraint if exists agents_created_by_fkey,
  add constraint agents_created_by_fkey
    foreign key (created_by) references auth.users (id) on delete set null;

alter table public.knowledge_bundles
  drop constraint if exists knowledge_bundles_created_by_fkey,
  add constraint knowledge_bundles_created_by_fkey
    foreign key (created_by) references auth.users (id) on delete set null;

alter table public.ideas
  drop constraint if exists ideas_created_by_fkey,
  add constraint ideas_created_by_fkey
    foreign key (created_by) references auth.users (id) on delete set null;

alter table public.invitations
  drop constraint if exists invitations_invited_by_fkey,
  add constraint invitations_invited_by_fkey
    foreign key (invited_by) references auth.users (id) on delete set null;

alter table public.invitations
  drop constraint if exists invitations_accepted_by_fkey,
  add constraint invitations_accepted_by_fkey
    foreign key (accepted_by) references auth.users (id) on delete set null;

-- =========================================================================
-- The last-admin guard learns the difference between leaving and dismantling
-- =========================================================================
--
-- The trigger is BEFORE DELETE on workspace_members. A foreign key's cascade
-- runs after the referenced row is gone, so when the delete arrives by way of
-- `delete from workspaces`, the workspace it is protecting no longer exists by
-- the time this runs. That is the whole test: a membership whose workspace is
-- still there is someone leaving, and the guard applies; a membership whose
-- workspace has gone is debris, and there is nothing left to leave un-owned.
--
-- Replaces the function only; the trigger itself is unchanged.

create or replace function public.prevent_last_admin_removal()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_other_admins int;
begin
  if (tg_op = 'DELETE') then
    -- The workspace is being deleted and this row is going with it.
    if not exists (select 1 from public.workspaces where id = old.workspace_id) then
      return old;
    end if;

    if old.role = 'admin' then
      select count(*) into v_other_admins
      from public.workspace_members
      where workspace_id = old.workspace_id and role = 'admin' and user_id <> old.user_id;
      if v_other_admins = 0 then
        raise exception 'cannot remove the last admin of a workspace';
      end if;
    end if;
    return old;
  elsif (tg_op = 'UPDATE') then
    if old.role = 'admin' and new.role <> 'admin' then
      select count(*) into v_other_admins
      from public.workspace_members
      where workspace_id = old.workspace_id and role = 'admin' and user_id <> old.user_id;
      if v_other_admins = 0 then
        raise exception 'cannot demote the last admin of a workspace';
      end if;
    end if;
    return new;
  end if;
  return new;
end;
$$;
