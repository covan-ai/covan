-- =========================================================================
-- A link that works for a week
--
-- The invite dialog (A25) ends "Or share a link that works for 7 days · Copy
-- link": for a team that would rather paste one link into its own chat than
-- type six addresses. An invitation (0090) is addressed to one email; a link
-- is addressed to whoever holds it, so it is its own table with its own
-- rules:
--
--   * Admins make, list and revoke them. The token is shown once, when it is
--     made; the table keeps its SHA-256, like an invitation's (0090), and no
--     client role may read even that.
--   * A link joins as a member or a viewer, never an admin: handing out the
--     keys to the workspace in a chat message is not something a link should
--     be able to do.
--   * It works for seven days, until revoked, and counts how often it was
--     used. `accept_invite_link` is the only way in, for a signed-in person
--     with a confirmed address, exactly as `accept_invitation` asks.
--   * `invite_link_preview` is what `/invite` shows before sign-in: the
--     workspace's name, how many people and agents it has, who made the link
--     and until when. The service role's alone, like `invitation_preview`
--     (0114): the route asks on the visitor's behalf, holding the token.
--
-- `invitation_preview` learns the same three facts, so the invitation card
-- (A23: "Acme · 6 members · 4 agents · expires in 5 days") reads the same for
-- both kinds.
-- =========================================================================

create table if not exists public.invite_links (
  id           uuid        primary key default gen_random_uuid(),
  workspace_id uuid        not null references public.workspaces (id) on delete cascade,
  role         text        not null default 'member' check (role in ('member', 'viewer')),
  token_hash   text        not null unique,
  created_by   uuid        references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '7 days',
  revoked_at   timestamptz,
  uses         integer     not null default 0 check (uses >= 0)
);

create index if not exists invite_links_workspace_idx
  on public.invite_links (workspace_id, created_at desc);

alter table public.invite_links enable row level security;

drop policy if exists "invite_links_select_admin" on public.invite_links;
create policy "invite_links_select_admin"
  on public.invite_links for select
  using (public.is_workspace_admin(workspace_id));

drop policy if exists "invite_links_insert_admin" on public.invite_links;
create policy "invite_links_insert_admin"
  on public.invite_links for insert
  with check (public.is_workspace_admin(workspace_id) and created_by = auth.uid());

drop policy if exists "invite_links_update_admin" on public.invite_links;
create policy "invite_links_update_admin"
  on public.invite_links for update
  using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));

drop policy if exists invite_links_request_workspace on public.invite_links;
create policy invite_links_request_workspace on public.invite_links
  as restrictive for all to authenticated
  using ((select public.request_workspace()) is null
         or workspace_id = (select public.request_workspace()));

revoke all on public.invite_links from anon, authenticated;
grant select (id, workspace_id, role, created_by, created_at, expires_at, revoked_at, uses)
  on public.invite_links to authenticated;
grant insert (workspace_id, role, token_hash, created_by) on public.invite_links to authenticated;
grant update (revoked_at) on public.invite_links to authenticated;
grant select, insert, update, delete on public.invite_links to service_role;

create or replace function public.accept_invite_link(p_token text)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_link public.invite_links;
begin
  if not exists (
    select 1 from auth.users u
    where u.id = auth.uid() and u.email_confirmed_at is not null
  ) then
    raise exception 'confirm your email address before joining a workspace' using errcode = '42501';
  end if;

  if p_token is null or length(p_token) > 200 then
    raise exception 'this link does not work' using errcode = 'P0002';
  end if;

  select * into v_link
    from public.invite_links
   where token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
     and revoked_at is null
     and expires_at > now()
   for update;

  if not found then
    raise exception 'this link has expired or was turned off' using errcode = 'P0002';
  end if;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_link.workspace_id, auth.uid(), v_link.role)
  on conflict (workspace_id, user_id) do nothing;

  if found then
    update public.invite_links set uses = uses + 1 where id = v_link.id;
  end if;

  update public.profiles
     set active_workspace_id = v_link.workspace_id
   where id = auth.uid();

  return v_link.workspace_id;
end $$;

create or replace function public.invite_link_preview(p_token text)
returns table (
  workspace_name text,
  inviter_name   text,
  role           text,
  member_count   integer,
  agent_count    integer,
  expires_at     timestamptz,
  open           boolean
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select w.name,
         nullif(trim(p.name), ''),
         l.role,
         (select count(*)::integer from public.workspace_members m where m.workspace_id = w.id),
         (select count(*)::integer from public.agents a
           where a.workspace_id = w.id and a.deleted_at is null),
         l.expires_at,
         (l.revoked_at is null and l.expires_at > now())
    from public.invite_links l
    join public.workspaces w on w.id = l.workspace_id
    left join public.profiles p on p.id = l.created_by
   where p_token is not null
     and length(p_token) <= 200
     and l.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
$$;

drop function if exists public.invitation_preview(uuid, text);
create function public.invitation_preview(p_invite_id uuid, p_token text)
returns table (
  workspace_name text,
  inviter_name   text,
  email          text,
  role           text,
  open           boolean,
  member_count   integer,
  agent_count    integer,
  expires_at     timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select w.name,
         nullif(trim(p.name), ''),
         i.email,
         i.role,
         (i.status = 'pending' and i.expires_at > now()),
         (select count(*)::integer from public.workspace_members m where m.workspace_id = w.id),
         (select count(*)::integer from public.agents a
           where a.workspace_id = w.id and a.deleted_at is null),
         i.expires_at
  from public.invitations i
  join public.workspaces w on w.id = i.workspace_id
  left join public.profiles p on p.id = i.invited_by
  where i.id = p_invite_id
    and i.token_hash is not null
    and p_token is not null
    and length(p_token) <= 200
    and i.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
$$;

revoke all on function public.accept_invite_link(text) from public, anon;
grant execute on function public.accept_invite_link(text) to authenticated, service_role;
revoke all on function public.invite_link_preview(text) from public, anon, authenticated;
grant execute on function public.invite_link_preview(text) to service_role;
revoke all on function public.invitation_preview(uuid, text) from public, anon, authenticated;
grant execute on function public.invitation_preview(uuid, text) to service_role;
