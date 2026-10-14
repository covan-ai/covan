-- A connection is its owner's: a connected service is personal unless the
-- person who connected it shares it with the workspace.
--
-- A `tool_connections` row was readable by every member (0059's
-- `tool_connections_read`), and what the agent can reach is what the caller's
-- client can read. So somebody's Gmail, connected for themselves, was an
-- agent tool for every member of the workspace — a viewer included, who could
-- ask the agent to send from it and approve the card themselves. Saved
-- browser logins already work the other way (0079): personal by default,
-- shared on purpose. This gives connected services the same shape.
--
--   scope   'owner'      only the person who connected it (`created_by`) sees
--                        it, and only their agents' turns can use it.
--           'workspace'  every member sees it and their turns can use it, as
--                        every connection could before.
--
-- Existing rows: a connected application (transport 'composio' — Gmail,
-- Slack, a calendar) is somebody's own account and becomes 'owner'; an HTTP
-- API or a database (transport 'http' / 'sql') is configured with a service's
-- key for the team and stays 'workspace'. The person who connected an
-- application can share it again from the Integrations page in one click.
--
-- Labels were unique per workspace. Two people connecting their own Gmail
-- would both be called "gmail", so a personal label is unique per person and
-- a shared one per workspace.
--
-- `tool_connection_grants` — "this agent may always run X on this connection"
-- — can now only be written for a connection the writer can see, so nobody can
-- pre-approve operations on somebody else's personal account.

alter table public.tool_connections
  add column if not exists scope text not null default 'owner';

alter table public.tool_connections drop constraint if exists tool_connections_scope_check;
alter table public.tool_connections
  add constraint tool_connections_scope_check check (scope in ('owner', 'workspace'));

update public.tool_connections set scope = 'workspace' where transport in ('http', 'sql');

drop index if exists public.tool_connections_label_idx;
create unique index if not exists tool_connections_shared_label_idx
  on public.tool_connections (workspace_id, lower(btrim(label)))
  where scope = 'workspace';
create unique index if not exists tool_connections_own_label_idx
  on public.tool_connections (workspace_id, created_by, lower(btrim(label)))
  where scope = 'owner';

drop policy if exists "tool_connections_read" on public.tool_connections;
create policy "tool_connections_read"
  on public.tool_connections for select
  using (
    public.is_workspace_member(workspace_id)
    and (scope = 'workspace' or created_by = auth.uid())
  );

-- An admin keeps the say over shared rows (rename, remove) and has none over
-- a personal one, which they cannot see. Only a row's own creator can share it
-- or take it back: nobody else can reach a personal row, and an admin's update
-- to 'owner' would leave a row the admin may not read, which Postgres refuses.
drop policy if exists "tool_connections_update" on public.tool_connections;
create policy "tool_connections_update"
  on public.tool_connections for update
  using (
    created_by = auth.uid()
    or (scope = 'workspace' and public.is_workspace_admin(workspace_id))
  )
  with check (
    (created_by = auth.uid() or public.is_workspace_admin(workspace_id))
    and public.can_write_in_workspace(workspace_id)
  );

drop policy if exists "tool_connections_delete" on public.tool_connections;
create policy "tool_connections_delete"
  on public.tool_connections for delete
  using (
    created_by = auth.uid()
    or (scope = 'workspace' and public.is_workspace_admin(workspace_id))
  );

grant select (scope) on public.tool_connections to authenticated;
grant update (scope) on public.tool_connections to authenticated;

-- A standing approval only for a connection the writer can see: their own, or
-- one shared with the workspace. The subquery runs through the writer's own
-- policies, which is the point.
drop policy if exists "tool_connection_grants_insert" on public.tool_connection_grants;
create policy "tool_connection_grants_insert"
  on public.tool_connection_grants for insert
  with check (
    public.can_write_in_workspace(workspace_id)
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
    and (mode <> 'always' or public.is_workspace_admin(workspace_id))
    and exists (
      select 1 from public.tool_connections c
       where c.id = tool_connection_grants.tool_connection_id
         and c.workspace_id = tool_connection_grants.workspace_id)
  );
