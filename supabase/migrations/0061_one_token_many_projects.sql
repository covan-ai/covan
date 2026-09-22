-- =========================================================================
-- One token, many projects
--
-- 0059 said a service is a row and a KIND of service is a value in a CHECK.
-- This is that sentence being cashed: `supabase` joins `http` and `sql` as a
-- transport, because a Supabase project reached through its owner's account is
-- a kind of thing the other two cannot describe.
--
-- WHY A SECOND ROAD TO A POSTGRES AT ALL. The one 0059 built asks a person to
-- install `covan_query` in their database before Covan can carry a statement
-- to it. That is a good trade — it hands over no account credential, and the
-- read-onlyness is a function they can read — and it is a page of
-- documentation between somebody and their own data. Supabase's Management API
-- asks for the opposite trade: an account token, and nothing installed
-- anywhere. Read-onlyness survives the swap, which is the part that made this
-- worth building: the statement runs as `supabase_read_only_user`, a role
-- holding `pg_read_all_data`, so Postgres still refuses the write rather than
-- a regex in a Worker. Neither road is strictly better. The row says which one
-- a connection took.
--
-- WHY THE TOKEN IS NOT ON THE CONNECTION ROW. A Management API token is
-- account-wide: it opens every project in that Supabase account, not the one
-- it was pasted for. Copying it onto three connection rows would be three
-- copies of one powerful secret, three places to rotate it, and no object to
-- press "disconnect" on. So the token gets a row of its own, one per
-- workspace, and the projects point at it. `slack_installations` (0044) is the
-- same shape for the same reason, and 0059 named it as the precedent while
-- declining to be it.
--
-- WHO MAY CONNECT ONE. An admin, which is stricter than `tool_connections`
-- itself: adding an ordinary connection needs only a member who can write.
-- The difference is the blast radius of the credential. A member pasting an
-- account token would be making every agent in the workspace able to read
-- every project in that Supabase account — which is the same argument
-- `workspace_provider_keys` (0033) already makes about an OpenAI key, decided
-- the same way. Attaching and detaching individual PROJECTS stays an ordinary
-- write, because by then the decision has been made.
-- =========================================================================

-- ---- the account -----------------------------------------------------------
create table if not exists public.supabase_accounts (
  id uuid primary key default gen_random_uuid(),
  -- One per workspace. Two accounts would make "which token queried that
  -- project" a question with an answer nobody can see, for a second account
  -- nobody has asked for.
  workspace_id uuid not null unique references public.workspaces (id) on delete cascade,
  -- The AES-GCM envelope (lib/secret-box.ts) around the same JSON object of
  -- headers `tool_connections` stores: `{"headers":{"Authorization":"Bearer
  -- sbp_..."}}`. Identical on purpose — `authHeaders` reads one shape, and a
  -- token that needs the word "Bearer" is stored with the word in front of it.
  token_ciphertext text not null,
  -- `sbp_…ab12`. Four characters of a live credential, which is what the
  -- interface shows so an admin can tell two tokens apart without being shown
  -- either. Written by `hintFor()` in worker/src/lib/keys/crypto.ts.
  token_hint text not null,
  -- Who pasted it. `set null` rather than cascade for 0057's reason: the
  -- workspace owns the integration, and somebody leaving must not take the
  -- team's connected projects with them.
  connected_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.supabase_accounts is
  'A Supabase account connected to this workspace, as one encrypted Management '
  'API token. The projects it opens are tool_connections rows with '
  'transport=supabase pointing back at this one.';

comment on column public.supabase_accounts.token_ciphertext is
  'Account-wide: this token opens every project in that Supabase account, not '
  'only the ones connected here. Granted to no client role - the worker '
  'encrypts it and reads it back with the service role after RLS has already '
  'said the caller may have the row.';

comment on column public.supabase_accounts.token_hint is
  'Four characters of the token, so an admin can tell two apart. Not a '
  'credential and deliberately readable.';

create or replace function public.supabase_accounts_stamp()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists supabase_accounts_stamp on public.supabase_accounts;
create trigger supabase_accounts_stamp
  before update on public.supabase_accounts
  for each row execute function public.supabase_accounts_stamp();

alter table public.supabase_accounts enable row level security;

-- Any member may see that an account is connected and which four characters it
-- ends in. That is what lets the integrations page say "connected" to somebody
-- who cannot change it, and the column grant below is what keeps "see it" from
-- meaning "read the token".
drop policy if exists "supabase_accounts_read" on public.supabase_accounts;
create policy "supabase_accounts_read"
  on public.supabase_accounts for select
  using (public.is_workspace_member(workspace_id));

-- Disconnecting is an admin's, per the argument in the banner. It is a real
-- client-side delete rather than a route call because RLS can answer this
-- question on its own, and the cascade below does the rest.
drop policy if exists "supabase_accounts_delete" on public.supabase_accounts;
create policy "supabase_accounts_delete"
  on public.supabase_accounts for delete
  using (public.is_workspace_admin(workspace_id));

-- There is deliberately NO INSERT AND NO UPDATE POLICY. Both would be writing
-- a `token_ciphertext`, and the only thing that can produce one is the worker
-- holding ROUTINE_SECRET_KEY. Replacing a token goes through
-- `POST /supabase-account`, which encrypts it; a client that could write this
-- column could store a plaintext token and, because of the column grant below,
-- could never read back what it wrote to check.

-- ---- grants ---------------------------------------------------------------
--
-- 0023's rule: a migration that adds a table grants for it, in the same file.
-- RLS is row-level and cannot hide a column; column grants can. Same shape as
-- `delivery_channels` (0012), `connections` (0043) and `tool_connections`
-- (0059): strip the blanket grant, hand back everything except the ciphertext.
revoke all on public.supabase_accounts from anon, authenticated;
grant select (
  id, workspace_id, token_hint, connected_by, created_at, updated_at
) on public.supabase_accounts to authenticated;
grant delete on public.supabase_accounts to authenticated;
grant select, insert, update, delete on public.supabase_accounts to service_role;

-- ---- a project is a connection --------------------------------------------
--
-- Everything below is `tool_connections` learning that a row can borrow its
-- credential instead of holding one.
alter table public.tool_connections
  add column if not exists account_id uuid references public.supabase_accounts (id) on delete cascade;

comment on column public.tool_connections.account_id is
  'The Supabase account whose token this row uses, for transport=supabase and '
  'null for every other kind. Cascade: disconnecting the account removes the '
  'projects it opened, because without the token they cannot answer anything.';

create index if not exists tool_connections_account_idx
  on public.tool_connections (account_id);

-- The transport CHECK, widened. Found by definition rather than by name: 0059
-- wrote it inline, so its name is Postgres's default on every install that ran
-- that file unedited, and naming it anyway would make this migration fail on
-- one where it is not.
do $$
declare
  con_name text;
begin
  select con.conname into con_name
  from pg_constraint con
  where con.conrelid = 'public.tool_connections'::regclass
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%transport%'
    and pg_get_constraintdef(con.oid) ilike '%http%';

  if con_name is not null then
    execute format('alter table public.tool_connections drop constraint %I', con_name);
  end if;
end $$;

alter table public.tool_connections
  drop constraint if exists tool_connections_transport_check;

alter table public.tool_connections
  add constraint tool_connections_transport_check
  check (transport in ('http', 'sql', 'supabase'));

-- A supabase row has no credential of its own. `secret_ciphertext` was NOT
-- NULL because until now every row had one; the constraint that replaces it
-- says the whole rule in one place, so neither half can be written without the
-- other: borrow a token, or hold one, and never both or neither.
alter table public.tool_connections
  alter column secret_ciphertext drop not null;

alter table public.tool_connections
  drop constraint if exists tool_connections_credential_shape;

alter table public.tool_connections
  add constraint tool_connections_credential_shape
  check (
    (transport = 'supabase' and account_id is not null and secret_ciphertext is null)
    or (transport <> 'supabase' and account_id is null and secret_ciphertext is not null)
  );

-- `account_id` joins the readable set: the interface groups a workspace's
-- connected projects under the account they came from, and it is an id, not a
-- secret. The existing policies need no restatement — reading is a member's,
-- editing and removing are the creator's or an admin's, and those are the
-- right answers for a connected project too.
grant select (account_id) on public.tool_connections to authenticated;
