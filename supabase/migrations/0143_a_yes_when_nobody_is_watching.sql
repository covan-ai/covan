-- =========================================================================
-- A yes when nobody is watching
--
-- An agent working on a schedule, on an event or on a wake-up it set for
-- itself had no way to ask. Every change that needed a person's yes was
-- refused on the spot (`run_tool`, `http_request`), and the report said what
-- it had stopped short of. So a routine told "when the mail about closing a
-- seat arrives, close it" could read the mail at 03:00 and do nothing about
-- it but say so.
--
-- This migration is the engine for asking instead, and nothing in it is
-- switched on yet: no tool parks an unattended turn until the next migration
-- (0144) and the code that ships with it. What is here:
--
-- 1. `paused_turns` learns where a turn was parked from (`origin`), which
--    routine run it belongs to, who answered and how, and the two stamps
--    the cron's resume is claimed and settled by. No new table: 0060 made
--    this one general on purpose, for 0058's ask -> pending -> approved, and
--    a routine already has a conversation of its own to park in
--    (`openRoutineConversation`, 0100) — so `session_id NOT NULL` is no
--    obstacle and its old comment's argument is retired below.
--
-- 2. A routine run knows what it is waiting for (`waiting_for`) and until
--    when (`held_until`), so the two-hour sweep that sends a report waiting
--    on its browser does not send one waiting on a person for a day.
--
-- 3. Answering is a definer function, not a worker check. The chat card's
--    rule (only the person whose standing the tool runs with may answer)
--    widens here for one case: a workspace admin may answer for a ROUTINE's
--    request, because a routine is the team's standing order and its owner
--    may be asleep. Nothing else widens — not a conversation's question, not
--    a woken turn's.
--
-- 4. The cron's two claims: the answered requests to carry on with, and the
--    unanswered ones whose day is over — or that were carried on with and
--    never came back.
--
-- **Exactly once.** A yes is turned into a side effect by a person's money
-- and their name. The answer is one conditional update (`status = 'pending'`
-- to an answer), and the resume is claimed once by `resume_attempted_at` and
-- never retried: a resume that dies half way is reported, after fifteen
-- minutes, as interrupted — "approved, but it was cut off; check whether it
-- happened" — rather than run a second time.
-- =========================================================================

-- ---- 1. paused_turns ------------------------------------------------------

alter table public.paused_turns
  -- Where the turn was parked from. `chat` is a person's conversation, and
  -- is answered there (`POST /chat/confirm/:id`), in the request that then
  -- runs the rest of the turn. `routine` is a routine's run; `wake` is a
  -- wake-up the agent set for itself in a conversation (0142). Those two are
  -- answered anywhere and carried on with by the cron.
  add column if not exists origin text not null default 'chat'
    check (origin in ('chat', 'routine', 'wake')),
  -- The run whose report waits on the answer. Cascade, for 0142's reason: a
  -- run that is gone has nothing to carry on.
  add column if not exists routine_run_id uuid
    references public.routine_runs (id) on delete cascade,
  -- Who answered: the owner, or for a routine an admin (`answer_approval`).
  -- Set null if that account goes, so the answer outlives the person.
  add column if not exists resolved_by uuid
    references auth.users (id) on delete set null,
  -- How: the conversation's card, the approvals page (the email's link opens
  -- it), or a reply to the email (0147).
  add column if not exists resolved_via text
    check (resolved_via in ('chat', 'app', 'reply')),
  -- The cron's claim on carrying on, set once and never cleared.
  add column if not exists resume_attempted_at timestamptz,
  -- And its end: carried on, declined, expired, or reported as interrupted.
  add column if not exists resumed_at timestamptz;

-- A conversation's question is answered in its conversation and nowhere else,
-- so only an unattended one may carry a run.
alter table public.paused_turns drop constraint if exists paused_turns_run_is_unattended;
alter table public.paused_turns add constraint paused_turns_run_is_unattended
  check (routine_run_id is null or origin <> 'chat');

comment on table public.paused_turns is
  'An agent turn stopped to ask a person for permission (0060). In a '
  'conversation (origin chat) the person answers on the card and the same '
  'request runs the rest of the turn. On a schedule, an event or a wake-up '
  '(origin routine or wake, 0143) the turn parks in the routine''s or the '
  'conversation''s own thread for a day, anybody allowed answers it anywhere, '
  'and the cron carries on exactly once.';

-- The cron's claim: answered, unattended, not yet carried on.
create index if not exists paused_turns_answered_idx
  on public.paused_turns (resolved_at)
  where origin <> 'chat' and resume_attempted_at is null
    and status in ('approved', 'declined');

-- A run's question: is anything of mine still waiting on a person?
create index if not exists paused_turns_run_idx
  on public.paused_turns (routine_run_id)
  where routine_run_id is not null;

-- What a screen may read of the new columns: all of them. None is the prompt;
-- the request page says who answered, how, and whether it has carried on.
grant select (origin, routine_run_id, resolved_by, resolved_via, resume_attempted_at, resumed_at)
  on public.paused_turns to authenticated;

-- An admin sees a routine's requests in their workspace, as the summary and
-- the proposal: the sentence and the arguments, which is what they are asked
-- to agree to. Not the thread — the routine's conversation is its owner's
-- and private — and not `messages` or `tool_call`, which 0060's column grant
-- withholds from everybody. Not a conversation's question, and not a woken
-- turn's: those are somebody's own conversation.
drop policy if exists "paused_turns_read_admin_unattended" on public.paused_turns;
create policy "paused_turns_read_admin_unattended"
  on public.paused_turns for select
  to authenticated
  using (origin = 'routine' and routine_run_id is not null
         and public.is_workspace_admin(workspace_id));

-- The feed's line names who said yes, which on a routine's request may be an
-- admin rather than the owner (0123 named the owner always).
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
      new.workspace_id, coalesce(new.resolved_by, new.user_id), 'turn.approved', 'session',
      new.session_id, coalesce(v_title, 'Untitled thread'),
      jsonb_build_object('agent_id', new.agent_id, 'summary', left(new.summary, 200)));
  end if;
  return new;
end $$;

revoke all on function public.trg_feed_turn_approved() from public, anon, authenticated;

-- ---- 2. routine_runs ------------------------------------------------------

alter table public.routine_runs
  -- What a `waiting` run waits for. Null is the browser, which is what every
  -- waiting row meant before this column (0100).
  add column if not exists waiting_for text
    check (waiting_for in ('browser', 'approval')),
  -- The last moment the sweep should leave it alone. Null is 0100's two
  -- hours from `started_at`. A run waiting on a person holds until a little
  -- after the request expires, so the expiry, not the sweep, finishes it.
  add column if not exists held_until timestamptz;

-- ---- 3. answering ---------------------------------------------------------
--
-- One body for both doors. Who may answer:
--
--   - the person the turn runs as (`user_id`), always; and
--   - for a routine's request, an admin of its workspace.
--
-- A conversation's question is refused (22023): its card answers it, in the
-- request that runs the rest of the turn. Somebody outside the workspace is
-- told there is no such request (P0002); a member who may not answer is
-- refused (42501) — the owner's colleagues in a shared conversation can see a
-- woken turn's question, and still may not answer it.
--
-- Returns what happened: 'approved' or 'declined' for this answer, or
-- 'already' / 'expired' for one that came too late. The update's own
-- `status = 'pending'` is what makes two answers at once one answer.
create or replace function public.answer_approval_for(
  p_id uuid,
  p_user_id uuid,
  p_approve boolean,
  p_via text
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v public.paused_turns;
  v_admin boolean;
  v_answer text := case when p_approve then 'approved' else 'declined' end;
begin
  if p_user_id is null then
    raise exception 'nobody to answer as' using errcode = '42501';
  end if;
  if p_via not in ('app', 'reply') then
    raise exception 'unknown way of answering' using errcode = '22023';
  end if;

  select * into v from public.paused_turns p where p.id = p_id;
  if not found then
    raise exception 'no such request' using errcode = 'P0002';
  end if;

  -- Somebody outside the workspace learns nothing, the owner included once
  -- they have left it.
  select wm.role = 'admin' into v_admin
    from public.workspace_members wm
   where wm.workspace_id = v.workspace_id and wm.user_id = p_user_id;
  if not found then
    raise exception 'no such request' using errcode = 'P0002';
  end if;

  if v.user_id <> p_user_id
     and not (v.origin = 'routine' and v.routine_run_id is not null and v_admin) then
    raise exception 'this is not yours to answer' using errcode = '42501';
  end if;

  if v.origin = 'chat' then
    raise exception 'answer this in its conversation' using errcode = '22023';
  end if;

  if v.status <> 'pending' then
    return 'already';
  end if;
  if v.expires_at <= now() then
    return 'expired';
  end if;

  update public.paused_turns p
     set status = v_answer,
         resolved_at = now(),
         resolved_by = p_user_id,
         resolved_via = p_via
   where p.id = p_id
     and p.status = 'pending'
     and p.expires_at > now();
  if not found then
    return 'already';
  end if;
  return v_answer;
end $$;

-- Internal: callable only from the two doors below, which say who is asking.
revoke all on function public.answer_approval_for(uuid, uuid, boolean, text)
  from public, anon, authenticated, service_role;

-- The app's door: the caller is whoever signed in. Not an API key: a key is a
-- program, and a yes is a person's (`routes/approvals.ts` refuses one first,
-- and this refuses it again).
create or replace function public.answer_approval(p_id uuid, p_approve boolean)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if public.request_workspace() is not null then
    raise exception 'an API key cannot answer for a person' using errcode = '42501';
  end if;
  return public.answer_approval_for(p_id, auth.uid(), p_approve, 'app');
end $$;

revoke all on function public.answer_approval(uuid, boolean) from public, anon;
grant execute on function public.answer_approval(uuid, boolean) to authenticated;

-- The email's door (0147): the worker has matched a reply to an account and
-- passes it here. Nothing signed-in may call it.
create or replace function public.answer_approval_as(
  p_id uuid,
  p_user_id uuid,
  p_approve boolean
)
returns text
language sql
security definer
set search_path = pg_catalog, public
as $$
  select public.answer_approval_for(p_id, p_user_id, p_approve, 'reply');
$$;

revoke all on function public.answer_approval_as(uuid, uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.answer_approval_as(uuid, uuid, boolean) to service_role;

-- ---- 4. the cron's two claims ---------------------------------------------

-- The answered requests to carry on with, each handed out once.
-- `resume_attempted_at` is set in the statement that selects, so two ticks
-- never carry on with the same yes, and it is never cleared: a resume that
-- dies is not retried (see `expire_unattended_approvals`).
create or replace function public.claim_answered_approvals(p_limit int default 1)
returns setof public.paused_turns
language sql
security definer
set search_path = pg_catalog, public
as $$
  update public.paused_turns p
     set resume_attempted_at = now()
   where p.id in (
     select q.id from public.paused_turns q
      where q.origin <> 'chat'
        and q.resume_attempted_at is null
        and q.status in ('approved', 'declined')
      order by q.resolved_at
      for update skip locked
      limit greatest(least(coalesce(p_limit, 1), 10), 1)
   )
  returning p.*;
$$;

revoke all on function public.claim_answered_approvals(int) from public, anon, authenticated;
grant execute on function public.claim_answered_approvals(int) to service_role;

-- The requests nobody will carry on with: a day passed with no answer
-- ('expired'), or a resume was claimed and never settled ('interrupted').
-- Both are marked settled in the statement that returns them, so each is
-- reported once; the worker finishes the run with a note and no model call.
create or replace function public.expire_unattended_approvals(
  p_limit int default 5,
  p_stale_after interval default interval '15 minutes'
)
returns table (
  id             uuid,
  reason         text,
  workspace_id   uuid,
  agent_id       uuid,
  user_id        uuid,
  session_id     uuid,
  message_id     uuid,
  routine_run_id uuid,
  origin         text,
  summary        text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_limit int := greatest(least(coalesce(p_limit, 5), 20), 1);
begin
  return query
  with due as (
    select q.id from public.paused_turns q
     where q.origin <> 'chat'
       and q.status = 'pending'
       and q.expires_at <= now()
     order by q.expires_at
     for update skip locked
     limit v_limit
  )
  update public.paused_turns p
     set status = 'expired',
         resolved_at = now(),
         resume_attempted_at = now(),
         resumed_at = now()
    from due
   where p.id = due.id
  returning p.id, 'expired'::text, p.workspace_id, p.agent_id, p.user_id, p.session_id,
            p.message_id, p.routine_run_id, p.origin, p.summary;

  return query
  with stale as (
    select q.id from public.paused_turns q
     where q.origin <> 'chat'
       and q.status = 'approved'
       and q.resumed_at is null
       and q.resume_attempted_at < now() - p_stale_after
     order by q.resume_attempted_at
     for update skip locked
     limit v_limit
  )
  update public.paused_turns p
     set resumed_at = now()
    from stale
   where p.id = stale.id
  returning p.id, 'interrupted'::text, p.workspace_id, p.agent_id, p.user_id, p.session_id,
            p.message_id, p.routine_run_id, p.origin, p.summary;
end $$;

revoke all on function public.expire_unattended_approvals(int, interval)
  from public, anon, authenticated;
grant execute on function public.expire_unattended_approvals(int, interval) to service_role;
