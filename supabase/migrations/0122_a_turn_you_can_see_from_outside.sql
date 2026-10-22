-- =========================================================================
-- A turn you can see from outside
--
-- Until now a running turn was visible only to the tab that started it: the
-- steps streamed to that browser and nowhere else. The redesign shows work in
-- progress everywhere — a breathing dot beside the thread in the sidebar,
-- "Running · step 3" in the Threads table, "Research is running" on Home, the
-- Running filter in the Inbox (A4). Three things make that possible:
--
--   1. `active_turns`: one row per thread while a turn is running in it,
--      written by the worker as the turn goes (started, each step, finished)
--      and deleted when it ends. A row older than thirty minutes is a turn
--      that died without saying so; every reader ignores it and the purge
--      sweeps it.
--
--   2. `messages.ask`: what a reply asks the person, as a question and up to
--      three suggested answers ({"question": text, "replies": [text]}). The
--      `ask_person` tool writes it (worker/src/lib/harness/tools/ask-person.ts)
--      and the thread draws it as the ask card under the reply (A2). A thread
--      whose newest message carries one is waiting on its owner. It is a
--      message rather than a paused turn because nothing is paused: the turn
--      ended, and the answer is the person's next message, whenever it comes.
--
--   3. `inbox_rows`, `inbox_counts` and `session_states`: one read each for
--      the Inbox, its counts (the sidebar, the palette, Home) and the dots
--      beside a list of threads. Security invoker, so every row they see is a
--      row the policies already let the caller see; they add arithmetic, not
--      reach.
--
-- What "needs you" means, in order of precedence, for the thread's owner:
--   approval   a paused turn of theirs, pending and not expired (0060)
--   question   the newest message is a reply carrying an `ask`
--   login      the newest browser run stopped at a sign-in (0078) and they
--              have not written since
-- (Routine runs that failed join this list with 0123.)
-- =========================================================================

-- ---- 1. active_turns -------------------------------------------------------

create table if not exists public.active_turns (
  session_id   uuid        primary key references public.chat_sessions (id) on delete cascade,
  workspace_id uuid        not null references public.workspaces (id) on delete cascade,
  agent_id     uuid        not null references public.agents (id) on delete cascade,
  -- Whoever the turn is answering. Null for a routine's run.
  user_id      uuid        references auth.users (id) on delete set null,
  started_at   timestamptz not null default now(),
  steps_done   integer     not null default 0 check (steps_done >= 0),
  -- The tool the newest step is using, and the sentence the trail shows for it
  -- ("Reading 6 pages"). Never arguments, never a result.
  last_tool    text,
  note         text check (note is null or char_length(note) <= 200),
  updated_at   timestamptz not null default now()
);

create index if not exists active_turns_workspace_idx
  on public.active_turns (workspace_id, updated_at desc);

alter table public.active_turns enable row level security;

drop policy if exists "active_turns_read" on public.active_turns;
create policy "active_turns_read"
  on public.active_turns for select
  using (public.session_is_visible(session_id));

drop policy if exists active_turns_request_workspace on public.active_turns;
create policy active_turns_request_workspace on public.active_turns
  as restrictive for all to authenticated
  using ((select public.request_workspace()) is null
         or workspace_id = (select public.request_workspace()));

-- No write policy for a client role: this is the worker's account of a turn
-- it is in the middle of, for `paused_turns`'s reason (0060).
revoke all on public.active_turns from anon, authenticated;
grant select on public.active_turns to authenticated;
grant select, insert, update, delete on public.active_turns to service_role;

-- ---- 2. what a reply asks ---------------------------------------------------

alter table public.messages
  add column if not exists ask jsonb;

alter table public.messages
  drop constraint if exists messages_ask_shape;
alter table public.messages
  add constraint messages_ask_shape
  check (
    ask is null
    or (
      jsonb_typeof(ask) = 'object'
      and coalesce(jsonb_typeof(ask -> 'question'), '') = 'string'
      and (ask -> 'replies' is null or jsonb_typeof(ask -> 'replies') = 'array')
      and coalesce(jsonb_array_length(ask -> 'replies'), 0) <= 3
    )
  );

-- Written with the reply by the worker; no client grant (0094 keeps the
-- columns a client may write on `messages` to its own turn).

-- ---- 3. the reads -----------------------------------------------------------

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
                 -- A thread of your own you never opened: everything in it is
                 -- news. Somebody else's shared thread you never opened: none
                 -- of it is, until you open it once.
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
      end                                     as needs_kind,
      pt.id                                   as needs_paused_turn_id,
      case
        when pt.id is not null then pt.summary
        when cs.user_id = auth.uid() and last.role = 'assistant' and last.ask is not null
          then last.ask ->> 'question'
        when bt.stop_reason = 'login_required' then bt.signin_host
      end                                     as needs_summary,
      case
        when pt.id is null and cs.user_id = auth.uid() and last.role = 'assistant'
          then last.ask -> 'replies'
      end                                     as needs_replies,
      case
        when pt.id is not null then pt.created_at
        when cs.user_id = auth.uid() and last.role = 'assistant' and last.ask is not null then last.created_at
        when bt.stop_reason = 'login_required' then coalesce(bt.finished_at, bt.created_at)
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
   -- A page is at most 200 rows; null is every row, for the counts below.
   limit case when p_limit is null then null else greatest(1, least(p_limit, 200)) end;
$$;

-- The Inbox's counts and the sidebar's: how many threads are unread, waiting
-- on the caller and running, in all and per agent. One read, every 30 seconds.
create or replace function public.inbox_counts(p_workspace_id uuid)
returns table (
  agent_id   uuid,
  unread     integer,
  needs_you  integer,
  running    integer
)
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select r.agent_id,
         count(*) filter (where r.unread_count > 0)::integer,
         count(*) filter (where r.needs_kind is not null)::integer,
         count(*) filter (where r.running_since is not null)::integer
    from public.inbox_rows(p_workspace_id, 'all', null, null, null, null) r
   where r.unread_count > 0 or r.needs_kind is not null or r.running_since is not null
   group by r.agent_id;
$$;

-- The dot beside each of a list of threads: needs_you, running or done.
create or replace function public.session_states(p_workspace_id uuid, p_session_ids uuid[])
returns table (session_id uuid, state text, unread integer, running_steps integer)
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select r.session_id,
         case when r.needs_kind is not null then 'needs_you'
              when r.running_since is not null then 'running'
              else 'done' end,
         r.unread_count,
         r.running_steps
    from public.inbox_rows(p_workspace_id, 'all', null, null, null, p_session_ids) r;
$$;

revoke all on function public.inbox_rows(uuid, text, uuid, timestamptz, integer, uuid[]) from public, anon;
grant execute on function public.inbox_rows(uuid, text, uuid, timestamptz, integer, uuid[]) to authenticated, service_role;
revoke all on function public.inbox_counts(uuid) from public, anon;
grant execute on function public.inbox_counts(uuid) to authenticated, service_role;
revoke all on function public.session_states(uuid, uuid[]) from public, anon;
grant execute on function public.session_states(uuid, uuid[]) to authenticated, service_role;
