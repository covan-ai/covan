-- An agent shared on purpose: whoever makes an agent decides who else sees it,
-- and what each of them may do with it.
--
-- Until now every member of a workspace saw every agent in it (0040's
-- `agents_select_workspace_member`), and every writer could change or delete
-- any of them (0021). That made an agent somebody was still building, or one
-- built for a single person's work, the whole team's on the first keystroke.
-- 0098 gave connected services the same shape this gives agents: personal by
-- default, shared on purpose.
--
-- An agent is reached in one of three ways:
--
--   Only me           `workspace_access` is null and nobody is in `agent_shares`
--   Specific people   `workspace_access` is null, `agent_shares` names them
--   Whole workspace   `workspace_access` says what every member may do; a row
--                     in `agent_shares` can still raise one person above that
--
-- and at one of three levels:
--
--   use      see it and talk to it; its settings are read-only
--   edit     + persona, model, tuning, which knowledge it reads, tool grants
--   manage   + who it is shared with, deleting and restoring it
--
-- Two people always have `manage` and need no row: the agent's creator
-- (`created_by`) and every workspace admin. The admin half is not a courtesy.
-- `created_by` is set null when an account is deleted (0016) and keeps a
-- departed member's id when they leave, so without it an agent shared with
-- nobody would outlive the only person who could ever reach it.
--
-- A viewer is capped at `use` whatever they were granted. 0021 drew that line
-- for the whole workspace and a share does not get to redraw it; the grant is
-- kept, so promoting the viewer later is what turns it on.
--
-- EXISTING AGENTS become `workspace_access = 'edit'`: everyone who could reach
-- one yesterday still can, and can still change it. The one thing a plain
-- member loses is deleting an agent somebody else made, which nothing about
-- "shared with the workspace" should have implied. New agents start as Only me.
--
-- LOSING ACCESS hides, it does not delete. The agent's conversations — your
-- own included — and its routines go out of sight and stop, and they are all
-- back the moment it is shared with you again. See the session and routine
-- policies below, and `lib/routines/executor.ts`, which asks
-- `agent_access_for` because it runs as the service role.
--
-- Knowledge bundles are deliberately untouched. They are workspace-level and
-- many-to-many with agents, and who sees a bundle is its own question.

-- ===========================================================================
-- 1. the columns
-- ===========================================================================

alter table public.agents
  add column if not exists workspace_access text;

alter table public.agents drop constraint if exists agents_workspace_access_check;
alter table public.agents
  add constraint agents_workspace_access_check
  check (workspace_access in ('use', 'edit', 'manage'));

-- Every agent that exists today was shared with the whole workspace, editable
-- by every writer. Run once, before anything below can make an agent private.
update public.agents set workspace_access = 'edit' where workspace_access is null;

-- The people an agent is shared with by name.
--
-- Both foreign keys are composite, and both are doing a job. `(agent_id,
-- workspace_id)` makes a share into another workspace's agent impossible to
-- write at all (0058's argument for `agents_id_workspace_key`). `(workspace_id,
-- user_id)` onto `workspace_members` means removing somebody from the
-- workspace removes every share they held, however the membership ends.
create table if not exists public.agent_shares (
  agent_id     uuid not null,
  workspace_id uuid not null,
  user_id      uuid not null,
  access       text not null check (access in ('use', 'edit', 'manage')),
  granted_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  primary key (agent_id, user_id),
  foreign key (agent_id, workspace_id)
    references public.agents (id, workspace_id) on delete cascade,
  foreign key (workspace_id, user_id)
    references public.workspace_members (workspace_id, user_id) on delete cascade
);

create index if not exists agent_shares_user_idx on public.agent_shares (user_id);
create index if not exists agent_shares_workspace_user_idx
  on public.agent_shares (workspace_id, user_id);

-- ===========================================================================
-- 2. the one question every policy below asks
-- ===========================================================================

create or replace function public.agent_access_rank(p_access text)
returns integer
language sql
immutable
set search_path = pg_catalog, public
as $$
  select case p_access when 'manage' then 3 when 'edit' then 2 when 'use' then 1 else 0 end
$$;

-- What `p_user_id` may do with `p_agent_id`, or null for nothing.
--
-- Deliberately blind to `deleted_at`: the trash and `restore_agent` ask it
-- about deleted agents, and every policy that should not see one already says
-- `deleted_at is null` itself.
--
-- Service role only. It answers for any person, which is what the routine
-- executor and the Slack handler need — they hold the service role and act on
-- somebody's behalf — and exactly what a signed-in client must not be able to
-- ask. A client asks `agent_access`, which is this for `auth.uid()`.
create or replace function public.agent_access_for(p_agent_id uuid, p_user_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_workspace_id uuid;
  v_created_by   uuid;
  v_ws_access    text;
  v_role         text;
  v_shared       text;
  v_rank         integer;
begin
  if p_agent_id is null or p_user_id is null then
    return null;
  end if;

  select a.workspace_id, a.created_by, a.workspace_access
    into v_workspace_id, v_created_by, v_ws_access
    from public.agents a
   where a.id = p_agent_id;

  if v_workspace_id is null then
    return null;
  end if;

  select wm.role into v_role
    from public.workspace_members wm
   where wm.workspace_id = v_workspace_id
     and wm.user_id = p_user_id;

  if v_role is null then
    return null;
  end if;

  if v_role = 'admin' or v_created_by = p_user_id then
    v_rank := 3;
  else
    select s.access into v_shared
      from public.agent_shares s
     where s.agent_id = p_agent_id
       and s.user_id = p_user_id;

    v_rank := greatest(public.agent_access_rank(v_ws_access),
                       public.agent_access_rank(v_shared));
  end if;

  if v_role = 'viewer' then
    v_rank := least(v_rank, 1);
  end if;

  return case v_rank when 3 then 'manage' when 2 then 'edit' when 1 then 'use' end;
end $$;

revoke all on function public.agent_access_for(uuid, uuid) from public, anon, authenticated;
grant execute on function public.agent_access_for(uuid, uuid) to service_role;

-- The caller's own access, honouring an API key's workspace (0087): a key made
-- in one workspace reaches no agent in another, whatever its owner could.
create or replace function public.agent_access(p_agent_id uuid)
returns text
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select public.agent_access_for(a.id, auth.uid())
    from public.agents a
   where a.id = p_agent_id
     and (public.request_workspace() is null or a.workspace_id = public.request_workspace())
$$;

create or replace function public.can_use_agent(p_agent_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select public.agent_access_rank(public.agent_access(p_agent_id)) >= 1
$$;

create or replace function public.can_edit_agent(p_agent_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select public.agent_access_rank(public.agent_access(p_agent_id)) >= 2
$$;

create or replace function public.can_manage_agent(p_agent_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select public.agent_access_rank(public.agent_access(p_agent_id)) >= 3
$$;

revoke all on function public.agent_access(uuid) from public, anon;
grant execute on function public.agent_access(uuid) to authenticated, service_role;
revoke all on function public.can_use_agent(uuid) from public, anon;
grant execute on function public.can_use_agent(uuid) to authenticated, service_role;
revoke all on function public.can_edit_agent(uuid) from public, anon;
grant execute on function public.can_edit_agent(uuid) to authenticated, service_role;
revoke all on function public.can_manage_agent(uuid) from public, anon;
grant execute on function public.can_manage_agent(uuid) to authenticated, service_role;
revoke all on function public.agent_access_rank(text) from public, anon;
grant execute on function public.agent_access_rank(text) to authenticated, service_role;

-- `select=*,my_access` — a PostgREST computed field, so the API reads the
-- caller's level from the same function the policies use instead of working it
-- out a second time in TypeScript. Not definer: it only calls one.
create or replace function public.my_access(public.agents)
returns text
language sql
stable
set search_path = pg_catalog, public
as $$
  select public.agent_access($1.id)
$$;

revoke all on function public.my_access(public.agents) from public, anon;
grant execute on function public.my_access(public.agents) to authenticated, service_role;

-- ===========================================================================
-- 3. agents
-- ===========================================================================

-- The first two branches are `agent_access` answered from the row itself, and
-- they are not an optimisation. `insert ... returning` checks this policy
-- against the row being inserted, and a STABLE function reads the snapshot the
-- statement started with — in which that row does not exist yet. Asking the
-- function alone, a creator could not read back the agent they had just made.
drop policy if exists "agents_select_workspace_member" on public.agents;
create policy "agents_select_workspace_member"
  on public.agents for select
  using (
    deleted_at is null
    and public.is_workspace_member(workspace_id)
    and (
      created_by = auth.uid()
      or workspace_access is not null
      or public.can_use_agent(id)
    )
  );

-- Insert is unchanged: a writer creates an agent as themselves. The creator is
-- its owner, so the row they just wrote passes the select policy above.

drop policy if exists "agents_update_workspace_member" on public.agents;
create policy "agents_update_workspace_member"
  on public.agents for update
  using (public.can_edit_agent(id))
  with check (public.can_edit_agent(id));

drop policy if exists "agents_delete_workspace_member" on public.agents;
create policy "agents_delete_workspace_member"
  on public.agents for delete
  using (public.can_manage_agent(id));

-- `workspace_access` may be chosen when the agent is made, and changed only
-- through `set_agent_sharing` — an edit is not a share, and a column grant is
-- the only way to say so that a policy cannot get wrong.
grant insert (workspace_access) on public.agents to authenticated;

-- ===========================================================================
-- 4. agent_shares
-- ===========================================================================

alter table public.agent_shares enable row level security;

-- Whoever can see an agent can see who else it is shared with, which is what
-- the avatars on its card are.
drop policy if exists "agent_shares_select" on public.agent_shares;
create policy "agent_shares_select"
  on public.agent_shares for select
  using (public.is_workspace_member(workspace_id) and public.can_use_agent(agent_id));

drop policy if exists agent_shares_request_workspace on public.agent_shares;
create policy agent_shares_request_workspace on public.agent_shares
  as restrictive for all to authenticated
  using ((select public.request_workspace()) is null
         or workspace_id = (select public.request_workspace()));

-- Read-only to clients. Every write goes through `set_agent_sharing`, which
-- replaces the whole list in one statement and checks it as a list.
revoke all on public.agent_shares from anon, authenticated;
grant select on public.agent_shares to authenticated;
grant select, insert, update, delete on public.agent_shares to service_role;

-- Who can reach an agent, set all at once.
--
--   p_workspace_access  null, or the level every member gets
--   p_shares            [{"user_id": "...", "access": "use"|"edit"|"manage"}]
--
-- The list is the whole list: anyone not in it loses their share. One call
-- rather than a grant and a revoke endpoint because the dialog edits a list,
-- and a list saved half-way is a sharing state nobody chose.
create or replace function public.set_agent_sharing(
  p_agent_id uuid,
  p_workspace_access text,
  p_shares jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_workspace_id uuid;
  v_created_by   uuid;
  v_access       text := public.agent_access(p_agent_id);
  v_users        uuid[];
  v_levels       text[];
begin
  select a.workspace_id, a.created_by into v_workspace_id, v_created_by
    from public.agents a
   where a.id = p_agent_id and a.deleted_at is null;

  -- The same answer for an agent that does not exist and one you cannot see.
  if v_workspace_id is null or v_access is null then
    raise exception 'no such agent' using errcode = 'P0002';
  end if;

  if v_access <> 'manage' then
    raise exception 'you cannot change who can use this agent' using errcode = '42501';
  end if;

  if p_workspace_access is not null and p_workspace_access not in ('use', 'edit', 'manage') then
    raise exception 'workspace access must be use, edit or manage' using errcode = '22023';
  end if;

  if p_shares is null or jsonb_typeof(p_shares) <> 'array' then
    raise exception 'shares must be a list' using errcode = '22023';
  end if;

  select coalesce(array_agg((e ->> 'user_id')::uuid), '{}'),
         coalesce(array_agg(e ->> 'access'), '{}')
    into v_users, v_levels
    from jsonb_array_elements(p_shares) e;

  if array_position(v_users, null) is not null
     or exists (select 1 from unnest(v_levels) l
                 where l is null or l not in ('use', 'edit', 'manage')) then
    raise exception 'each share needs a person and a level of use, edit or manage'
      using errcode = '22023';
  end if;

  if cardinality(v_users) <> (select count(distinct u) from unnest(v_users) u) then
    raise exception 'a person appears twice in the list' using errcode = '22023';
  end if;

  if v_created_by = any (v_users) then
    raise exception 'the agent''s owner always has full access' using errcode = '22023';
  end if;

  if exists (
    select 1 from unnest(v_users) u
     where not exists (
       select 1 from public.workspace_members wm
        where wm.workspace_id = v_workspace_id and wm.user_id = u)
  ) then
    raise exception 'that person is not a member of this workspace' using errcode = '22023';
  end if;

  delete from public.agent_shares s
   where s.agent_id = p_agent_id
     and not (s.user_id = any (v_users));

  insert into public.agent_shares (agent_id, workspace_id, user_id, access, granted_by)
  select p_agent_id, v_workspace_id, w.user_id, w.access, auth.uid()
    from unnest(v_users, v_levels) as w(user_id, access)
  on conflict (agent_id, user_id) do update
    set access = excluded.access,
        granted_by = case when agent_shares.access = excluded.access
                          then agent_shares.granted_by else excluded.granted_by end;

  update public.agents
     set workspace_access = p_workspace_access
   where id = p_agent_id;
end $$;

revoke all on function public.set_agent_sharing(uuid, text, jsonb) from public, anon;
grant execute on function public.set_agent_sharing(uuid, text, jsonb) to authenticated, service_role;

-- ===========================================================================
-- 5. what hangs off an agent goes where the agent goes
-- ===========================================================================

-- Sessions, and through `session_is_visible` everything 0031 hung on it:
-- messages, ideas, message steps (0060's `message_is_visible`), paused turns.
-- Your own conversations included — losing an agent means losing sight of it.
create or replace function public.session_is_visible(p_session_id uuid)
returns boolean
language sql
security definer
stable
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.chat_sessions cs
    where cs.id = p_session_id
      and cs.deleted_at is null
      and public.is_workspace_member(cs.workspace_id)
      and (cs.user_id = auth.uid() or cs.visibility = 'shared')
      and public.can_use_agent(cs.agent_id)
  );
$$;

drop policy if exists "chat_sessions_select_owner_or_shared" on public.chat_sessions;
create policy "chat_sessions_select_owner_or_shared"
  on public.chat_sessions for select
  using (
    deleted_at is null
    and public.is_workspace_member(workspace_id)
    and (user_id = auth.uid() or visibility = 'shared')
    and public.can_use_agent(agent_id)
  );

-- Routines: out of sight here, and not run — the executor asks
-- `agent_access_for` for the routine's owner before every run. `routine_runs`
-- and `routine_triggers` reach their routine through this policy.
drop policy if exists "routines_select_visible" on public.routines;
create policy "routines_select_visible"
  on public.routines for select
  using (
    deleted_at is null
    and (
      user_id = auth.uid()
      or (visibility = 'shared' and public.is_workspace_member(workspace_id))
    )
    and public.can_use_agent(agent_id)
  );

-- Favourites: the foreign key is checked past RLS, so without this an agent
-- you cannot see could be favourited by id.
drop policy if exists "favorites_select_owner" on public.favorites;
create policy "favorites_select_owner"
  on public.favorites for select
  using (user_id = auth.uid() and public.can_use_agent(agent_id));

drop policy if exists "favorites_insert_owner" on public.favorites;
create policy "favorites_insert_owner"
  on public.favorites for insert
  with check (user_id = auth.uid() and public.can_use_agent(agent_id));

-- Attaching knowledge changes what the agent knows: an edit.
drop policy if exists "ab_insert_member" on public.agent_bundles;
create policy "ab_insert_member"
  on public.agent_bundles for insert
  with check (
    public.can_edit_agent(agent_bundles.agent_id)
    and exists (
      select 1
      from public.agents a
      join public.knowledge_bundles b on b.id = agent_bundles.bundle_id
      where a.id = agent_bundles.agent_id
        and a.workspace_id = b.workspace_id
        and public.can_write_in_workspace(a.workspace_id)
    )
  );

drop policy if exists "ab_delete_member" on public.agent_bundles;
create policy "ab_delete_member"
  on public.agent_bundles for delete
  using (
    public.can_edit_agent(agent_bundles.agent_id)
    and exists (select 1 from public.agents a where a.id = agent_bundles.agent_id)
  );

-- What the agent may do on a connection without asking: an edit too. Revoking
-- stays open to every writer — taking a permission away is never the unsafe
-- direction (0058).
drop policy if exists "connection_grants_insert" on public.connection_grants;
create policy "connection_grants_insert"
  on public.connection_grants for insert
  with check (
    public.can_write_in_workspace(workspace_id)
    and public.can_edit_agent(agent_id)
    and (
      mode <> 'always'
      or public.is_workspace_admin(workspace_id)
      or not exists (
        select 1 from public.connection_capabilities c
        where c.provider = connection_grants.provider
          and c.capability = connection_grants.capability
          and c.is_destructive
      )
    )
  );

drop policy if exists "connection_grants_update" on public.connection_grants;
create policy "connection_grants_update"
  on public.connection_grants for update
  using (public.can_write_in_workspace(workspace_id))
  with check (
    public.can_write_in_workspace(workspace_id)
    and public.can_edit_agent(agent_id)
    and (
      mode <> 'always'
      or public.is_workspace_admin(workspace_id)
      or not exists (
        select 1 from public.connection_capabilities c
        where c.provider = connection_grants.provider
          and c.capability = connection_grants.capability
          and c.is_destructive
      )
    )
  );

drop policy if exists "tool_connection_grants_insert" on public.tool_connection_grants;
create policy "tool_connection_grants_insert"
  on public.tool_connection_grants for insert
  with check (
    public.can_write_in_workspace(workspace_id)
    and public.can_edit_agent(agent_id)
    and (mode <> 'always' or public.is_workspace_admin(workspace_id))
    and exists (
      select 1 from public.tool_connections c
       where c.id = tool_connection_grants.tool_connection_id
         and c.workspace_id = tool_connection_grants.workspace_id)
  );

drop policy if exists "tool_connection_grants_update" on public.tool_connection_grants;
create policy "tool_connection_grants_update"
  on public.tool_connection_grants for update
  using (public.can_write_in_workspace(workspace_id))
  with check (
    public.can_write_in_workspace(workspace_id)
    and public.can_edit_agent(agent_id)
    and (mode <> 'always' or public.is_workspace_admin(workspace_id))
    and exists (
      select 1 from public.tool_connections c
       where c.id = tool_connection_grants.tool_connection_id
         and c.workspace_id = tool_connection_grants.workspace_id)
  );

-- Standing permissions are read where the agent is. A grant says what an agent
-- may do; on an agent you cannot see, it is a description of somebody else's
-- agent. Revoking stays open to every writer, as above.
drop policy if exists "connection_grants_read" on public.connection_grants;
create policy "connection_grants_read"
  on public.connection_grants for select
  using (public.is_workspace_member(workspace_id) and public.can_use_agent(agent_id));

drop policy if exists "tool_connection_grants_read" on public.tool_connection_grants;
create policy "tool_connection_grants_read"
  on public.tool_connection_grants for select
  using (public.is_workspace_member(workspace_id) and public.can_use_agent(agent_id));

-- A call waiting for a yes carries what the agent was about to send, and the
-- yes is what sends it. Both belong to the people who can use the agent — the
-- person in the conversation is who answers, which is why use and not edit.
-- `agent_id` is set null when an agent is purged, and a call with no agent
-- left is the workspace's record, as before.
drop policy if exists "capability_calls_read" on public.capability_calls;
create policy "capability_calls_read"
  on public.capability_calls for select
  using (
    public.is_workspace_member(workspace_id)
    and (agent_id is null or public.can_use_agent(agent_id))
  );

drop policy if exists "capability_calls_decide" on public.capability_calls;
create policy "capability_calls_decide"
  on public.capability_calls for update
  using (
    status = 'pending'
    and public.can_write_in_workspace(workspace_id)
    and (agent_id is null or public.can_use_agent(agent_id))
  )
  with check (
    status in ('approved', 'refused')
    and public.can_write_in_workspace(workspace_id)
    and (agent_id is null or public.can_use_agent(agent_id))
  );

-- ===========================================================================
-- 6. deleting, restoring, and the trash
-- ===========================================================================
--
-- Deleting an agent takes its conversations and routines with it, so it is a
-- `manage` decision rather than a workspace-writer one. An agent the caller
-- cannot see answers the same as one that does not exist.

create or replace function public.soft_delete_agent(p_agent_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_workspace_id uuid;
  v_now timestamptz := now();
  v_actor uuid := auth.uid();
  v_access text;
begin
  select workspace_id into v_workspace_id
  from public.agents
  where id = p_agent_id and deleted_at is null;

  v_access := public.agent_access(p_agent_id);

  if v_workspace_id is null or v_access is null then
    raise exception 'no such agent' using errcode = 'P0002';
  end if;

  if v_access <> 'manage' then
    raise exception 'you cannot delete this agent' using errcode = '42501';
  end if;

  update public.agents
     set deleted_at = v_now, deleted_by = v_actor, deleted_via = null
   where id = p_agent_id;

  update public.chat_sessions
     set deleted_at = v_now, deleted_via = p_agent_id
   where agent_id = p_agent_id and deleted_at is null;

  update public.routines
     set deleted_at = v_now, deleted_via = p_agent_id
   where agent_id = p_agent_id and deleted_at is null;
end $$;

create or replace function public.restore_agent(p_agent_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_workspace_id uuid;
  v_access text;
begin
  select workspace_id into v_workspace_id
  from public.agents
  where id = p_agent_id and deleted_at is not null;

  v_access := public.agent_access(p_agent_id);

  if v_workspace_id is null or v_access is null then
    raise exception 'no such deleted agent' using errcode = 'P0002';
  end if;

  if v_access <> 'manage' then
    raise exception 'you cannot restore this agent' using errcode = '42501';
  end if;

  update public.agents
     set deleted_at = null, deleted_by = null, deleted_via = null
   where id = p_agent_id;

  update public.chat_sessions
     set deleted_at = null, deleted_via = null
   where deleted_via = p_agent_id;

  update public.routines
     set deleted_at = null, deleted_via = null
   where deleted_via = p_agent_id;
end $$;

-- The trash lists a deleted agent only to somebody who could restore it.
create or replace function public.workspace_trash(p_workspace_id uuid)
returns table (
  kind          text,
  id            uuid,
  name          text,
  deleted_at    timestamptz,
  deleted_by_id uuid,
  deleted_by_name text,
  parent_name   text
)
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
begin
  if not public.can_write_in_workspace(p_workspace_id) then
    raise exception 'you cannot see this workspace''s deleted items'
      using errcode = '42501';
  end if;

  return query
    select 'agent'::text, a.id, a.name, a.deleted_at, a.deleted_by,
           coalesce(p.name, p.email), null::text
      from public.agents a
      left join public.profiles p on p.id = a.deleted_by
     where a.workspace_id = p_workspace_id
       and a.deleted_at is not null
       and a.deleted_via is null
       and public.can_manage_agent(a.id)
    union all
    select 'bundle'::text, b.id, b.name, b.deleted_at, b.deleted_by,
           coalesce(p.name, p.email), null::text
      from public.knowledge_bundles b
      left join public.profiles p on p.id = b.deleted_by
     where b.workspace_id = p_workspace_id
       and b.deleted_at is not null
       and b.deleted_via is null
    union all
    select 'document'::text, d.id, d.name, d.deleted_at, d.deleted_by,
           coalesce(p.name, p.email), b.name
      from public.documents d
      join public.knowledge_bundles b on b.id = d.bundle_id
      left join public.profiles p on p.id = d.deleted_by
     where b.workspace_id = p_workspace_id
       and d.deleted_at is not null
       and d.deleted_via is null
    order by 4 desc;
end $$;

-- `create or replace` keeps these grants; restated so this file reads whole.
revoke all on function public.soft_delete_agent(uuid) from public, anon;
grant execute on function public.soft_delete_agent(uuid) to authenticated, service_role;
revoke all on function public.restore_agent(uuid) from public, anon;
grant execute on function public.restore_agent(uuid) to authenticated, service_role;
revoke all on function public.workspace_trash(uuid) from public, anon;
grant execute on function public.workspace_trash(uuid) to authenticated, service_role;
revoke all on function public.session_is_visible(uuid) from public, anon;
grant execute on function public.session_is_visible(uuid) to authenticated, service_role;
