-- A seat belongs to one person: an update to a membership changes its role and
-- nothing else.
--
-- `workspace_members_update_admin` (0003) lets an admin update the rows of
-- their own workspace, and 0023's table-wide UPDATE grant let that update name
-- any column. So "change Carol's role" could equally be "make this row
-- somebody else's":
--
--   user_id       a person joins a workspace without accepting anything. Every
--                 account is the admin of its own workspace, so every account
--                 could do this to anybody whose id it knew -- and the new
--                 co-membership then shows that person's profile to the room.
--   workspace_id  the row moves between two workspaces the same admin runs.
--   created_at    "member since". The oldest membership is the fallback a
--                 person lands in when they have no active workspace chosen,
--                 so a backdated row decides where their requests go.
--
-- And none of it was logged: the membership log triggers (0040) fire on role
-- changes and deletes, and a row that changes hands is neither.
--
-- Joining has exactly three doors -- the signup trigger, `create_workspace`
-- and `accept_invitation` -- and all three insert. Nothing in the product
-- updates anything but `role`. So the grant becomes that one column, and a
-- trigger pins the other three for every caller, the service role included,
-- the way 0033 pins an API key's identity: a membership that needs to belong
-- to somebody else is a removal and an invitation, both of which are logged.
--
-- INSERT is revoked as well. There is no INSERT policy, so a client insert was
-- already refused; without the grant the refusal is the grant's, and it does
-- not depend on nobody ever adding a policy.

revoke insert, update on public.workspace_members from anon, authenticated;
grant update (role) on public.workspace_members to authenticated;

create or replace function public.workspace_members_pin_identity()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.workspace_id is distinct from old.workspace_id
    or new.user_id is distinct from old.user_id
    or new.created_at is distinct from old.created_at
  then
    raise exception 'a membership can only change its role'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.workspace_members_pin_identity() from public;

drop trigger if exists trg_workspace_members_pin_identity on public.workspace_members;
create trigger trg_workspace_members_pin_identity
  before update on public.workspace_members
  for each row execute function public.workspace_members_pin_identity();
