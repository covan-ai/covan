-- =========================================================================
-- A routine that shows its work
--
-- 0070 decided that a scheduled run leaves no conversation behind: it mails
-- its report and writes one `routine_runs` row, and that is all anybody ever
-- sees of it inside Covan. The redesign reverses that, on purpose and per
-- routine. The Inbox lists "Weekly competitor brief — Research · routine" next
-- to everything else (A4), the routine's Recent runs table opens each run
-- (A7), and "Delivers to: Inbox" is a switch in the editor (A28). So:
--
--   1. A run can be a thread. `chat_sessions.kind` learns `'routine'`, the
--      session knows its routine and the run knows its session. The engine
--      (worker/src/lib/routines/executor.ts, `finish`) writes one thread with
--      one reply per run when `routines.deliver_inbox` is on — the default —
--      and keeps the newest twenty per routine that nobody replied in.
--
--   2. A routine says who paused it and when ("Paused by Deniz · 2 weeks
--      ago"), stamped by a trigger rather than trusted from a body, and may
--      name the model and thinking it runs on (the editor's Model and
--      Thinking fields).
--
--   3. The workspace keeps a feed. `workspace_events` (0040) is the admin's
--      audit log; it learns five more actions that Home's Recent activity is
--      made of — a thread shared, a routine run finished or failed, files
--      added, a turn approved — and `workspace_activity` reads them back for
--      any member, each row only when the member can see what it is about.
--
--   4. A failed routine run waits on its owner in the Inbox, alongside an
--      approval, a question and a sign-in (0122's `inbox_rows`, replaced
--      here with one more case).
-- =========================================================================

-- ---- 1. a run that is a thread -------------------------------------------

alter table public.chat_sessions
  drop constraint if exists chat_sessions_kind_check;
alter table public.chat_sessions
  add constraint chat_sessions_kind_check
  check (kind in ('chat', 'brainstorm', 'routine'));

-- Deferrable, like 0012's `routines.delivery_channel_id`: `routines` already
-- points at `chat_sessions` (its browser conversation, 0100), so an export that
-- replays one before the other needs the check held to the end of the restore.
alter table public.chat_sessions
  add column if not exists routine_id uuid references public.routines (id) on delete set null
    deferrable initially deferred;

create index if not exists chat_sessions_routine_idx
  on public.chat_sessions (routine_id, created_at desc)
  where routine_id is not null;

alter table public.routine_runs
  add column if not exists session_id uuid references public.chat_sessions (id) on delete set null;

-- Written by the engine with the service role; 0094 grants no client a write
-- on `chat_sessions.routine_id` (its insert list is unchanged) or on
-- `routine_runs` at all.

-- ---- 2. who paused it, and what it runs on --------------------------------

alter table public.routines
  add column if not exists paused_by       uuid references auth.users (id) on delete set null,
  add column if not exists paused_at       timestamptz,
  add column if not exists deliver_inbox   boolean not null default true,
  add column if not exists model           text,
  add column if not exists reasoning_effort text;

alter table public.routines
  drop constraint if exists routines_reasoning_effort_known;
alter table public.routines
  add constraint routines_reasoning_effort_known
  check (reasoning_effort is null or reasoning_effort in ('minimal', 'low', 'medium', 'high'));

grant insert (deliver_inbox, model, reasoning_effort) on public.routines to authenticated;
grant update (deliver_inbox, model, reasoning_effort) on public.routines to authenticated;

-- Stamped, never sent: whoever moved the routine into `paused` is the caller
-- of the statement that did it, and null for the engine pausing it after
-- repeated failures. Leaving `paused` clears both.
create or replace function public.routines_stamp_pause()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.status = 'paused' and (tg_op = 'INSERT' or old.status is distinct from 'paused') then
    new.paused_by := auth.uid();
    new.paused_at := now();
  elsif new.status is distinct from 'paused' then
    new.paused_by := null;
    new.paused_at := null;
  end if;
  return new;
end $$;

revoke all on function public.routines_stamp_pause() from public, anon, authenticated;

drop trigger if exists routines_stamp_pause on public.routines;
create trigger routines_stamp_pause
  before insert or update of status on public.routines
  for each row execute function public.routines_stamp_pause();

-- ---- 3. the feed -----------------------------------------------------------

alter table public.workspace_events
  drop constraint if exists workspace_events_subject_type_check;
alter table public.workspace_events
  add constraint workspace_events_subject_type_check
  check (subject_type in ('agent', 'bundle', 'document', 'member', 'invitation', 'session', 'routine'));

-- One writer for the feed, which takes its actor rather than reading it from
-- the session: a routine run and an approval are written by the engine with
-- the service role, which has no `auth.uid()`, and the person or agent the row
-- is about is known to the trigger that calls this.
create or replace function public.log_feed_event(
  p_workspace_id  uuid,
  p_actor_id      uuid,
  p_action        text,
  p_subject_type  text,
  p_subject_id    uuid,
  p_subject_label text,
  p_detail        jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if not exists (select 1 from public.workspaces w where w.id = p_workspace_id) then
    return;
  end if;
  insert into public.workspace_events
    (workspace_id, actor_id, action, subject_type, subject_id, subject_label, detail)
  values (
    p_workspace_id,
    (select p.id from public.profiles p where p.id = p_actor_id),
    p_action,
    p_subject_type,
    p_subject_id,
    coalesce(nullif(trim(p_subject_label), ''), '(unnamed)'),
    p_detail
  );
end $$;

revoke all on function public.log_feed_event(uuid, uuid, text, text, uuid, text, jsonb)
  from public, anon, authenticated;

-- A thread shared with the team.
create or replace function public.trg_feed_session_shared()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.visibility = 'shared' and old.visibility is distinct from 'shared' and new.kind = 'chat' then
    perform public.log_feed_event(
      new.workspace_id, coalesce(auth.uid(), new.user_id), 'session.shared', 'session',
      new.id, coalesce(new.title, 'Untitled thread'), jsonb_build_object('agent_id', new.agent_id));
  end if;
  return new;
end $$;

revoke all on function public.trg_feed_session_shared() from public, anon, authenticated;

drop trigger if exists feed_session_shared on public.chat_sessions;
create trigger feed_session_shared
  after update of visibility on public.chat_sessions
  for each row execute function public.trg_feed_session_shared();

-- A routine run, finished or failed. Skipped runs delivered nothing and are
-- not news.
create or replace function public.trg_feed_routine_run()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  r record;
begin
  if new.status not in ('ok', 'failed') then
    return new;
  end if;
  select ro.workspace_id, ro.agent_id, ro.name into r
    from public.routines ro where ro.id = new.routine_id;
  if r.workspace_id is null then
    return new;
  end if;
  perform public.log_feed_event(
    r.workspace_id, null,
    case when new.status = 'ok' then 'routine.run_finished' else 'routine.run_failed' end,
    'routine', new.routine_id, r.name,
    jsonb_build_object('agent_id', r.agent_id, 'run_id', new.id, 'session_id', new.session_id));
  return new;
end $$;

revoke all on function public.trg_feed_routine_run() from public, anon, authenticated;

drop trigger if exists feed_routine_run on public.routine_runs;
create trigger feed_routine_run
  after insert on public.routine_runs
  for each row execute function public.trg_feed_routine_run();

-- Files somebody added by hand. A source's sync and a routine's filing are
-- said elsewhere (the source's line, the run's), so they are not news here.
create or replace function public.trg_feed_document_added()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_workspace_id uuid;
  v_bundle_name text;
begin
  if new.created_by is null or new.connection_id is not null or new.routine_id is not null then
    return new;
  end if;
  select b.workspace_id, b.name into v_workspace_id, v_bundle_name
    from public.knowledge_bundles b where b.id = new.bundle_id;
  if v_workspace_id is null then
    return new;
  end if;
  perform public.log_feed_event(
    v_workspace_id, new.created_by, 'document.added', 'document', new.id, new.name,
    jsonb_build_object('bundle_id', new.bundle_id, 'bundle_name', v_bundle_name));
  return new;
end $$;

revoke all on function public.trg_feed_document_added() from public, anon, authenticated;

drop trigger if exists feed_document_added on public.documents;
create trigger feed_document_added
  after insert on public.documents
  for each row execute function public.trg_feed_document_added();

-- A person said yes to what an agent asked to do.
create or replace function public.trg_feed_turn_approved()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_title text;
begin
  if new.status = 'approved' and old.status is distinct from 'approved' then
    select coalesce(s.title, 'Untitled thread') into v_title
      from public.chat_sessions s where s.id = new.session_id;
    perform public.log_feed_event(
      new.workspace_id, new.user_id, 'turn.approved', 'session', new.session_id,
      coalesce(v_title, 'Untitled thread'),
      jsonb_build_object('agent_id', new.agent_id, 'summary', left(new.summary, 200)));
  end if;
  return new;
end $$;

revoke all on function public.trg_feed_turn_approved() from public, anon, authenticated;

drop trigger if exists feed_turn_approved on public.paused_turns;
create trigger feed_turn_approved
  after update of status on public.paused_turns
  for each row execute function public.trg_feed_turn_approved();

-- What Home's Recent activity reads: the feed's five actions, newest first,
-- each only when the caller can see what it is about. Any member may ask; the
-- admin's audit log (`GET /events`, 0040's policy) stays the admin's.
create or replace function public.workspace_activity(p_workspace_id uuid, p_limit integer default 20)
returns table (
  id            uuid,
  action        text,
  actor_id      uuid,
  actor_name    text,
  actor_avatar  text,
  agent_id      uuid,
  agent_name    text,
  agent_avatar  text,
  subject_type  text,
  subject_id    uuid,
  subject_label text,
  detail        jsonb,
  created_at    timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if auth.uid() is null or not public.is_workspace_member(p_workspace_id) then
    raise exception 'not a member of this workspace' using errcode = '42501';
  end if;

  return query
  select e.id, e.action, e.actor_id, p.name, p.avatar_url,
         a.id, a.name, a.avatar,
         e.subject_type, e.subject_id, e.subject_label, e.detail, e.created_at
    from public.workspace_events e
    left join public.profiles p on p.id = e.actor_id
    left join public.agents a on a.id = nullif(e.detail ->> 'agent_id', '')::uuid
   where e.workspace_id = p_workspace_id
     and e.action in ('session.shared', 'routine.run_finished', 'routine.run_failed',
                      'document.added', 'turn.approved')
     and case
           when e.action in ('session.shared', 'turn.approved')
             then public.session_is_visible(e.subject_id)
           when e.action like 'routine.%'
             then exists (
               select 1 from public.routines r
                where r.id = e.subject_id
                  and r.deleted_at is null
                  and (r.user_id = auth.uid() or r.visibility = 'shared')
                  and public.can_use_agent(r.agent_id))
           when e.action = 'document.added'
             then public.bundle_is_visible(nullif(e.detail ->> 'bundle_id', '')::uuid)
           else false
         end
   order by e.created_at desc
   limit greatest(1, least(coalesce(p_limit, 20), 100));
end $$;

revoke all on function public.workspace_activity(uuid, integer) from public, anon;
grant execute on function public.workspace_activity(uuid, integer) to authenticated, service_role;

-- ---- 4. a failed run waits on its owner ------------------------------------

create or replace function public.inbox_rows(
  p_workspace_id uuid,
  p_filter       text default 'all',
  p_agent_id     uuid default null,
  p_before       timestamptz default null,
  p_limit        integer default 50,
  p_session_ids  uuid[] default null
)
returns table (
  session_id           uuid,
  agent_id             uuid,
  title                text,
  kind                 text,
  visibility           text,
  owner_id             uuid,
  owner_name           text,
  last_activity_at     timestamptz,
  preview_role         text,
  preview_sender_id    uuid,
  preview_sender_name  text,
  preview_text         text,
  preview_at           timestamptz,
  unread_count         integer,
  needs_kind           text,
  needs_paused_turn_id uuid,
  needs_summary        text,
  needs_replies        jsonb,
  needs_since          timestamptz,
  running_steps        integer,
  running_tool         text,
  running_note         text,
  running_since        timestamptz
)
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  with rows as (
    select
      cs.id                                   as session_id,
      cs.agent_id,
      cs.title,
      cs.kind,
      cs.visibility,
      cs.user_id                              as owner_id,
      owner.name                              as owner_name,
      greatest(cs.updated_at, coalesce(last.created_at, cs.updated_at)) as last_activity_at,
      last.role                               as preview_role,
      last.sender_id                          as preview_sender_id,
      case when last.role = 'assistant' then a.name else sender.name end as preview_sender_name,
      left(last.content, 280)                 as preview_text,
      last.created_at                         as preview_at,
      (
        select count(*)::integer
          from public.messages m
         where m.session_id = cs.id
           and m.superseded_at is null
           and (m.role = 'assistant' or m.sender_id is distinct from auth.uid())
           and m.created_at > coalesce(
                 rd.last_read_at,
                 case when cs.user_id = auth.uid() then '-infinity'::timestamptz
                      else 'infinity'::timestamptz end)
      )                                       as unread_count,
      case
        when pt.id is not null then 'approval'
        when cs.user_id = auth.uid() and last.role = 'assistant' and last.ask is not null then 'question'
        when bt.stop_reason = 'login_required' and not exists (
               select 1 from public.messages m2
                where m2.session_id = cs.id and m2.role = 'user'
                  and m2.created_at > coalesce(bt.finished_at, bt.created_at)
             ) then 'login'
        when cs.kind = 'routine' and cs.user_id = auth.uid() and run.status = 'failed'
             and last.role = 'assistant' then 'routine_failed'
      end                                     as needs_kind,
      pt.id                                   as needs_paused_turn_id,
      case
        when pt.id is not null then pt.summary
        when cs.user_id = auth.uid() and last.role = 'assistant' and last.ask is not null
          then last.ask ->> 'question'
        when bt.stop_reason = 'login_required' then bt.signin_host
        when cs.kind = 'routine' and run.status = 'failed' then coalesce(run.error, 'The run failed.')
      end                                     as needs_summary,
      case
        when pt.id is null and cs.user_id = auth.uid() and last.role = 'assistant'
          then last.ask -> 'replies'
      end                                     as needs_replies,
      case
        when pt.id is not null then pt.created_at
        when cs.user_id = auth.uid() and last.role = 'assistant' and last.ask is not null then last.created_at
        when bt.stop_reason = 'login_required' then coalesce(bt.finished_at, bt.created_at)
        when cs.kind = 'routine' and run.status = 'failed' then run.finished_at
      end                                     as needs_since,
      at.steps_done                           as running_steps,
      at.last_tool                            as running_tool,
      at.note                                 as running_note,
      at.started_at                           as running_since
    from public.chat_sessions cs
    join public.agents a on a.id = cs.agent_id
    left join public.profiles owner on owner.id = cs.user_id
    left join lateral (
      select m.role, m.sender_id, m.content, m.created_at, m.ask
        from public.messages m
       where m.session_id = cs.id and m.superseded_at is null
       order by m.created_at desc
       limit 1
    ) last on true
    left join public.profiles sender on sender.id = last.sender_id
    left join public.session_reads rd on rd.session_id = cs.id and rd.user_id = auth.uid()
    left join lateral (
      select p.id, p.summary, p.created_at
        from public.paused_turns p
       where p.session_id = cs.id
         and p.user_id = auth.uid()
         and p.status = 'pending'
         and p.expires_at > now()
       order by p.created_at desc
       limit 1
    ) pt on true
    left join lateral (
      select b.stop_reason, b.signin_host, b.finished_at, b.created_at
        from public.browser_tasks b
       where b.session_id = cs.id and b.user_id = auth.uid()
       order by b.created_at desc
       limit 1
    ) bt on true
    left join lateral (
      select r.status, r.error, r.finished_at
        from public.routine_runs r
       where r.session_id = cs.id
       order by r.started_at desc
       limit 1
    ) run on cs.kind = 'routine'
    left join public.active_turns at
      on at.session_id = cs.id and at.updated_at > now() - interval '30 minutes'
    where cs.workspace_id = p_workspace_id
      and (p_agent_id is null or cs.agent_id = p_agent_id)
      and (p_session_ids is null or cs.id = any (p_session_ids))
  )
  select *
    from rows r
   where (p_before is null or r.last_activity_at < p_before)
     and case coalesce(p_filter, 'all')
           when 'unread'    then r.unread_count > 0
           when 'needs_you' then r.needs_kind is not null
           when 'running'   then r.running_since is not null
           when 'mine'      then r.owner_id = auth.uid()
           else true
         end
   order by r.last_activity_at desc, r.session_id
   limit case when p_limit is null then null else greatest(1, least(p_limit, 200)) end;
$$;
