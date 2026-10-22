-- =========================================================================
-- The record of what was sent out
--
-- Settings › API keys (A26) ends with Webhooks: "Signed with a secret you
-- keep". An admin names an endpoint, ticks the events it wants —
-- thread.finished, agent.needs_you, routine.failed, document.created — and
-- keeps the signing secret, shown once. Every event becomes one row per
-- subscribed endpoint in `webhook_deliveries`, which the engine sends
-- (worker/src/lib/webhooks/dispatcher.ts): at once, then five, fifteen and
-- forty minutes later, and then it gives up and the row says so, with a
-- Resend beside it.
--
--   * Endpoints are the admins'. Their own client writes them: the URL's
--     shape is checked here and again, against the network, every time the
--     engine sends — a host that was public when it was saved can point
--     inward a week later — so a write that skipped the API's checks can
--     store nothing the engine will send to. The secret is written sealed
--     with the install's key and no client role may read it back.
--   * Deliveries are the engine's record: admins read them, nobody writes
--     them but the functions below and the engine's own service role.
--   * A webhook belongs to the workspace, so it hears only what the whole
--     workspace may see: a thread shared with it, a shared routine, a file in
--     a folder the workspace reads. A private thread's answer, question or
--     title is not the admin's to forward.
--   * A payload carries ids and labels — a thread's title, a routine's name,
--     a file's name — and never what anybody wrote in a message.
-- =========================================================================

create table if not exists public.webhook_endpoints (
  id                uuid        primary key default gen_random_uuid(),
  workspace_id      uuid        not null references public.workspaces (id) on delete cascade,
  url               text        not null,
  events            text[]      not null default '{}',
  secret_ciphertext text        not null,
  created_by        uuid        references auth.users (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  disabled_at       timestamptz
);

alter table public.webhook_endpoints drop constraint if exists webhook_endpoints_url_shape;
alter table public.webhook_endpoints add constraint webhook_endpoints_url_shape
  check (url ~ '^https://[^\s/]+' and char_length(url) <= 2000);

alter table public.webhook_endpoints drop constraint if exists webhook_endpoints_events_known;
alter table public.webhook_endpoints add constraint webhook_endpoints_events_known
  check (events <@ array['thread.finished', 'agent.needs_you', 'routine.failed', 'document.created']::text[]);

create index if not exists webhook_endpoints_workspace_idx
  on public.webhook_endpoints (workspace_id);

alter table public.webhook_endpoints enable row level security;

drop policy if exists "webhook_endpoints_select_admin" on public.webhook_endpoints;
create policy "webhook_endpoints_select_admin"
  on public.webhook_endpoints for select
  using (public.is_workspace_admin(workspace_id));

drop policy if exists "webhook_endpoints_insert_admin" on public.webhook_endpoints;
create policy "webhook_endpoints_insert_admin"
  on public.webhook_endpoints for insert
  with check (public.is_workspace_admin(workspace_id) and created_by = auth.uid());

drop policy if exists "webhook_endpoints_update_admin" on public.webhook_endpoints;
create policy "webhook_endpoints_update_admin"
  on public.webhook_endpoints for update
  using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));

drop policy if exists "webhook_endpoints_delete_admin" on public.webhook_endpoints;
create policy "webhook_endpoints_delete_admin"
  on public.webhook_endpoints for delete
  using (public.is_workspace_admin(workspace_id));

drop policy if exists webhook_endpoints_request_workspace on public.webhook_endpoints;
create policy webhook_endpoints_request_workspace on public.webhook_endpoints
  as restrictive for all to authenticated
  using ((select public.request_workspace()) is null
         or workspace_id = (select public.request_workspace()))
  with check ((select public.request_workspace()) is null
              or workspace_id = (select public.request_workspace()));

revoke all on public.webhook_endpoints from anon, authenticated;
grant select (id, workspace_id, url, events, created_by, created_at, updated_at, disabled_at)
  on public.webhook_endpoints to authenticated;
grant insert (workspace_id, url, events, secret_ciphertext, created_by)
  on public.webhook_endpoints to authenticated;
grant update (url, events, secret_ciphertext, updated_at, disabled_at)
  on public.webhook_endpoints to authenticated;
grant delete on public.webhook_endpoints to authenticated;
grant select, insert, update, delete on public.webhook_endpoints to service_role;

create table if not exists public.webhook_deliveries (
  id              uuid        primary key default gen_random_uuid(),
  endpoint_id     uuid        not null references public.webhook_endpoints (id) on delete cascade,
  workspace_id    uuid        not null references public.workspaces (id) on delete cascade,
  event           text        not null,
  payload         jsonb       not null default '{}'::jsonb,
  attempt         integer     not null default 0 check (attempt >= 0),
  status          text        not null default 'pending',
  status_code     integer,
  latency_ms      integer,
  last_error      text,
  next_attempt_at timestamptz not null default now(),
  claimed_at      timestamptz,
  created_at      timestamptz not null default now(),
  delivered_at    timestamptz
);

alter table public.webhook_deliveries drop constraint if exists webhook_deliveries_status_known;
alter table public.webhook_deliveries add constraint webhook_deliveries_status_known
  check (status in ('pending', 'ok', 'failed', 'dropped'));

alter table public.webhook_deliveries drop constraint if exists webhook_deliveries_event_known;
alter table public.webhook_deliveries add constraint webhook_deliveries_event_known
  check (event in ('thread.finished', 'agent.needs_you', 'routine.failed', 'document.created',
                   'webhook.test'));

create index if not exists webhook_deliveries_due_idx
  on public.webhook_deliveries (next_attempt_at)
  where status = 'pending';
create index if not exists webhook_deliveries_endpoint_idx
  on public.webhook_deliveries (endpoint_id, created_at desc);

alter table public.webhook_deliveries enable row level security;

drop policy if exists "webhook_deliveries_select_admin" on public.webhook_deliveries;
create policy "webhook_deliveries_select_admin"
  on public.webhook_deliveries for select
  using (public.is_workspace_admin(workspace_id));

drop policy if exists webhook_deliveries_request_workspace on public.webhook_deliveries;
create policy webhook_deliveries_request_workspace on public.webhook_deliveries
  as restrictive for all to authenticated
  using ((select public.request_workspace()) is null
         or workspace_id = (select public.request_workspace()));

revoke all on public.webhook_deliveries from anon, authenticated;
grant select on public.webhook_deliveries to authenticated;
grant select, insert, update, delete on public.webhook_deliveries to service_role;

-- ---- putting an event in the queue --------------------------------------

-- One row per enabled endpoint in the workspace that ticked this event.
-- Called by the triggers below and by nothing a client can reach.
create or replace function public.enqueue_webhook_event(
  p_workspace_id uuid,
  p_event        text,
  p_payload      jsonb
)
returns void
language sql
security definer
set search_path = pg_catalog, public
as $$
  insert into public.webhook_deliveries (endpoint_id, workspace_id, event, payload)
  select e.id, e.workspace_id, p_event, p_payload
    from public.webhook_endpoints e
   where e.workspace_id = p_workspace_id
     and e.disabled_at is null
     and p_event = any(e.events);
$$;

revoke all on function public.enqueue_webhook_event(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.enqueue_webhook_event(uuid, text, jsonb) to service_role;

-- An agent finished a reply in a thread the workspace can see.
create or replace function public.trg_webhook_thread_finished()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  s record;
begin
  if new.role <> 'assistant' or new.outcome is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.outcome is not distinct from new.outcome then
    return new;
  end if;
  select cs.workspace_id, cs.agent_id, cs.title, cs.kind, cs.visibility into s
    from public.chat_sessions cs
   where cs.id = new.session_id and cs.deleted_at is null;
  if s.workspace_id is null or s.visibility <> 'shared' then
    return new;
  end if;
  perform public.enqueue_webhook_event(s.workspace_id, 'thread.finished', jsonb_build_object(
    'thread', jsonb_build_object('id', new.session_id, 'title', coalesce(s.title, 'Untitled thread'),
                                 'kind', s.kind),
    'agent_id', s.agent_id,
    'message_id', new.id,
    'outcome', new.outcome));
  return new;
end $$;

revoke all on function public.trg_webhook_thread_finished() from public, anon, authenticated;

drop trigger if exists webhook_thread_finished on public.messages;
create trigger webhook_thread_finished
  after insert or update of outcome on public.messages
  for each row execute function public.trg_webhook_thread_finished();

-- An agent is waiting on somebody: an action to approve (0060), or a question
-- it asked (0122's `messages.ask`).
create or replace function public.trg_webhook_needs_you()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  s record;
  v_session uuid;
  v_kind text;
begin
  if tg_table_name = 'paused_turns' then
    if new.status <> 'pending' then
      return new;
    end if;
    v_session := new.session_id;
    v_kind := 'approval';
  else
    if new.ask is null or (tg_op = 'UPDATE' and old.ask is not null) then
      return new;
    end if;
    v_session := new.session_id;
    v_kind := 'question';
  end if;
  select cs.workspace_id, cs.agent_id, cs.title, cs.visibility into s
    from public.chat_sessions cs
   where cs.id = v_session and cs.deleted_at is null;
  if s.workspace_id is null or s.visibility <> 'shared' then
    return new;
  end if;
  perform public.enqueue_webhook_event(s.workspace_id, 'agent.needs_you', jsonb_build_object(
    'thread', jsonb_build_object('id', v_session, 'title', coalesce(s.title, 'Untitled thread')),
    'agent_id', s.agent_id,
    'kind', v_kind));
  return new;
end $$;

revoke all on function public.trg_webhook_needs_you() from public, anon, authenticated;

drop trigger if exists webhook_needs_you on public.paused_turns;
create trigger webhook_needs_you
  after insert on public.paused_turns
  for each row execute function public.trg_webhook_needs_you();

drop trigger if exists webhook_needs_you on public.messages;
create trigger webhook_needs_you
  after insert or update of ask on public.messages
  for each row execute function public.trg_webhook_needs_you();

-- A shared routine's run failed — when it is written failed, or when a run
-- held for its browser (0100) ends that way.
create or replace function public.trg_webhook_routine_failed()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  r record;
begin
  if new.status <> 'failed' then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status = 'failed' then
    return new;
  end if;
  select ro.workspace_id, ro.agent_id, ro.name, ro.visibility into r
    from public.routines ro
   where ro.id = new.routine_id and ro.deleted_at is null;
  if r.workspace_id is null or r.visibility <> 'shared' then
    return new;
  end if;
  perform public.enqueue_webhook_event(r.workspace_id, 'routine.failed', jsonb_build_object(
    'routine', jsonb_build_object('id', new.routine_id, 'name', r.name),
    'agent_id', r.agent_id,
    'run_id', new.id,
    'thread_id', new.session_id));
  return new;
end $$;

revoke all on function public.trg_webhook_routine_failed() from public, anon, authenticated;

drop trigger if exists webhook_routine_failed on public.routine_runs;
create trigger webhook_routine_failed
  after insert or update of status on public.routine_runs
  for each row execute function public.trg_webhook_routine_failed();

-- A file arrived in a folder the workspace reads.
create or replace function public.trg_webhook_document_created()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  b record;
begin
  select kb.workspace_id, kb.name, kb.scope into b
    from public.knowledge_bundles kb
   where kb.id = new.bundle_id and kb.deleted_at is null;
  if b.workspace_id is null or b.scope <> 'workspace' then
    return new;
  end if;
  perform public.enqueue_webhook_event(b.workspace_id, 'document.created', jsonb_build_object(
    'document', jsonb_build_object('id', new.id, 'name', new.name),
    'folder', jsonb_build_object('id', new.bundle_id, 'name', b.name),
    'added_by', case
      when new.connection_id is not null then 'source'
      when new.routine_id is not null then 'routine'
      else 'person' end));
  return new;
end $$;

revoke all on function public.trg_webhook_document_created() from public, anon, authenticated;

drop trigger if exists webhook_document_created on public.documents;
create trigger webhook_document_created
  after insert on public.documents
  for each row execute function public.trg_webhook_document_created();

-- ---- the engine, a test, and a second try --------------------------------

-- The engine's batch: due rows, each with what it is sent to. A claim older
-- than two minutes is a send that died and is taken again.
create or replace function public.claim_due_webhook_deliveries(p_limit integer)
returns table (
  id                uuid,
  endpoint_id       uuid,
  workspace_id      uuid,
  event             text,
  payload           jsonb,
  attempt           integer,
  created_at        timestamptz,
  url               text,
  secret_ciphertext text,
  disabled_at       timestamptz
)
language sql
security definer
set search_path = pg_catalog, public
as $$
  with due as (
    select d.id
      from public.webhook_deliveries d
     where d.status = 'pending'
       and d.next_attempt_at <= now()
       and (d.claimed_at is null or d.claimed_at < now() - interval '2 minutes')
     order by d.next_attempt_at
     limit greatest(least(coalesce(p_limit, 5), 50), 1)
     for update skip locked
  ),
  claimed as (
    update public.webhook_deliveries d
       set claimed_at = now()
      from due
     where d.id = due.id
    returning d.*
  )
  select c.id, c.endpoint_id, c.workspace_id, c.event, c.payload, c.attempt, c.created_at,
         e.url, e.secret_ciphertext, e.disabled_at
    from claimed c
    join public.webhook_endpoints e on e.id = c.endpoint_id;
$$;

revoke all on function public.claim_due_webhook_deliveries(integer) from public, anon, authenticated;
grant execute on function public.claim_due_webhook_deliveries(integer) to service_role;

-- "Send a test": one row for one endpoint, due now, for an admin of its
-- workspace. Returns its id, which the route hands to the engine to send at
-- once.
create or replace function public.enqueue_webhook_test(p_endpoint_id uuid)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_workspace uuid;
  v_id uuid;
begin
  select e.workspace_id into v_workspace from public.webhook_endpoints e where e.id = p_endpoint_id;
  if v_workspace is null or not public.is_workspace_member(v_workspace) then
    raise exception 'no such endpoint' using errcode = 'P0002';
  end if;
  if not public.is_workspace_admin(v_workspace) then
    raise exception 'only admins can test a webhook' using errcode = '42501';
  end if;
  insert into public.webhook_deliveries (endpoint_id, workspace_id, event, payload)
  values (p_endpoint_id, v_workspace, 'webhook.test',
          jsonb_build_object('message', 'A test from Covan. Nothing happened in the workspace.'))
  returning id into v_id;
  return v_id;
end $$;

-- "Resend": a delivery that gave up, or was dropped, goes round again from
-- its first try.
create or replace function public.resend_webhook_delivery(p_delivery_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_workspace uuid;
begin
  select d.workspace_id into v_workspace from public.webhook_deliveries d where d.id = p_delivery_id;
  if v_workspace is null or not public.is_workspace_member(v_workspace) then
    raise exception 'no such delivery' using errcode = 'P0002';
  end if;
  if not public.is_workspace_admin(v_workspace) then
    raise exception 'only admins can resend a webhook' using errcode = '42501';
  end if;
  update public.webhook_deliveries
     set status = 'pending', attempt = 0, next_attempt_at = now(), claimed_at = null,
         last_error = null, status_code = null, latency_ms = null, delivered_at = null
   where id = p_delivery_id
     and status in ('failed', 'dropped');
  if not found then
    raise exception 'only a delivery that gave up can be sent again' using errcode = '22023';
  end if;
end $$;

revoke all on function public.enqueue_webhook_test(uuid) from public, anon;
grant execute on function public.enqueue_webhook_test(uuid) to authenticated, service_role;
revoke all on function public.resend_webhook_delivery(uuid) from public, anon;
grant execute on function public.resend_webhook_delivery(uuid) to authenticated, service_role;
