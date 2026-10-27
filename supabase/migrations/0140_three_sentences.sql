-- =========================================================================
-- Three sentences
--
-- What an agent may do in an application somebody connected, said the way the
-- card, the Integrations page, a routine's page and the docs now all say it:
--
--   1. An app you connected, agents read through. They never ask to read, in
--      a conversation or on a schedule. (The worker decides what a read is:
--      an operation the catalogue positively marks non-destructive.)
--   2. Changing something asks, unless you said "don't ask again" for that
--      app. On a schedule a change happens only with that said.
--   3. The person who connected it decides for their own connection; an admin
--      for a shared one. A viewer never changes anything.
--
-- `tool_connection_grants` is the second sentence. Until now it held one row
-- per agent, connection AND operation, with a mode of `ask` or `always`, and
-- only an admin could write `always` (0063). Nobody could hold that in their
-- head, and the routine that needed it most — one running at 3am with nobody
-- to ask — had no screen that offered it. Now a row is one switch:
--
--   a row      this agent may change things in this connection without asking
--   no row     it asks first; on a schedule it does not change anything there
--
-- So `slug` and `mode` go and the key becomes (agent_id, tool_connection_id).
-- The rows already here were per operation and are deleted rather than
-- widened: a yes to one operation is not a yes to every operation in the app,
-- and the person is asked again, once, the next time it matters.
--
-- WHO MAY ADD ONE is the third sentence, in the insert policy: someone who can
-- edit the agent, and who either made the connection or, for a shared one, is
-- an admin. Any writer who can edit the agent may take one away — stopping the
-- agent from acting unasked is never the riskier direction. There is nothing
-- to update: a row exists or it does not.
--
-- AND 0058 GOES. `connection_capabilities`, `connection_grants`,
-- `capability_calls` and `record_capability_call` were the first design of
-- this table, kept in the schema and in the tests and read by nothing in the
-- worker. They are dropped here with their trigger functions.
-- =========================================================================

-- ---- 1. the rows that were per operation ----------------------------------
delete from public.tool_connection_grants;

-- ---- 2. one row per agent and connection ----------------------------------
-- The old insert and update policies read `mode`, so they go before it does;
-- section 3 writes the new ones.
drop policy if exists "tool_connection_grants_insert" on public.tool_connection_grants;
drop policy if exists "tool_connection_grants_update" on public.tool_connection_grants;
alter table public.tool_connection_grants
  drop constraint if exists tool_connection_grants_pkey;
alter table public.tool_connection_grants drop column if exists slug;
alter table public.tool_connection_grants drop column if exists mode;
alter table public.tool_connection_grants
  add constraint tool_connection_grants_pkey primary key (agent_id, tool_connection_id);

comment on table public.tool_connection_grants is
  'A row: this agent may change things in this connection without asking. '
  'No row: it asks first, and on a schedule it does not change anything there. '
  'Reads never ask and need no row. Added by whoever connected it, or an admin '
  'for a shared connection (0140).';

-- The stamp trigger stays (0063), now on insert only, since there is no update.
drop trigger if exists trg_tool_connection_grants_stamp on public.tool_connection_grants;
create trigger trg_tool_connection_grants_stamp
  before insert on public.tool_connection_grants
  for each row
  execute function public.tool_connection_grants_stamp();

-- ---- 3. policies ------------------------------------------------------------
drop policy if exists "tool_connection_grants_read" on public.tool_connection_grants;
create policy "tool_connection_grants_read"
  on public.tool_connection_grants for select
  using (public.is_workspace_member(workspace_id) and public.can_use_agent(agent_id));

drop policy if exists "tool_connection_grants_insert" on public.tool_connection_grants;
create policy "tool_connection_grants_insert"
  on public.tool_connection_grants for insert
  with check (
    public.can_write_in_workspace(workspace_id)
    and public.can_edit_agent(agent_id)
    and exists (
      select 1 from public.tool_connections c
       where c.id = tool_connection_grants.tool_connection_id
         and c.workspace_id = tool_connection_grants.workspace_id
         and (
           c.created_by = auth.uid()
           or (c.scope = 'workspace' and public.is_workspace_admin(c.workspace_id))
         ))
  );

drop policy if exists "tool_connection_grants_delete" on public.tool_connection_grants;
create policy "tool_connection_grants_delete"
  on public.tool_connection_grants for delete
  using (public.can_write_in_workspace(workspace_id) and public.can_edit_agent(agent_id));

-- ---- 4. grants ----------------------------------------------------------------
--
-- `granted_by` stays insertable because the trigger overwrites it with the
-- caller; it is never trusted as sent. The engine reads, and never writes one:
-- a standing permission is a person's decision.
revoke all on public.tool_connection_grants from anon, authenticated;
grant select, delete on public.tool_connection_grants to authenticated;
grant insert (agent_id, tool_connection_id, workspace_id, granted_by)
  on public.tool_connection_grants to authenticated;
grant select on public.tool_connection_grants to service_role;

-- ---- 5. 0058, which nothing reads -----------------------------------------
drop function if exists public.record_capability_call(uuid, uuid, text, jsonb, uuid);
drop table if exists public.capability_calls;
drop table if exists public.connection_grants;
drop table if exists public.connection_capabilities;
drop function if exists public.capability_calls_stamp_decision();
drop function if exists public.connection_grants_stamp();
