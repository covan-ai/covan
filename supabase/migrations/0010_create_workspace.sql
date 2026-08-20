-- 0010_create_workspace.sql
-- create_workspace(): let an authenticated user create an additional workspace.
--
-- workspace_members has no general RLS insert policy (rows are created only by
-- the signup trigger and accept_invitation()). So creating a workspace plus its
-- admin membership must happen atomically in a SECURITY DEFINER function, the
-- same pattern accept_invitation() uses. The function also switches the caller's
-- active workspace to the newly created one, matching accept_invitation().

create function public.create_workspace(p_name text)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_name text;
  v_slug text;
  v_workspace_id uuid;
begin
  v_name := trim(coalesce(p_name, ''));
  if v_name = '' then
    raise exception 'workspace name is required';
  end if;

  v_slug := lower(regexp_replace(v_name, '[^a-zA-Z0-9]+', '-', 'g'))
            || '-' || substr(gen_random_uuid()::text, 1, 8);

  insert into public.workspaces (name, slug, created_by)
  values (v_name, v_slug, auth.uid())
  returning id into v_workspace_id;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_workspace_id, auth.uid(), 'admin');

  update public.profiles
    set active_workspace_id = v_workspace_id
    where id = auth.uid();

  return v_workspace_id;
end;
$$;

grant execute on function public.create_workspace(text) to authenticated;
