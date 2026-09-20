-- =========================================================================
-- No row means no
--
-- A place to write down what an agent is allowed to DO at a third party, as
-- opposed to what a person is allowed to see in Postgres. Three tables, one
-- function, and — deliberately — nothing that uses any of them yet.
--
-- WHY THE SCHEMA SHIPS BEFORE THE FEATURE. Two decisions here are the kind
-- that cannot be walked back later: the key a grant hangs off, and what the
-- absence of a grant means. The second one especially. Changing a default from
-- deny to ask is not a migration, it is a conversation with every customer
-- about which of their agents just gained a permission, and the only moment
-- that conversation is free is before anybody has a grant at all.
--
-- Everything else here is inert by construction. `connection_grants` starts
-- empty, an empty grants table means every capability is `never`, and `never`
-- is a bit-exact description of what Covan does today: agents read, and that is
-- the whole list. There is no behaviour to regress because there is no
-- behaviour. The catalogue starts empty too, which is stronger still — with no
-- rows in `connection_capabilities` a grant cannot be inserted at all, because
-- the foreign key has nothing to point at. A capability becomes grantable in
-- the same migration as the code that performs it, never before.
--
-- WHY THIS IS NOT A SECOND PERMISSION SYSTEM, which is the objection
-- `docs/api.md` raises against API scopes and answers with "there are none".
-- That answer is right and it does not apply here. A scope re-answers a
-- question row level security has already answered — may this person write —
-- and two systems answering the same question can disagree, which is why the
-- API has no scopes. A capability answers a question that cannot be put to RLS
-- at all. Every policy in this schema gates on `auth.uid()`; the sentence here
-- is "may this AGENT perform this action at Notion", and it has no `auth.uid()`
-- in it. The actor is an agent, the hour is 3am, the object is not in Postgres
-- and the verb is not select, insert, update or delete. The two cannot
-- contradict each other because they are not about the same thing.
--
-- And every HUMAN action in this feature is still policy-governed, because
-- every one of them is a person changing a row: who can see a grant
-- (`is_workspace_member`), who can create one (`can_write_in_workspace`), who
-- can promote one to `always` on a destructive capability
-- (`is_workspace_admin`), who can answer a pending call. The only thing without
-- a policy is a caller-less process evaluating those rows at 3am, and the house
-- pattern for that already exists: one SECURITY DEFINER function, revoked from
-- PUBLIC, granted to service_role — `claim_due_connections`, with the grant
-- itself as the security boundary.
-- =========================================================================

-- ---- the catalogue --------------------------------------------------------
--
-- What this build of Covan knows how to do at each provider. Install-level
-- reference data rather than workspace content: two installs of the same
-- version have identical catalogues, and a row here is a claim that some code
-- in this repository can carry the action out.
--
-- It is empty on purpose. Seeding `notion.create_page` today would put a
-- sentence in a table that no code can honour, and the first thing built on top
-- of it would be a screen offering a permission that does nothing. Each row
-- arrives with its implementation.
create table if not exists public.connection_capabilities (
  -- Which provider the action belongs to. Matches `connections.provider`, and
  -- the foreign keys below make that match structural rather than hoped for.
  provider text not null check (provider in ('notion', 'google_drive')),
  -- Dotted and provider-qualified: `notion.append_block`, not `append_block`.
  -- The qualification is not decoration; it is what keeps the name readable in
  -- an audit row that has been detached from its connection.
  capability text not null,
  -- For a person, in the sentence a grant screen would print.
  label text not null,
  description text not null,
  -- Whether performing this can destroy or publish something that cannot be
  -- taken back: deleting a page, sending mail, posting to a channel. Read by
  -- the grant policy below, which is why it lives in the database rather than
  -- in a TypeScript constant — a policy cannot import a module.
  --
  -- Defaults to true. A capability whose author did not think about this
  -- question is treated as the dangerous kind.
  is_destructive boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (provider, capability)
);

comment on table public.connection_capabilities is
  'What this build of Covan can do at each provider. Install-level reference data, populated by the migration that ships each capability''s implementation. Empty means no capability can be granted at all, because connection_grants has nothing to reference.';

alter table public.connection_capabilities enable row level security;

-- Readable by anyone signed in: it is a list of features, not of secrets, and a
-- screen offering permissions has to be able to name them. Writable by nobody —
-- there is no insert, update or delete policy, so the only way a row arrives is
-- a migration or the service role.
drop policy if exists "connection_capabilities_read" on public.connection_capabilities;
create policy "connection_capabilities_read"
  on public.connection_capabilities for select
  using (true);

revoke all on public.connection_capabilities from anon, authenticated;
grant select on public.connection_capabilities to authenticated;
-- `service_role` is BYPASSRLS, not BYPASSGRANTS, and 0023 took the wide default
-- privileges away from it too — so the engine reading this catalogue to find
-- out whether a capability is destructive gets `42501` unless it is said here.
-- Read only, on purpose: the whole point of the catalogue is that a capability
-- arrives with the code that performs it, in a migration, and an engine that
-- could add a row could describe an action nothing implements.
grant select on public.connection_capabilities to service_role;

-- ---- the grants -----------------------------------------------------------
--
-- THE KEY, which is the decision this migration exists to make.
-- `(agent_id, connection_id, capability)`. Not per workspace, because "everyone
-- here may send mail" is not a thing anybody means; not per person, because the
-- actor at 3am is not a person; not per routine, because the same agent is
-- asked the same thing from chat, from Slack and from a schedule, and a
-- permission that changes with the doorway is a permission nobody can reason
-- about. An agent is the unit a person configures, names and trusts.
--
-- THE DEFAULT. `mode` has two values, `ask` and `always`. There is no `never` —
-- `never` is the absence of a row, and the check constraint is what stops it
-- from becoming a third, storable way of saying no. Two representations of no
-- is one representation too many: they can disagree, and then some code has to
-- decide which one wins at the worst possible moment. One rule instead: no row
-- means no.
--
-- Tasklet assumes `ask`, which is the right default for a product whose agents
-- already act. Ours do not, so the absence of a row has to keep meaning exactly
-- what it means today.
create table if not exists public.connection_grants (
  agent_id uuid not null,
  connection_id uuid not null,
  provider text not null,
  capability text not null,
  -- Denormalised from the agent and the connection, and constrained below to
  -- agree with both. It is here so the policies can be written the way every
  -- other policy in this schema is written, and so an export scoped by
  -- workspace has a column to scope by.
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  -- `ask`: produce a pending approval and stop. `always`: the approval was
  -- given in advance, which is the whole of what `always` means.
  mode text not null check (mode in ('ask', 'always')),
  -- Stamped by the trigger below rather than accepted from the client, so the
  -- record of who granted a permission cannot be written by somebody else.
  granted_by uuid references auth.users (id) on delete set null,
  granted_at timestamptz not null default now(),
  primary key (agent_id, connection_id, capability)
);

comment on table public.connection_grants is
  'Which agent may do what, at which connected source. A missing row means never - that is the default and the only way to express it. Empty table means Covan behaves exactly as it does without this feature.';

comment on column public.connection_grants.mode is
  'ask | always. There is no never: never is the absence of a row. always means the approval was given in advance.';

-- ---- the constraints that make a cross-tenant grant impossible ------------
--
-- Not merely disallowed — impossible. The distinction matters more here than
-- anywhere else in this schema, because the process that reads these rows is
-- the service role, and the service role bypasses row level security entirely.
-- A policy is the boundary when a person writes a row; it is no boundary at all
-- when a caller-less function at 3am asks "does a grant exist". So the fact
-- that a grant cannot join an agent in one workspace to a connection in another
-- has to be a constraint, not a predicate.
--
-- 0056 learned the first half of this lesson about `routines.output_bundle_id`
-- and answered it with a policy, which was right because the write it defends
-- against is a person's. This is the other half: the read is not a person's.
--
-- Two composite references do it. The agent's workspace and the connection's
-- workspace are both forced to equal this row's `workspace_id`, and the
-- connection's provider is forced to equal this row's `provider`, which in turn
-- has to name a capability that exists for that provider. Chain them and a
-- Notion capability cannot be granted on a Drive connection, in a workspace
-- neither of them is in, by any writer including the service role.
--
-- Both targets need a unique constraint Postgres can point a composite key at.
-- They are redundant as uniqueness claims — `id` is already a primary key — and
-- that redundancy is the price of the guarantee.
alter table public.agents
  drop constraint if exists agents_id_workspace_key;
alter table public.agents
  add constraint agents_id_workspace_key unique (id, workspace_id);

alter table public.connections
  drop constraint if exists connections_id_workspace_provider_key;
alter table public.connections
  add constraint connections_id_workspace_provider_key unique (id, workspace_id, provider);

alter table public.connection_grants
  drop constraint if exists connection_grants_agent_fkey;
alter table public.connection_grants
  add constraint connection_grants_agent_fkey
  foreign key (agent_id, workspace_id)
  references public.agents (id, workspace_id) on delete cascade;

alter table public.connection_grants
  drop constraint if exists connection_grants_connection_fkey;
alter table public.connection_grants
  add constraint connection_grants_connection_fkey
  foreign key (connection_id, workspace_id, provider)
  references public.connections (id, workspace_id, provider) on delete cascade;

-- `restrict` rather than `cascade`: removing a capability from the catalogue is
-- something a future migration does when this build stops implementing an
-- action, and it should have to say out loud what happens to the permissions
-- somebody granted. A silent cascade would revoke them without a record.
alter table public.connection_grants
  drop constraint if exists connection_grants_capability_fkey;
alter table public.connection_grants
  add constraint connection_grants_capability_fkey
  foreign key (provider, capability)
  references public.connection_capabilities (provider, capability) on delete restrict;

-- Postgres does not index a foreign key for you, and both of these are read in
-- the direction the primary key does not serve: "everything this connection has
-- been granted for" is the grant screen, "everything in this workspace" is the
-- audit.
create index if not exists connection_grants_connection_idx
  on public.connection_grants (connection_id);
create index if not exists connection_grants_workspace_idx
  on public.connection_grants (workspace_id);

-- ---- who granted it -------------------------------------------------------
--
-- 0037's pattern, for 0037's reason. `authenticated` holds a table-level insert
-- and update below, so `granted_by` accepted from the client is a column any
-- writer could fill with a colleague's id — on a row that records who handed an
-- agent a standing permission. `granted_at` has the same problem in the other
-- direction: an update that raises `ask` to `always` and leaves the original
-- timestamp produces a record that is true about a grant nobody has any more.
--
-- The trigger stamps both on every write, so the row always describes the write
-- that produced it. A service-role write leaves `granted_by` null, which is
-- honest: nobody in particular did it.
-- Not `security definer`: it writes only the row in front of it, from the
-- caller's own uid. The search path is pinned anyway, for 0037's reason — a
-- function reachable from a request should not resolve names through whatever
-- the caller set.
create or replace function public.connection_grants_stamp()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  new.granted_by := auth.uid();
  new.granted_at := now();
  return new;
end;
$$;

drop trigger if exists trg_connection_grants_stamp on public.connection_grants;
create trigger trg_connection_grants_stamp
  before insert or update on public.connection_grants
  for each row
  execute function public.connection_grants_stamp();

-- ---- policies on the grants ----------------------------------------------
alter table public.connection_grants enable row level security;

drop policy if exists "connection_grants_read" on public.connection_grants;
create policy "connection_grants_read"
  on public.connection_grants for select
  using (public.is_workspace_member(workspace_id));

-- Granting is writing. The extra clause is the one rule that needs a role above
-- writer: promoting a DESTRUCTIVE capability to `always` removes the asking
-- forever, and "this agent may delete pages without telling anyone" is a
-- decision about the workspace rather than about one piece of work.
--
-- `ask` on the same capability is open to any writer, because an agent that
-- stops and asks cannot do anything a person did not just approve.
drop policy if exists "connection_grants_insert" on public.connection_grants;
create policy "connection_grants_insert"
  on public.connection_grants for insert
  with check (
    public.can_write_in_workspace(workspace_id)
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

-- The `using` clause is deliberately the plain write check, without the
-- destructive rule, and the asymmetry is the point: a writer who cannot raise a
-- grant to `always` must still be able to lower one from it. Putting the admin
-- rule in `using` too would mean the only people who could take a dangerous
-- standing permission away were the people who could give it, which gets the
-- direction of caution exactly backwards.
drop policy if exists "connection_grants_update" on public.connection_grants;
create policy "connection_grants_update"
  on public.connection_grants for update
  using (public.can_write_in_workspace(workspace_id))
  with check (
    public.can_write_in_workspace(workspace_id)
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

-- Revoking is deleting, and it is open to every writer for the same reason.
-- Taking a permission away can never be the unsafe direction.
drop policy if exists "connection_grants_delete" on public.connection_grants;
create policy "connection_grants_delete"
  on public.connection_grants for delete
  using (public.can_write_in_workspace(workspace_id));

revoke all on public.connection_grants from anon, authenticated;
grant select, insert, update, delete on public.connection_grants to authenticated;
-- Read only for the engine, and this one is worth saying out loud rather than
-- being generous by habit. A grant is a person's decision; nothing unattended
-- has any business creating one, and an engine that could would be the exact
-- failure this whole file is written against. The reading it does do is real:
-- which capabilities an agent may be offered is a question asked at 3am.
grant select on public.connection_grants to service_role;

-- ---- the calls ------------------------------------------------------------
--
-- Every attempt an agent makes, including the refused ones. The refused ones
-- especially: a default of deny is only humane if a person can find out that it
-- said no. Otherwise the first symptom of a missing grant is an agent that
-- quietly does not do the thing, which is indistinguishable from an agent that
-- did not think of it.
--
-- This is also the approval queue. A call in `pending` IS the pending
-- approval — there is no second table for that — which is what makes "ask" at
-- 3am implementable: the run records the request and ends, rather than waiting
-- for somebody who is asleep. Waiting was considered and does not survive
-- contact with the engine: a tick has nowhere to wait, and a claim goes stale
-- after thirty minutes and is handed out again, so "wait" becomes "run the
-- same thing repeatedly". Silently falling back to `never` while unattended was
-- the other candidate, and it makes the same agent with the same permission
-- behave differently depending on the hour.
create table if not exists public.capability_calls (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  -- Nullable and `set null`, unlike the grants: this is a record of something
  -- that happened, and it has to survive the agent being deleted the way
  -- 0016's six foreign keys survive a person closing their account. The
  -- provider and capability are copied for the same reason — they still read
  -- correctly when everything they pointed at is gone.
  agent_id uuid references public.agents (id) on delete set null,
  connection_id uuid references public.connections (id) on delete set null,
  provider text not null,
  capability text not null,
  -- Which grant produced this, as it stood at the moment of the call. Null
  -- means there was no grant, and the check below makes that the only way a
  -- call can be denied.
  mode text check (mode in ('ask', 'always')),
  status text not null check (status in (
    -- No grant. Terminal, and recorded so somebody can see it.
    'denied',
    -- `ask`, and nobody has answered yet.
    'pending',
    -- A person said no.
    'refused',
    -- Cleared to go: either a person said yes, or `always` said it in advance.
    -- One status for both, because the caller's next step is identical and a
    -- second one would only invite code that treats them differently.
    'approved',
    -- Done, at the third party.
    'performed',
    -- Attempted and the third party refused.
    'failed'
  )),
  -- No grant, no action. The invariant this whole migration is built around,
  -- stated where the database can enforce it: a call with no grant behind it
  -- has exactly one possible outcome.
  constraint capability_calls_no_row_means_no check (mode is not null or status = 'denied'),
  -- What the agent proposed to do, as arguments. Workspace content: the body of
  -- the message it wanted to send is the thing a person needs to read before
  -- approving.
  request jsonb not null default '{}'::jsonb,
  -- Which unattended run made the call. Null by elimination means somebody was
  -- watching — a chat, a Slack thread — which is the distinction that decides
  -- whether `ask` can be answered on the spot.
  routine_run_id uuid references public.routine_runs (id) on delete set null,
  -- Stamped by the trigger below, never accepted from the client.
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz,
  performed_at timestamptz,
  error text,
  created_at timestamptz not null default now()
);

comment on table public.capability_calls is
  'Every action an agent attempted at a third party, including the ones refused for want of a grant. A row in pending IS a pending approval; there is no separate queue.';

create index if not exists capability_calls_workspace_idx
  on public.capability_calls (workspace_id, created_at desc);

-- The queue, which is the only read that happens often enough to want its own
-- index and is almost always a handful of rows out of a great many.
create index if not exists capability_calls_pending_idx
  on public.capability_calls (workspace_id, created_at)
  where status = 'pending';

-- ---- who answered it ------------------------------------------------------
--
-- Same argument as the grants. The only thing a person writes on a call is the
-- answer; everything that records WHO answered and WHEN is stamped here, so an
-- approval cannot be attributed to a colleague who was not asked.
create or replace function public.capability_calls_stamp_decision()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if new.status is distinct from old.status
     and new.status in ('approved', 'refused') then
    new.decided_by := auth.uid();
    new.decided_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_capability_calls_stamp_decision on public.capability_calls;
create trigger trg_capability_calls_stamp_decision
  before update on public.capability_calls
  for each row
  execute function public.capability_calls_stamp_decision();

-- ---- policies on the calls ------------------------------------------------
alter table public.capability_calls enable row level security;

drop policy if exists "capability_calls_read" on public.capability_calls;
create policy "capability_calls_read"
  on public.capability_calls for select
  using (public.is_workspace_member(workspace_id));

-- The state machine, written as a policy, because a check constraint cannot see
-- the row it is replacing. `using` says only a pending call may be answered —
-- so an approval cannot be revoked after the mail has gone, and a refusal
-- cannot be quietly turned into an approval an hour later. `with check` says
-- the only two answers are yes and no: `performed` and `failed` are the
-- engine's to write, and this policy is the reason a client cannot claim
-- something was done.
--
-- Any writer may answer. Not admin-only, deliberately: approving one call is
-- strictly smaller than granting `always`, and requiring a rarer person for the
-- smaller decision would push teams towards the standing permission to avoid
-- the friction — the opposite of what this is for.
drop policy if exists "capability_calls_decide" on public.capability_calls;
create policy "capability_calls_decide"
  on public.capability_calls for update
  using (
    status = 'pending'
    and public.can_write_in_workspace(workspace_id)
  )
  with check (
    status in ('approved', 'refused')
    and public.can_write_in_workspace(workspace_id)
  );

-- No insert policy and no delete policy, and both absences are load-bearing. A
-- client that could insert a call could write itself an `approved` one; a
-- client that could delete one could remove the evidence that its agent tried.
-- Rows arrive through `record_capability_call` below and never leave except
-- with the workspace.
revoke all on public.capability_calls from anon, authenticated;
grant select on public.capability_calls to authenticated;
-- One column. The answer is the only thing a person writes here.
grant update (status) on public.capability_calls to authenticated;

-- The engine's half. INSERT is granted although rows arrive through
-- `record_capability_call`, which is `security definer` and therefore writes as
-- its owner rather than as the caller: the boundary on who may create a call is
-- that function's revoke, not this line, and withholding a grant from a role
-- that already bypasses row level security would be documentation pretending to
-- be a control. UPDATE is what marks a call `performed` or `failed` once the
-- third party has answered.
--
-- No DELETE, and that one is not documentation. These rows are the record that
-- an agent tried something, including the times it was refused, and nothing
-- unattended should be able to remove them. They leave with the workspace.
grant select, insert, update on public.capability_calls to service_role;

-- ---- the evaluator --------------------------------------------------------
--
-- The single place "no row means no" is implemented, and the only thing in this
-- feature without a policy in front of it — because there is no caller to have
-- a policy about. `claim_due_connections` has the same shape for the same
-- reason.
--
-- It decides and records in one statement, which is not tidiness: a decision
-- taken in TypeScript and then written down is two steps that can come apart,
-- and the half that would go missing is the audit row. Here there is no way to
-- ask the question without leaving a record of having asked it.
--
-- Note what it does NOT do: it does not perform anything. It returns a row and
-- the caller reads `status`. `approved` means go, `pending` means stop and let
-- somebody answer, `denied` means tell the agent no. One branch, whether the
-- permission was standing or was given ten seconds ago.
create or replace function public.record_capability_call(
  p_agent_id uuid,
  p_connection_id uuid,
  p_capability text,
  p_request jsonb default '{}'::jsonb,
  p_routine_run_id uuid default null
)
returns public.capability_calls
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_workspace_id uuid;
  v_provider text;
  v_agent_workspace uuid;
  v_mode text;
  v_call public.capability_calls%rowtype;
begin
  select c.workspace_id, c.provider into v_workspace_id, v_provider
  from public.connections c
  where c.id = p_connection_id;

  if v_workspace_id is null then
    raise exception 'no such connection: %', p_connection_id using errcode = '23503';
  end if;

  select a.workspace_id into v_agent_workspace
  from public.agents a
  where a.id = p_agent_id;

  -- Belt and braces over the composite foreign keys above. Those make a
  -- cross-workspace GRANT impossible; this makes a cross-workspace CALL
  -- impossible, including the denied kind, so one workspace's audit log can
  -- never acquire a row naming another workspace's agent.
  if v_agent_workspace is null or v_agent_workspace <> v_workspace_id then
    raise exception 'agent % is not in the workspace of connection %',
      p_agent_id, p_connection_id using errcode = '23503';
  end if;

  select g.mode into v_mode
  from public.connection_grants g
  where g.agent_id = p_agent_id
    and g.connection_id = p_connection_id
    and g.capability = p_capability;

  insert into public.capability_calls (
    workspace_id, agent_id, connection_id, provider, capability,
    mode, status, request, routine_run_id
  ) values (
    v_workspace_id, p_agent_id, p_connection_id, v_provider, p_capability,
    v_mode,
    case v_mode
      when 'always' then 'approved'
      when 'ask' then 'pending'
      else 'denied'
    end,
    coalesce(p_request, '{}'::jsonb),
    p_routine_run_id
  )
  returning * into v_call;

  return v_call;
end;
$$;

-- The grant IS the security boundary, in the words 0043 used about
-- `claim_due_connections` and for the identical reason: Postgres grants EXECUTE
-- to PUBLIC by default, every role inherits it, and a SECURITY DEFINER function
-- that writes an `approved` row stays callable through PostgREST unless PUBLIC
-- is revoked explicitly. A client that could call this could approve its own
-- calls without ever touching the policy above.
revoke all on function public.record_capability_call(uuid, uuid, text, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function public.record_capability_call(uuid, uuid, text, jsonb, uuid)
  to service_role;
