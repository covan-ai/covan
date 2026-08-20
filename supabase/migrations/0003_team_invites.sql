-- 0003_team_invites.sql
-- Team invitations, multi-workspace active-workspace tracking, role management.
-- Depends on 0001_init.sql (workspaces, workspace_members, profiles, auth.users).

-- ---- profiles.active_workspace_id -----------------------------------------
-- The workspace the user is currently "in". Nullable; the worker falls back to
-- the oldest membership when null or when the user is no longer a member.
alter table public.profiles
  add column active_workspace_id uuid references public.workspaces (id) on delete set null;

-- ---- is_workspace_admin() helper ------------------------------------------
-- SECURITY DEFINER (same pattern as is_workspace_member) so admin-check
-- policies on workspace_members / invitations never re-trigger RLS.
create function public.is_workspace_admin(p_workspace_id uuid)
returns boolean
language sql
security definer
stable
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = p_workspace_id
      and wm.user_id = auth.uid()
      and wm.role = 'admin'
  );
$$;

-- ---- workspace_members: admin manage policies -----------------------------
-- Existing 0001 policy: workspace_members_select_fellow_members (SELECT only).
-- Add admin-only UPDATE (change role) and DELETE (remove member). No general
-- INSERT policy: joining a workspace happens through accept_invitation() (a
-- SECURITY DEFINER RPC that bypasses RLS).
create policy "workspace_members_update_admin"
  on public.workspace_members for update
  using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));

create policy "workspace_members_delete_admin"
  on public.workspace_members for delete
  using (public.is_workspace_admin(workspace_id));

-- ---- last-admin protection trigger ----------------------------------------
-- Prevents demoting or removing the final admin of a workspace, regardless of
-- who performs the operation (the worker guard is best-effort; this is the backstop).
create function public.prevent_last_admin_removal()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_other_admins int;
begin
  if (tg_op = 'DELETE') then
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

create trigger trg_prevent_last_admin
  before update or delete on public.workspace_members
  for each row execute function public.prevent_last_admin_removal();

-- ---- invitations ----------------------------------------------------------
create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  email text not null,
  role text not null check (role in ('admin', 'member')),
  invited_by uuid references auth.users (id),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked')),
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id)
);

-- At most one pending invite per (workspace, email). Revoked/accepted rows are
-- excluded so an email can be re-invited later.
create unique index invitations_unique_pending
  on public.invitations (workspace_id, lower(email))
  where status = 'pending';

create index idx_invitations_workspace on public.invitations (workspace_id);
create index idx_invitations_email on public.invitations (lower(email));

alter table public.invitations enable row level security;

-- Admins of the workspace see all its invites; an invitee sees invites
-- addressed to their own email (needed to accept). Email match is case-insensitive.
create policy "invitations_select_admin_or_invitee"
  on public.invitations for select
  using (
    public.is_workspace_admin(workspace_id)
    or lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );

create policy "invitations_insert_admin"
  on public.invitations for insert
  with check (public.is_workspace_admin(workspace_id) and invited_by = auth.uid());

-- Revoke = hard delete by an admin.
create policy "invitations_delete_admin"
  on public.invitations for delete
  using (public.is_workspace_admin(workspace_id));
-- No UPDATE policy: acceptance flips status via accept_invitation() (SECURITY DEFINER).

-- ---- accept_invitation() RPC ----------------------------------------------
-- Runs as owner (bypasses RLS) so a not-yet-member invitee can join. Validates
-- the caller's JWT email matches the invite, inserts membership, marks accepted,
-- and switches the caller's active workspace to the joined one. Returns the id.
create function public.accept_invitation(p_invite_id uuid)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_invite public.invitations;
  v_email text;
begin
  v_email := lower(coalesce(auth.jwt() ->> 'email', ''));

  select * into v_invite
  from public.invitations
  where id = p_invite_id and status = 'pending';

  if not found then
    raise exception 'invitation not found or already handled';
  end if;

  if lower(v_invite.email) <> v_email then
    raise exception 'this invitation is not addressed to you';
  end if;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_invite.workspace_id, auth.uid(), v_invite.role)
  on conflict (workspace_id, user_id) do nothing;

  update public.invitations
    set status = 'accepted', accepted_at = now(), accepted_by = auth.uid()
    where id = p_invite_id;

  update public.profiles
    set active_workspace_id = v_invite.workspace_id
    where id = auth.uid();

  return v_invite.workspace_id;
end;
$$;

grant execute on function public.accept_invitation(uuid) to authenticated;
