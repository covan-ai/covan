-- =========================================================================
-- A service the agent can reach
--
-- One row per external service an agent may talk to: a Postgres behind
-- PostgREST, a REST API, whatever comes next. The credential is encrypted by
-- the worker before Postgres sees it, under the same key and the same envelope
-- as `delivery_channels` (0012) and `connections` (0043) — an operator
-- managing two secrets rotates one of them.
--
-- WHY THIS IS NOT THE `connections` TABLE, which is the first question anybody
-- reading this will have. Three structural reasons, none of them taste:
--
--   1. `connections.bundle_id` is NOT NULL (0043). A connection exists to fill
--      a knowledge bundle with documents. An API credential has no bundle and
--      never will, and making the column nullable would make "which bundle
--      does this fill" a question every reader of that table has to ask.
--   2. `ConnectionProvider` (worker/src/lib/connections/types.ts) requires
--      `listFiles` and `readFile`. Its own doc comment says what it is: "A
--      source of documents. Deliberately small, and deliberately not a search
--      interface." A row here is exactly the thing that comment rules out.
--   3. `lib/background.ts` decides whether a tick claims connections at all by
--      asking whether any PROVIDER is configured. A row with no provider — no
--      OAuth client, nothing to sync — would sit in that table being counted
--      by a scheduler that has nothing to do with it.
--
-- There is precedent in this repo for exactly this split: Slack's credential
-- is not a `connections` row either, it is `slack_installations` (0044), and
-- `oauth-state.ts` recognises it as a separate kind of grant.
--
-- WHAT GROWS WITH CODE AND WHAT GROWS WITH A ROW. This is the whole point of
-- the table and it is worth stating before the columns. Adding HubSpot, or a
-- second Postgres, or any REST API with a token, is ONE ROW and no code:
-- `http_request` and `query_database` in worker/src/lib/harness/tools/ are
-- written against `transport`, not against a service. What needs code is a new
-- KIND of thing — a transport we cannot speak, an auth flow we do not have —
-- and those are the two CHECK constraints below, each of which grows in the
-- same migration as the code that honours it. That is 0058's catalogue
-- philosophy, applied one layer down.
-- =========================================================================

create table if not exists public.tool_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  -- What a person calls it: "Covan Supabase", "HubSpot (prod)", "Orders API".
  -- Free text, and the code never reads it — the model is shown it so it can
  -- tell two connections apart, and that is the whole job.
  label text not null check (length(btrim(label)) between 1 and 120),
  -- How we speak to it. `http` is a REST API; `sql` is a Postgres reached
  -- through PostgREST's `rpc/` (see docs/integrations.md for the function).
  -- A value here means there is code that implements it; `mcp` is the obvious
  -- next one and is deliberately absent until something needs it.
  transport text not null check (transport in ('http', 'sql')),
  -- The origin every request to this connection stays inside, and the path
  -- prefix under it. The model names a path, never a URL, so leaving either is
  -- structurally impossible rather than forbidden by a check somebody could
  -- forget.
  --
  -- For transport='sql' this is the PostgREST base, which for hosted Supabase
  -- means the project URL with `/rest/v1` on the end. Saying so here rather
  -- than special-casing Supabase in the code is what keeps a self-hosted
  -- PostgREST — where the base is the bare origin — working with the same tool.
  base_url text not null check (base_url ~ '^https?://'),
  -- How the credential is presented. `static_header` puts a header name in
  -- `config.header` and its value in `secret_ciphertext`. `oauth2` is what
  -- HubSpot would need and is not here yet, for the same reason `mcp` is not.
  auth_kind text not null check (auth_kind in ('static_header')),
  -- The methods a PERSON allowed when they set this up, not a list the model
  -- can widen. Default is read-only, and it is the default because the first
  -- connection that can write is the one that needs 0058's grant screen.
  -- Meaningless for transport='sql', which is one POST to one function whose
  -- read-onlyness is the function's own doing — see the docs.
  allowed_methods text[] not null default '{GET}'
    check (allowed_methods <@ array['GET','HEAD','POST','PUT','PATCH','DELETE']::text[]),
  -- Everything transport-shaped and nothing secret: `{"rpc":"covan_query"}`
  -- for a SQL connection, and the cached schema summary `describe_connection`
  -- writes back so it is not re-fetched on every turn. Header NAMES are not
  -- here either — they live inside the encrypted envelope with their values,
  -- because `apikey` as a header name is a hint about the service and the
  -- value beside it is the key.
  config jsonb not null default '{}'::jsonb,
  -- The AES-GCM envelope (lib/secret-box.ts) around a JSON object of headers:
  -- `{"headers":{"Authorization":"Bearer ...","apikey":"..."}}`. An object
  -- rather than a single token because Supabase behind Kong wants two headers
  -- and answers with neither if it gets one — the same shape
  -- `delivery_channels` has used for a webhook's config since 0012.
  secret_ciphertext text not null,
  -- Who set it up. `set null` rather than cascade for the reason 0057 gives
  -- about connections: the workspace owns this, and somebody leaving must not
  -- take the team's integration with them.
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.tool_connections is
  'An external service an agent may call through the general tools in '
  'worker/src/lib/harness/tools/. Adding a service is a row here; adding a '
  'kind of service is a value in transport or auth_kind, which grows with the '
  'code that honours it.';

comment on column public.tool_connections.allowed_methods is
  'The HTTP methods a person allowed. Not advisory - http_request refuses '
  'anything not in this list before it builds a URL. Ignored for '
  'transport=sql, which is one POST to a read-only function.';

-- One name per workspace, so "which Supabase did it query" has an answer a
-- person can give. Case-insensitive because "Covan Supabase" and "covan
-- supabase" being two connections is a support ticket, not a feature.
create unique index if not exists tool_connections_label_idx
  on public.tool_connections (workspace_id, lower(btrim(label)));

create index if not exists tool_connections_workspace_idx
  on public.tool_connections (workspace_id);

create or replace function public.tool_connections_stamp()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists tool_connections_stamp on public.tool_connections;
create trigger tool_connections_stamp
  before update on public.tool_connections
  for each row execute function public.tool_connections_stamp();

alter table public.tool_connections enable row level security;

-- Any member may see that a connection exists and what it points at. Seeing it
-- is what lets the agent's settings screen say which services it can reach,
-- and the column grant below is what keeps "see it" from meaning "read the
-- token".
drop policy if exists "tool_connections_read" on public.tool_connections;
create policy "tool_connections_read"
  on public.tool_connections for select
  using (public.is_workspace_member(workspace_id));

-- Editing is the owner's or an admin's, and the WITH CHECK repeats the guard
-- for the reason 0043 spells out: `authenticated` holds a table-level UPDATE
-- grant through Supabase's defaults and the anon key ships in the browser
-- bundle, so PostgREST is reachable directly whatever the worker's PATCH
-- schema allows. A weaker WITH CHECK would let a row be moved into another
-- workspace, credential and all.
drop policy if exists "tool_connections_update" on public.tool_connections;
create policy "tool_connections_update"
  on public.tool_connections for update
  using (created_by = auth.uid() or public.is_workspace_admin(workspace_id))
  with check (
    (created_by = auth.uid() or public.is_workspace_admin(workspace_id))
    and public.can_write_in_workspace(workspace_id)
  );

drop policy if exists "tool_connections_delete" on public.tool_connections;
create policy "tool_connections_delete"
  on public.tool_connections for delete
  using (created_by = auth.uid() or public.is_workspace_admin(workspace_id));

-- There is deliberately NO INSERT POLICY. A row cannot be written without a
-- `secret_ciphertext`, and the thing that produces one is the worker, holding
-- ROUTINE_SECRET_KEY. A client that could insert could insert a plaintext
-- token, or somebody else's ciphertext, and the column grant below means it
-- could never read back what it wrote to check. Creation goes through
-- `POST /tool-connections`, which does the encrypting.
--
-- RLS is row-level and cannot hide a column; column grants can. Same shape as
-- `delivery_channels` (0012) and `connections` (0043): strip the blanket
-- grant, hand back everything except the ciphertext.
revoke all on public.tool_connections from anon, authenticated;
grant select (
  id, workspace_id, label, transport, base_url, auth_kind, allowed_methods,
  config, created_by, created_at, updated_at
) on public.tool_connections to authenticated;
-- `config` is updatable because the settings screen edits the rpc name and
-- offers a "refresh" for the cached summary. It holds nothing secret — the
-- header names are inside the envelope with their values, so there is nothing
-- here for a crafted PostgREST select to find.
grant update (label, allowed_methods, config) on public.tool_connections to authenticated;
grant delete on public.tool_connections to authenticated;

-- 0023's closing rule: a migration that adds a table grants for it, in the
-- same file. The worker reads the ciphertext with the service role after its
-- own RLS-scoped permission check — the `withSecret` pattern from
-- routes/connections.ts — and writes rows there too.
grant select, insert, update, delete on public.tool_connections to service_role;
