-- =========================================================================
-- A catalogue the agent can search
--
-- 0059 said a service is a row and a KIND of service is a value in a CHECK, and
-- 0061 cashed that sentence once. This cashes it a second time, for the kind of
-- service that cannot be reached with a pasted token at all: `composio` joins
-- `http`, `sql` and `supabase` as a transport, and joins `static_header` as an
-- `auth_kind`, because a service behind somebody else's OAuth application is a
-- kind of thing the other three cannot describe.
--
-- WHY A FOURTH TRANSPORT RATHER THAN A FIFTEEN-HUNDREDTH TOOL. 0059's whole
-- argument is that adding HubSpot is a row and no code. That argument has one
-- door and it is shut for most of the world: `auth_kind` accepts a static
-- header, so a service that requires a consent screen rather than a pasteable
-- token cannot be connected at all — `docs/integrations.md` admits it in
-- writing. Composio sells the two halves this repository lacks and has no
-- business writing: a registered OAuth application per provider, and a
-- machine-readable description of each provider's operations. What it does NOT
-- sell us is execution. The origin lock, the method allowlist, the step budget
-- and the confirmation gate stay here, where they can be read.
--
-- WHY THE ACCOUNT REFERENCE IS A COLUMN AND NOT `config`. This is the decision
-- in this file most likely to be "simplified" by somebody later, so it is
-- written down. 0059:177-181 grants `update (label, allowed_methods, config)`
-- to `authenticated`, and 0059:142-147 says why that is safe: `config` holds
-- nothing secret. The Composio API key is a DEPLOYMENT secret, so every
-- workspace on one deployment shares one Composio project, and a connected
-- account id is therefore the only thing standing between two tenants. Put it
-- in `config` and any member could PATCH their own row — through PostgREST,
-- with the anon key that ships in the browser bundle — to another workspace's
-- account id and execute against somebody else's mailbox. So it is a column,
-- revoked from every client role, exactly like `secret_ciphertext`. The same
-- goes for `composio_user_id`, which is the other half of the same address.
--
-- WHY THE GRANTS TABLE IS A SIBLING OF 0058'S AND NOT 0058'S OWN. 0058 designed
-- this permission model and got it right: the key is the AGENT, the modes are
-- `ask` and `always`, and no row means no. All of that is adopted here
-- unchanged. What cannot follow is its CATALOGUE rule.
-- `connection_grants.capability` is foreign-keyed to `connection_capabilities`,
-- which is populated by "the migration that ships each capability's
-- implementation" — and no migration can enumerate fifteen hundred
-- applications' operations, nor should one try. A grant here therefore names a
-- `slug` with nothing to point at, which is the one thing 0058 would not do, so
-- it gets its own table rather than quietly loosening that one's promise.
--
-- WHY ABSENCE MEANS *ASK* HERE AND *NEVER* THERE, which is a real departure and
-- has to be said out loud. 0058's default exists to keep a product whose agents
-- do not act from gaining an action by accident, and that is still the right
-- default for a Notion page nobody deliberately handed over. A `composio` row
-- is different in kind: it does not exist until an admin searched a catalogue,
-- clicked connect, and completed a consent screen at the provider. The absence
-- of a grant on a connection somebody went to that trouble for should surface a
-- question, not a dead end. So `always` is the only thing a grant row buys
-- here, and the asking flow is what a person gets for connecting at all.
--
-- WHAT `base_url` AND `allowed_methods` MEAN ON THIS TRANSPORT, since the
-- honest answer is "less than they do anywhere else". `base_url` is NOT NULL
-- with a `^https?://` check (0059:62) and a Composio row has no per-row
-- address — every one of them goes to the same deployment-wide API. The
-- duplication is accepted rather than fixed by widening the check: a row that
-- records where it was reached is a row somebody can audit, and a nullable
-- `base_url` would make "which address did it call" unanswerable for the three
-- transports where it is the whole answer. `allowed_methods` is meaningless
-- here for the reason it is meaningless for `sql` and `supabase` — the method
-- is Composio's business, not the model's — and keeps the column's `{GET}`
-- default so the row reads sensibly beside an `http` one.
-- =========================================================================

-- ---- the transport ---------------------------------------------------------
--
-- Both constraints this touches have stable names now, so they drop by name.
-- Do NOT copy 0061's `do $$` hunt: it was needed because 0059 wrote the
-- transport check inline, and 0061 fixed that by re-adding it with a name.
-- (If a future migration does need such a hunt, note the hazard 0061 walked
-- past: `select ... into` without `strict` silently takes the FIRST match, so a
-- predicate matching two constraints drops one, leaves the other, and reports
-- success.)
alter table public.tool_connections
  drop constraint if exists tool_connections_transport_check;

alter table public.tool_connections
  add constraint tool_connections_transport_check
  check (transport in ('http', 'sql', 'supabase', 'composio'));

-- `auth_kind` is the one 0059 still writes inline (0059:66), so its name is
-- Postgres's generated default — deterministic on every install that ran that
-- file unedited, which is every install. Dropped by that name and re-added with
-- it, so the next migration has a stable name to reach for.
alter table public.tool_connections
  drop constraint if exists tool_connections_auth_kind_check;

alter table public.tool_connections
  add constraint tool_connections_auth_kind_check
  check (auth_kind in ('static_header', 'composio'));

-- ---- the account, and the two columns no client may read -------------------
--
-- `connected_account_id` is Composio's own id for the grant a person completed
-- at the provider. It is an opaque reference and not a credential: the token it
-- stands for never reaches this database, which is the trade the banner names
-- and `docs/security.md` records.
--
-- That it is not a credential does not make it public. It is the whole of the
-- address, on a deployment where one API key opens every workspace's accounts,
-- so it is withheld from `authenticated` by the grants at the bottom of this
-- file for the same reason `secret_ciphertext` is.
alter table public.tool_connections
  add column if not exists connected_account_id text;

comment on column public.tool_connections.connected_account_id is
  'Composio''s id for the connected account this row executes against, for '
  'transport=composio and null for every other kind. Not a credential and not '
  'public: one deployment-wide API key opens every workspace''s accounts, so '
  'this id is the only thing separating two tenants. Granted to no client role.';

-- Which application this row is a connection TO — `gmail`, `hubspot`,
-- `linear`. Readable, and it has to be: without it the model can find a slug in
-- the catalogue and have no way to know which connection id to pair it with,
-- and `connectionsManifest` ends with "never guess an id that is not on this
-- list" for a reason.
alter table public.tool_connections
  add column if not exists toolkit_slug text;

comment on column public.tool_connections.toolkit_slug is
  'The Composio toolkit this row connects, lowercased - gmail, hubspot, linear. '
  'Readable on purpose: it is how a tool slug found in the catalogue is matched '
  'to a connection id, and run_tool refuses a slug from another toolkit.';

-- The identifier Composio's execute call is made on behalf of. Chosen when the
-- connection is created and stored, rather than derived from whoever happens to
-- be asking: `ctx.userId` differs between a chat turn and a scheduled run
-- (lib/routines/agent-run.ts), so deriving it would make the same connection
-- address two different accounts depending on the hour. It is also deliberately
-- not a Covan account uuid — shipping those to a third party as a durable
-- identifier is a thing this codebase does not do.
alter table public.tool_connections
  add column if not exists composio_user_id text;

comment on column public.tool_connections.composio_user_id is
  'The opaque per-connection identifier Composio executes on behalf of. Not a '
  'Covan user id. Granted to no client role, because it is half of the address '
  'connected_account_id is the other half of.';

-- ---- a connection that is not finished yet ---------------------------------
--
-- `connections` (0057) already has a vocabulary for this and it is reused
-- rather than respelled. A row appears the moment a person is sent to a consent
-- screen, so there is something to poll and something to clean up if they walk
-- away; it is `active` only once Composio says the grant exists.
--
-- Every other transport is born finished, which is why the default is `active`
-- and not `pending`: a `sql` row with a pasted token works the instant it is
-- inserted, and a default of `pending` would make every existing row invisible.
alter table public.tool_connections
  add column if not exists status text not null default 'active';

alter table public.tool_connections
  drop constraint if exists tool_connections_status_check;

alter table public.tool_connections
  add constraint tool_connections_status_check
  check (status in ('pending', 'active', 'failed'));

comment on column public.tool_connections.status is
  'pending while a person is at a consent screen, active once the grant exists, '
  'failed when it did not. Only transport=composio is ever anything but active. '
  'A pending row is deliberately hidden from the agent: listConnections filters '
  'it, because a half-finished OAuth that advertises itself is a connection the '
  'model will try and nothing can answer.';

create index if not exists tool_connections_toolkit_idx
  on public.tool_connections (workspace_id, toolkit_slug)
  where toolkit_slug is not null;

-- ---- the shape of a credential, stated exhaustively ------------------------
--
-- 0061 described the old rule as "borrow a token, or hold one, and never both
-- or neither". Composio is "neither" — the token is at Composio and what this
-- row holds is an address — so the sentence needs rewriting rather than
-- extending. The new one: **every transport says where its credential is, and
-- there is no transport that does not.**
--
-- Written as a CASE with an `else` rather than as a chain of ORs, so that a
-- fifth transport added to the check above without being added here fails
-- closed. The OR form would have let it through with no credential rule at all,
-- which is the quiet version of this constraint not existing.
alter table public.tool_connections
  drop constraint if exists tool_connections_credential_shape;

alter table public.tool_connections
  add constraint tool_connections_credential_shape
  check (
    case transport
      when 'supabase' then
        account_id is not null and secret_ciphertext is null
      when 'composio' then
        account_id is null
        and secret_ciphertext is null
        and toolkit_slug is not null
        -- A pending row has been created but nobody has finished the consent
        -- screen, so there is no account to name yet. Every other state must
        -- name one, which is what stops a `failed` row from being executed
        -- against by a code path that forgot to check `status`.
        and (status = 'pending' or connected_account_id is not null)
      else
        account_id is null
        and secret_ciphertext is not null
        and connected_account_id is null
        and composio_user_id is null
        and toolkit_slug is null
    end
  );

-- The composite target the grants table below points at. Redundant as a
-- uniqueness claim — `id` is already the primary key — and that redundancy is
-- the price of a grant that cannot join an agent in one workspace to a
-- connection in another. 0058 pays it twice for the same reason and explains it
-- at length.
alter table public.tool_connections
  drop constraint if exists tool_connections_id_workspace_key;
alter table public.tool_connections
  add constraint tool_connections_id_workspace_key unique (id, workspace_id);

-- ---- what an agent may do at a connected service ---------------------------
--
-- 0058's shape, with 0058's key and 0058's two modes. The differences are the
-- two the banner argues for: the third key column is a free-text `slug` rather
-- than a catalogue reference, and the absence of a row means `ask` rather than
-- `never`.
create table if not exists public.tool_connection_grants (
  -- An agent is the unit a person configures, names and trusts. Not per
  -- workspace, because "everyone here may send mail" is not a thing anybody
  -- means; not per person, because the actor at 3am is not a person; not per
  -- routine, because a permission that changes with the doorway is a permission
  -- nobody can reason about. 0058 makes this argument in full.
  agent_id uuid not null,
  tool_connection_id uuid not null,
  -- Denormalised from both parents and constrained below to agree with them,
  -- so the policies read like every other policy in this schema and an export
  -- scoped by workspace has a column to scope by.
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  -- A Composio operation, as Composio names it: `GMAIL_SEND_EMAIL`. Free text
  -- with no foreign key, and that absence is the whole reason this table is not
  -- `connection_grants` — see the banner. What stops a slug from naming
  -- somebody else's application is not this column: `run_tool` refuses a slug
  -- whose toolkit is not the connection's own, before anything leaves the
  -- building.
  slug text not null check (length(btrim(slug)) between 1 and 200),
  -- `ask`: stop and put it in front of a person. `always`: the approval was
  -- given in advance, which is the whole of what `always` means. There is no
  -- `never` here either — but unlike 0058, the absence of a row is `ask` rather
  -- than `never`, because a connection only exists at all because somebody
  -- deliberately made it.
  mode text not null check (mode in ('ask', 'always')),
  -- Stamped by the trigger below rather than accepted from the client, 0037's
  -- pattern for 0037's reason: `authenticated` holds a table-level insert and
  -- update, so a column recording who handed an agent a standing permission
  -- must not be one any writer can fill with a colleague's id.
  granted_by uuid references auth.users (id) on delete set null,
  granted_at timestamptz not null default now(),
  primary key (agent_id, tool_connection_id, slug)
);

comment on table public.tool_connection_grants is
  'Which agent may run which operation, at which connected service. 0058''s '
  'shape on its own table, because a catalogue of fifteen hundred applications '
  'cannot be a foreign key. A missing row means ask - not never, which is the '
  'one place this departs from 0058 and the reason is in that migration''s '
  'banner and this one''s.';

comment on column public.tool_connection_grants.mode is
  'ask | always. The absence of a row is ask. always means a person approved '
  'this operation on this connection in advance, and an admin is who may say so.';

-- The two composite references that make a cross-tenant grant impossible
-- rather than merely disallowed. The distinction is 0058's and it matters for
-- 0058's reason: the process that reads these rows on a schedule is the service
-- role, which bypasses row level security entirely, so a policy is no boundary
-- at all for that read.
alter table public.tool_connection_grants
  drop constraint if exists tool_connection_grants_agent_fkey;
alter table public.tool_connection_grants
  add constraint tool_connection_grants_agent_fkey
  foreign key (agent_id, workspace_id)
  references public.agents (id, workspace_id) on delete cascade;

alter table public.tool_connection_grants
  drop constraint if exists tool_connection_grants_connection_fkey;
alter table public.tool_connection_grants
  add constraint tool_connection_grants_connection_fkey
  foreign key (tool_connection_id, workspace_id)
  references public.tool_connections (id, workspace_id) on delete cascade;

-- Postgres does not index a foreign key for you, and both of these are read in
-- the direction the primary key does not serve: "everything this connection has
-- been granted" is the card on the integrations page, "everything in this
-- workspace" is the audit.
create index if not exists tool_connection_grants_connection_idx
  on public.tool_connection_grants (tool_connection_id);
create index if not exists tool_connection_grants_workspace_idx
  on public.tool_connection_grants (workspace_id);

create or replace function public.tool_connection_grants_stamp()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.granted_by := auth.uid();
  new.granted_at := now();
  return new;
end;
$$;

drop trigger if exists trg_tool_connection_grants_stamp on public.tool_connection_grants;
create trigger trg_tool_connection_grants_stamp
  before insert or update on public.tool_connection_grants
  for each row
  execute function public.tool_connection_grants_stamp();

alter table public.tool_connection_grants enable row level security;

drop policy if exists "tool_connection_grants_read" on public.tool_connection_grants;
create policy "tool_connection_grants_read"
  on public.tool_connection_grants for select
  using (public.is_workspace_member(workspace_id));

-- Granting is writing, and the extra clause is the one rule that needs a role
-- above writer. Promoting an operation to `always` removes the asking forever,
-- and "this agent may send mail as us without telling anyone" is a decision
-- about the workspace rather than about one piece of work.
--
-- 0058 asks the catalogue whether the capability is destructive and exempts the
-- ones that are not. There is no catalogue here, so every `always` needs an
-- admin. That is stricter than 0058 in the safe direction and it is a
-- deliberate consequence of the trade this migration makes: the price of not
-- enumerating fifteen hundred applications is not knowing which of their
-- operations are harmless.
drop policy if exists "tool_connection_grants_insert" on public.tool_connection_grants;
create policy "tool_connection_grants_insert"
  on public.tool_connection_grants for insert
  with check (
    public.can_write_in_workspace(workspace_id)
    and (mode <> 'always' or public.is_workspace_admin(workspace_id))
  );

-- The `using` clause is deliberately the plain write check, without the admin
-- rule, and the asymmetry is 0058's point: a writer who cannot raise a grant to
-- `always` must still be able to lower one from it. Putting the admin rule in
-- `using` too would mean the only people who could take a standing permission
-- away were the people who could give it.
drop policy if exists "tool_connection_grants_update" on public.tool_connection_grants;
create policy "tool_connection_grants_update"
  on public.tool_connection_grants for update
  using (public.can_write_in_workspace(workspace_id))
  with check (
    public.can_write_in_workspace(workspace_id)
    and (mode <> 'always' or public.is_workspace_admin(workspace_id))
  );

drop policy if exists "tool_connection_grants_delete" on public.tool_connection_grants;
create policy "tool_connection_grants_delete"
  on public.tool_connection_grants for delete
  using (public.can_write_in_workspace(workspace_id));

-- ---- grants ----------------------------------------------------------------
--
-- 0023's closing rule: a migration that adds a table grants for it, in the same
-- file, to both roles that will touch it.
revoke all on public.tool_connection_grants from anon, authenticated;
grant select, insert, update, delete on public.tool_connection_grants to authenticated;
-- Read only for the engine, 0058's decision repeated for 0058's reason: a grant
-- is a person's decision and nothing unattended has any business creating one.
-- The reading is real — whether an operation may run without asking is a
-- question a scheduled run asks at 3am, through a client with no caller.
grant select on public.tool_connection_grants to service_role;

-- The two new readable columns join the select grant 0059 and 0061 built up.
-- `connected_account_id` and `composio_user_id` are deliberately NOT here, and
-- the banner says why at length. `service_role` already holds the table-wide
-- grant from 0059, so nothing more is needed for the worker to read them.
grant select (status, toolkit_slug) on public.tool_connections to authenticated;
