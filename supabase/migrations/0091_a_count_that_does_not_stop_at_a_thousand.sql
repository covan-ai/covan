-- A count that does not stop at a thousand: closing an account decides which
-- workspaces go with it by counting in the database, and deletes one only if
-- nobody else is in it at the moment of the delete.
--
-- `DELETE /account` used to read every membership of every workspace the
-- person was in, through PostgREST, and decide in TypeScript. PostgREST caps a
-- read at `max_rows` (1000) and says nothing when it does. Somebody in a big
-- workspace and a small one could therefore see the big one's thousand rows,
-- none of the small one's, conclude the small one was theirs alone -- and the
-- service role deleted it, with its other members still in it. With the
-- workspace ids sorting the right way round, that is a viewer in somebody
-- else's team deleting the team by closing their own account.
--
-- Two functions, one for each half of the mistake:
--
--   account_closure_plan()   for each workspace the caller is in: their role,
--                            how many others are in it, how many of those are
--                            admins. Aggregated in SQL, so the answer is a
--                            number rather than a page of rows that can be cut
--                            short. Runs as the caller: the counts are of the
--                            fellow members their own policies let them see,
--                            which is every member of a workspace they are in.
--
--   delete_workspace_if_sole_member(workspace, user)
--                            the delete itself, conditional on nobody but that
--                            user being a member when it runs -- so a plan made
--                            a moment earlier cannot delete a workspace
--                            somebody joined since. Service role only: it is
--                            the account route's, after the plan.

create or replace function public.account_closure_plan()
returns table (workspace_id uuid, role text, other_members bigint, other_admins bigint)
language sql
stable
set search_path = pg_catalog, public
as $$
  select me.workspace_id,
         me.role,
         count(them.user_id) as other_members,
         count(them.user_id) filter (where them.role = 'admin') as other_admins
    from public.workspace_members me
    left join public.workspace_members them
      on them.workspace_id = me.workspace_id and them.user_id <> me.user_id
   where me.user_id = auth.uid()
   group by me.workspace_id, me.role
$$;

revoke all on function public.account_closure_plan() from public, anon;
grant execute on function public.account_closure_plan() to authenticated, service_role;

create or replace function public.delete_workspace_if_sole_member(
  p_workspace_id uuid,
  p_user_id uuid
)
returns boolean
language sql
set search_path = pg_catalog, public
as $$
  with gone as (
    delete from public.workspaces w
     where w.id = p_workspace_id
       and not exists (
         select 1 from public.workspace_members m
          where m.workspace_id = p_workspace_id and m.user_id <> p_user_id)
    returning 1
  )
  select exists (select 1 from gone)
$$;

revoke all on function public.delete_workspace_if_sole_member(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.delete_workspace_if_sole_member(uuid, uuid) to service_role;
