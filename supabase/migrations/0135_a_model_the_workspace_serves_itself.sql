-- =========================================================================
-- A model the workspace serves itself
--
-- Configuration › Model › All models (A10) lists "Everything this install
-- serves" and ends with "Add a custom endpoint for a self-hosted or
-- OpenAI-compatible model": `gpt-5-mini via acme-openai-proxy · Endpoint · no
-- price`. Until now one endpoint served the whole deployment
-- (`OPENAI_BASE_URL`); this is one per workspace, as many as its admins add.
--
--   * An endpoint is a label, the model's name at that endpoint, an https
--     base URL and, usually, a key — sealed with the install's key, writable
--     by an admin's own client and readable by nobody: the engine opens it
--     when a reply is asked of that model, and only for the workspace the
--     reply belongs to.
--   * Every member sees the endpoints exist — the label, the model, the
--     host — so a picker can offer them; only admins add or remove them.
--     Removing one marks it, rather than deleting the row, so a reply written
--     by it can still say which endpoint that was.
--   * A model column (`agents.model`, `chat_sessions.model`,
--     `routines.model`, `messages.model`) names one as `endpoint:<id>`. An
--     agent whose endpoint went away answers on the install's default, as an
--     agent does whose provider key was rotated out.
--   * Nothing is charged for it: the workspace pays its own endpoint.
-- =========================================================================

create table if not exists public.workspace_model_endpoints (
  id                 uuid        primary key default gen_random_uuid(),
  workspace_id       uuid        not null references public.workspaces (id) on delete cascade,
  label              text        not null,
  model              text        not null,
  base_url           text        not null,
  api_key_ciphertext text,
  created_by         uuid        references auth.users (id) on delete set null,
  created_at         timestamptz not null default now(),
  deleted_at         timestamptz
);

alter table public.workspace_model_endpoints drop constraint if exists workspace_model_endpoints_shape;
alter table public.workspace_model_endpoints add constraint workspace_model_endpoints_shape
  check (
    char_length(trim(label)) between 1 and 60
    and char_length(trim(model)) between 1 and 200
    and char_length(base_url) <= 500
    and base_url ~ '^https://[^\s/@]+(/[^\s]*)?$'
  );

create index if not exists workspace_model_endpoints_workspace_idx
  on public.workspace_model_endpoints (workspace_id)
  where deleted_at is null;

alter table public.workspace_model_endpoints enable row level security;

drop policy if exists "workspace_model_endpoints_select_member" on public.workspace_model_endpoints;
create policy "workspace_model_endpoints_select_member"
  on public.workspace_model_endpoints for select
  using (public.is_workspace_member(workspace_id));

drop policy if exists "workspace_model_endpoints_insert_admin" on public.workspace_model_endpoints;
create policy "workspace_model_endpoints_insert_admin"
  on public.workspace_model_endpoints for insert
  with check (public.is_workspace_admin(workspace_id) and created_by = auth.uid());

drop policy if exists "workspace_model_endpoints_update_admin" on public.workspace_model_endpoints;
create policy "workspace_model_endpoints_update_admin"
  on public.workspace_model_endpoints for update
  using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));

drop policy if exists workspace_model_endpoints_request_workspace on public.workspace_model_endpoints;
create policy workspace_model_endpoints_request_workspace on public.workspace_model_endpoints
  as restrictive for all to authenticated
  using ((select public.request_workspace()) is null
         or workspace_id = (select public.request_workspace()))
  with check ((select public.request_workspace()) is null
              or workspace_id = (select public.request_workspace()));

revoke all on public.workspace_model_endpoints from anon, authenticated;
grant select (id, workspace_id, label, model, base_url, created_by, created_at, deleted_at)
  on public.workspace_model_endpoints to authenticated;
grant insert (workspace_id, label, model, base_url, api_key_ciphertext, created_by)
  on public.workspace_model_endpoints to authenticated;
grant update (label, deleted_at) on public.workspace_model_endpoints to authenticated;
grant select, insert, update, delete on public.workspace_model_endpoints to service_role;
