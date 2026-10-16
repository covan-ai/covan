-- =========================================================================
-- The invited join their team
--
-- Everybody who signed up was given a workspace of their own by
-- `handle_new_user()` (0001), including somebody who signed up because a
-- colleague invited them. They accepted, joined the team's workspace, and kept
-- an empty "Bob's Workspace" in the switcher that nothing had asked for — one
-- they could wander back into and build an agent in where nobody on the team
-- could see it. On the hosted service it also took their one free grant,
-- which belongs with a workspace somebody actually chose to start.
--
-- So an account whose address has an invitation waiting is created with no
-- workspace. The app sends it to the invitation; accepting is how it gets one.
-- If the invitation has expired or been revoked by the time they arrive, the
-- welcome flow offers to start a workspace instead (`POST /workspaces`), and
-- that is the workspace any free grant goes to.
--
-- "Waiting" is the same test `incoming_invitations()` (0114) applies: pending
-- and unexpired, addressed to this account's address. The body is otherwise
-- 0001's, unchanged.
-- =========================================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_name text;
  v_workspace_id uuid;
  v_slug text;
begin
  v_name := coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1));

  insert into public.profiles (id, name, avatar_url, email)
  values (new.id, v_name, new.raw_user_meta_data ->> 'avatar_url', new.email);

  if new.email is not null and exists (
    select 1
    from public.invitations i
    where i.email = lower(new.email)
      and i.status = 'pending'
      and i.expires_at > now()
  ) then
    return new;
  end if;

  v_slug := lower(regexp_replace(coalesce(split_part(new.email, '@', 1), new.id::text), '[^a-zA-Z0-9]+', '-', 'g'))
            || '-' || substr(new.id::text, 1, 8);

  insert into public.workspaces (name, slug, created_by)
  values (v_name || '''s Workspace', v_slug, new.id)
  returning id into v_workspace_id;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_workspace_id, new.id, 'admin');

  return new;
end;
$$;

revoke all on function public.handle_new_user() from public, anon, authenticated;
