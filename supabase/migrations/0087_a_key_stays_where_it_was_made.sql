-- A key stays where it was made: a request made with an API key reaches the
-- workspace the key belongs to, and no other.
--
-- `api_keys.workspace_id` has been recorded since 0033 and read by nothing. A
-- key authenticates as its owner, so it reached every workspace the owner was
-- in: the API resolved "which workspace" from the owner's profile, and
-- switching it was one more request. A key made for one team's nightly script
-- was, in practice, a key to all of them.
--
-- The API now answers "which workspace" with the key's own for a key request.
-- That covers the routes that ask. It does not cover the ones that take an id
-- -- a document, a session, an export -- and simply read through the caller's
-- client, trusting RLS to say no. RLS said yes: the owner IS a member over
-- there. So the database has to know which workspace a request is held to,
-- and the token tells it. A key request runs on a token the API mints, and
-- that token carries the workspace as a claim, `covan_ws`. A browser session's
-- token from GoTrue never carries one.
--
-- `request_workspace()` reads the claim. Two layers use it:
--
--   1. The membership helpers. `is_workspace_member`, `can_write_in_workspace`
--      and `is_workspace_admin` answer "no" for any workspace but the claim's,
--      and `shares_workspace` looks only there. Nearly every policy, and every
--      definer function that checks standing, asks one of these -- so this
--      alone holds most of the schema.
--
--   2. A restrictive policy on every workspace table. Some policies never ask
--      a helper: "your own rows" is `user_id = auth.uid()` on delivery
--      channels, routines, routine runs, API keys, coverage opt-outs. Those
--      rows are the owner's in every workspace. A restrictive policy is ANDed
--      with whatever permissive ones a table has, so it holds the table to
--      the claim regardless of how its own policies are written, today or
--      after somebody adds one.
--
-- With no claim -- every browser session, and anything the service role does,
-- which bypasses RLS anyway -- `request_workspace()` is null and none of this
-- changes an answer. The claim is read through `(select ...)` so Postgres
-- evaluates it once per statement rather than once per row.
--
-- Tables with no workspace of their own (a person's profile, onboarding,
-- notification preferences) are not scoped: they belong to the owner, not to
-- any one workspace.

-- ---- the claim ---------------------------------------------------------------

-- Not `security definer` and no `set search_path`: it reads a setting through
-- built-ins only, and a plain SQL function can be inlined into the policies
-- that call it.
create or replace function public.request_workspace()
returns uuid
language sql
stable
as $$
  select nullif(
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb
      ->> 'covan_ws',
    ''
  )::uuid
$$;

-- ---- 1. the membership helpers -----------------------------------------------
--
-- Same signatures, same attributes, same grants (`create or replace` keeps
-- them). The only change in each is the first line of the body.

create or replace function public.is_workspace_member(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select (public.request_workspace() is null or public.request_workspace() = p_workspace_id)
     and exists (
       select 1
       from public.workspace_members wm
       where wm.workspace_id = p_workspace_id
         and wm.user_id = auth.uid()
     );
$$;

create or replace function public.can_write_in_workspace(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select (public.request_workspace() is null or public.request_workspace() = p_workspace_id)
     and exists (
       select 1
       from public.workspace_members wm
       where wm.workspace_id = p_workspace_id
         and wm.user_id = auth.uid()
         and wm.role <> 'viewer'
     );
$$;

create or replace function public.is_workspace_admin(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select (public.request_workspace() is null or public.request_workspace() = p_workspace_id)
     and exists (
       select 1
       from public.workspace_members wm
       where wm.workspace_id = p_workspace_id
         and wm.user_id = auth.uid()
         and wm.role = 'admin'
     );
$$;

-- A key sees the profiles of the people in its own workspace, not of everybody
-- its owner has ever shared a workspace with.
create or replace function public.shares_workspace(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.workspace_members me
    join public.workspace_members them on them.workspace_id = me.workspace_id
    where me.user_id = auth.uid()
      and them.user_id = p_user
      and (public.request_workspace() is null or me.workspace_id = public.request_workspace())
  );
$$;

-- ---- 2. one restrictive policy per workspace table ---------------------------

-- Tables that carry `workspace_id` themselves.
do $$
declare
  t text;
begin
  foreach t in array array[
    'agents', 'api_keys', 'browser_credentials', 'browser_sessions',
    'browser_takeovers', 'browser_tasks', 'capability_calls', 'chat_sessions',
    'connection_grants', 'connections', 'coverage_opt_outs', 'delivery_channels',
    'document_chunks', 'feedback', 'ideas', 'invitations', 'knowledge_bundles',
    'paused_turns', 'routines', 'slack_installations', 'tool_connection_grants',
    'tool_connections', 'workspace_events', 'workspace_members'
  ] loop
    execute format('drop policy if exists %I on public.%I', t || '_request_workspace', t);
    execute format(
      'create policy %I on public.%I as restrictive for all to authenticated '
      'using ((select public.request_workspace()) is null '
      'or workspace_id = (select public.request_workspace()))',
      t || '_request_workspace', t);
  end loop;
end $$;

-- The workspace row itself.
drop policy if exists workspaces_request_workspace on public.workspaces;
create policy workspaces_request_workspace on public.workspaces
  as restrictive for all to authenticated
  using ((select public.request_workspace()) is null
         or id = (select public.request_workspace()));

-- Tables that reach a workspace through the row they hang off. The parent is
-- read through the caller's own policies, which is the point: a child is in
-- scope when its parent is.
drop policy if exists agent_bundles_request_workspace on public.agent_bundles;
create policy agent_bundles_request_workspace on public.agent_bundles
  as restrictive for all to authenticated
  using ((select public.request_workspace()) is null or exists (
    select 1 from public.agents a
     where a.id = agent_bundles.agent_id
       and a.workspace_id = (select public.request_workspace())));

drop policy if exists favorites_request_workspace on public.favorites;
create policy favorites_request_workspace on public.favorites
  as restrictive for all to authenticated
  using ((select public.request_workspace()) is null or exists (
    select 1 from public.agents a
     where a.id = favorites.agent_id
       and a.workspace_id = (select public.request_workspace())));

drop policy if exists connection_runs_request_workspace on public.connection_runs;
create policy connection_runs_request_workspace on public.connection_runs
  as restrictive for all to authenticated
  using ((select public.request_workspace()) is null or exists (
    select 1 from public.connections c
     where c.id = connection_runs.connection_id
       and c.workspace_id = (select public.request_workspace())));

drop policy if exists documents_request_workspace on public.documents;
create policy documents_request_workspace on public.documents
  as restrictive for all to authenticated
  using ((select public.request_workspace()) is null or exists (
    select 1 from public.knowledge_bundles b
     where b.id = documents.bundle_id
       and b.workspace_id = (select public.request_workspace())));

drop policy if exists messages_request_workspace on public.messages;
create policy messages_request_workspace on public.messages
  as restrictive for all to authenticated
  using ((select public.request_workspace()) is null or exists (
    select 1 from public.chat_sessions s
     where s.id = messages.session_id
       and s.workspace_id = (select public.request_workspace())));

drop policy if exists message_steps_request_workspace on public.message_steps;
create policy message_steps_request_workspace on public.message_steps
  as restrictive for all to authenticated
  using ((select public.request_workspace()) is null or exists (
    select 1 from public.messages m
      join public.chat_sessions s on s.id = m.session_id
     where m.id = message_steps.message_id
       and s.workspace_id = (select public.request_workspace())));

drop policy if exists routine_runs_request_workspace on public.routine_runs;
create policy routine_runs_request_workspace on public.routine_runs
  as restrictive for all to authenticated
  using ((select public.request_workspace()) is null or exists (
    select 1 from public.routines r
     where r.id = routine_runs.routine_id
       and r.workspace_id = (select public.request_workspace())));

drop policy if exists routine_triggers_request_workspace on public.routine_triggers;
create policy routine_triggers_request_workspace on public.routine_triggers
  as restrictive for all to authenticated
  using ((select public.request_workspace()) is null or exists (
    select 1 from public.routines r
     where r.id = routine_triggers.routine_id
       and r.workspace_id = (select public.request_workspace())));

drop policy if exists slack_threads_request_workspace on public.slack_threads;
create policy slack_threads_request_workspace on public.slack_threads
  as restrictive for all to authenticated
  using ((select public.request_workspace()) is null or exists (
    select 1 from public.slack_installations i
     where i.id = slack_threads.installation_id
       and i.workspace_id = (select public.request_workspace())));
