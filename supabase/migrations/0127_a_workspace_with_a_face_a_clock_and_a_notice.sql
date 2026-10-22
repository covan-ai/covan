-- =========================================================================
-- A workspace with a face, a clock and a notice
--
-- Settings › General (A9) gives the workspace four things it did not have:
--
--   * an icon — a square image in place of the letter on the tile. Stored
--     like a profile photo (0095): the path of an object this deployment
--     holds, checked by shape so the column can never point anywhere else;
--   * a time zone, which routines are scheduled in by default and which the
--     weekly summary is sent on Monday morning of;
--   * a weekly usage summary for admins, off unless somebody turns it on;
--   * deletion with fourteen days' notice. "Delete workspace…" asks for the
--     name, every member is told, and the workspace goes when `deletes_at`
--     passes (the purge, worker/src/lib/purge.ts). Cancel is one press until
--     then. `deletes_at` is the function's to set: the column grant below
--     names what a client may update, and this is not among it.
--
-- And `member_agent_counts`, the Team table's Agents column (A3): how many
-- agents each member can use, which only a definer can ask for somebody else.
-- =========================================================================

alter table public.workspaces
  add column if not exists icon_url              text,
  add column if not exists timezone              text,
  add column if not exists weekly_usage_email    boolean not null default false,
  add column if not exists weekly_usage_sent_for date,
  add column if not exists deletion_requested_at timestamptz,
  add column if not exists deletion_requested_by uuid references auth.users (id) on delete set null,
  add column if not exists deletes_at            timestamptz;

alter table public.workspaces drop constraint if exists workspaces_icon_url_stored_here;
alter table public.workspaces
  add constraint workspaces_icon_url_stored_here
  check (icon_url is null
         or icon_url ~ ('^/workspace-icons/' || id::text || '/[0-9a-f]{32}\.(png|jpg|webp)$'));

alter table public.workspaces drop constraint if exists workspaces_timezone_shape;
alter table public.workspaces add constraint workspaces_timezone_shape
  check (
    timezone is null
    or (char_length(timezone) <= 64 and timezone ~ '^[A-Za-z_]+(/[A-Za-z0-9_+-]+)*$')
  );

-- What an admin may change through the API. The deletion columns are not here:
-- they are `request_workspace_deletion`'s and `cancel_workspace_deletion`'s.
grant update (icon_url, timezone, weekly_usage_email) on public.workspaces to authenticated;

alter table public.workspace_events
  drop constraint if exists workspace_events_subject_type_check;
alter table public.workspace_events
  add constraint workspace_events_subject_type_check
  check (subject_type in ('agent', 'bundle', 'document', 'member', 'invitation', 'session',
                          'routine', 'workspace'));

create or replace function public.request_workspace_deletion(p_workspace_id uuid, p_name text)
returns timestamptz
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_name text;
  v_when timestamptz;
begin
  select w.name into v_name from public.workspaces w where w.id = p_workspace_id;
  if v_name is null or not public.is_workspace_member(p_workspace_id) then
    raise exception 'no such workspace' using errcode = 'P0002';
  end if;
  if not public.is_workspace_admin(p_workspace_id) then
    raise exception 'only admins can delete a workspace' using errcode = '42501';
  end if;
  if p_name is null or trim(p_name) <> v_name then
    raise exception 'type the workspace''s name exactly to delete it' using errcode = '22023';
  end if;

  v_when := now() + interval '14 days';
  update public.workspaces
     set deletion_requested_at = now(),
         deletion_requested_by = auth.uid(),
         deletes_at = v_when
   where id = p_workspace_id
     and deletes_at is null;

  if not found then
    select w.deletes_at into v_when from public.workspaces w where w.id = p_workspace_id;
    return v_when;
  end if;

  perform public.log_workspace_event(
    p_workspace_id, 'workspace.deletion_requested', 'workspace', p_workspace_id, v_name,
    jsonb_build_object('deletes_at', v_when));
  return v_when;
end $$;

create or replace function public.cancel_workspace_deletion(p_workspace_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_name text;
begin
  select w.name into v_name from public.workspaces w where w.id = p_workspace_id;
  if v_name is null or not public.is_workspace_member(p_workspace_id) then
    raise exception 'no such workspace' using errcode = 'P0002';
  end if;
  if not public.is_workspace_admin(p_workspace_id) then
    raise exception 'only admins can keep a workspace' using errcode = '42501';
  end if;

  update public.workspaces
     set deletion_requested_at = null, deletion_requested_by = null, deletes_at = null
   where id = p_workspace_id
     and deletes_at is not null;

  if found then
    perform public.log_workspace_event(
      p_workspace_id, 'workspace.deletion_cancelled', 'workspace', p_workspace_id, v_name, null);
  end if;
end $$;

-- How many agents each member can use, for the Team table.
create or replace function public.member_agent_counts(p_workspace_id uuid)
returns table (user_id uuid, agents integer)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if auth.uid() is null or not public.is_workspace_member(p_workspace_id) then
    raise exception 'not a member of this workspace' using errcode = '42501';
  end if;

  return query
  select wm.user_id,
         (select count(*)::integer
            from public.agents a
           where a.workspace_id = p_workspace_id
             and a.deleted_at is null
             and public.agent_access_for(a.id, wm.user_id) is not null)
    from public.workspace_members wm
   where wm.workspace_id = p_workspace_id;
end $$;

revoke all on function public.request_workspace_deletion(uuid, text) from public, anon;
grant execute on function public.request_workspace_deletion(uuid, text) to authenticated, service_role;
revoke all on function public.cancel_workspace_deletion(uuid) from public, anon;
grant execute on function public.cancel_workspace_deletion(uuid) to authenticated, service_role;
revoke all on function public.member_agent_counts(uuid) from public, anon;
grant execute on function public.member_agent_counts(uuid) to authenticated, service_role;
