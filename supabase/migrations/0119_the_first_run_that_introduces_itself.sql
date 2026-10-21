-- =========================================================================
-- The first run that introduces itself
--
-- The first run used to be a survey followed by a form: what you do, what you
-- came for, how big the team is, then name a workspace and build an agent in
-- the middle of it all. The agent was created on the step that asked for it,
-- which is how a reload of that step made a second one (see the note on
-- `resolveStep` in src/lib/onboarding-flow.ts). And it ended on an empty home
-- page, with nothing yet said by the thing that had just been named.
--
-- The new run shows the product first, asks less, and ends in a conversation
-- the assistant opens. Three things change on this side:
--
--   1. `user_onboarding` learns the new answers — what the assistant is called,
--      which tools the person uses, what it is mostly for, whether it is theirs
--      alone or the team's — and a `last_step`, so a reload lands on the screen
--      that was open rather than on the first unanswered question. The old
--      survey columns stay: existing rows carry them, and nothing is gained by
--      forgetting what people said.
--
--   2. `finish_onboarding()` makes the agent and its first conversation ONCE.
--      The row remembers both ids, and the function takes a row lock, so a
--      double tap or a reload of the last screen finds what it made the first
--      time. Security invoker, deliberately: every insert it does is one the
--      caller could do through the API, and the policies stay the judge of it.
--
--   3. `onboarding_events` records how the run went — each step seen,
--      finished or skipped, and how long it took — in a table of our own. No
--      third party sees it, which is what the privacy page promises. The row
--      written at the finish is also the signal a hosted install can act on.
--
-- `text` rather than enums, for 0017's reason: the lists change faster than
-- the schema should, and the API validates against the list it actually
-- supports (worker/src/lib/onboarding.ts). `tools` is nullable on purpose —
-- null is "not asked yet", an empty array is "asked, and skipped" — because
-- resuming a half-finished run has to tell the two apart.
-- =========================================================================

-- ---- 1. the answers --------------------------------------------------------

alter table public.user_onboarding
  add column if not exists assistant_name  text,
  add column if not exists assistant_emoji text,
  add column if not exists assistant_role  text,
  add column if not exists tools           text[],
  add column if not exists purpose         text,
  add column if not exists mode            text,
  add column if not exists last_step       text,
  -- What the finish made. Set null, not cascade: an agent sent to the trash
  -- must not take the record of having finished with it, and a later finish
  -- makes a fresh one.
  add column if not exists agent_id        uuid references public.agents (id) on delete set null,
  add column if not exists session_id      uuid references public.chat_sessions (id) on delete set null;

-- No policy change. The three own-row policies from 0017 cover every column.

-- ---- 2. what happened on the way in ---------------------------------------

create table if not exists public.onboarding_events (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references auth.users (id) on delete cascade,
  -- Minted by the client (or the route, when the client sent none), so a batch
  -- retried after a dropped connection is not counted twice.
  client_id   uuid        not null default gen_random_uuid(),
  step        text        not null,
  event       text        not null check (event in ('viewed', 'completed', 'skipped')),
  at          timestamptz not null,
  elapsed_ms  integer     check (elapsed_ms is null or elapsed_ms >= 0),
  created_at  timestamptz not null default now(),
  -- A plain unique constraint rather than a partial index: PostgREST's
  -- `on_conflict` needs a constraint it can name.
  unique (user_id, client_id)
);

create index if not exists onboarding_events_user_at
  on public.onboarding_events (user_id, at);

alter table public.onboarding_events enable row level security;

drop policy if exists "onboarding_events_select_own" on public.onboarding_events;
create policy "onboarding_events_select_own"
  on public.onboarding_events for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "onboarding_events_insert_own" on public.onboarding_events;
create policy "onboarding_events_insert_own"
  on public.onboarding_events for insert to authenticated
  with check (user_id = auth.uid());

-- No update and no delete: an event happened. The rows go with the account.

-- 0023's rule: the grant lives in the file that makes the table. People may
-- write and read their own rows (the policies above decide which); the
-- service role gets everything, which is what the hosted build's reward reads
-- the finish row with.
grant select, insert on public.onboarding_events to authenticated;
grant all on public.onboarding_events to service_role;

-- ---- 3. the finish ---------------------------------------------------------

-- Makes the assistant the run named and the conversation it opens in, stamps
-- the row, and hands both ids back. Calling it again hands back the same two.
--
-- Security invoker. `agents_insert_*` and `chat_sessions_insert_owner` decide
-- whether this caller may make these rows in this workspace, exactly as they
-- would for POST /agents and POST /sessions; the function adds nothing a
-- policy would refuse. `for update` is what makes it idempotent under a
-- double tap: the second call waits on the first, then finds `agent_id` set.
--
-- An agent that has since gone to the trash is invisible to the select
-- policy (`deleted_at is null`, 0104), so "is it still there" is a plain
-- read, and a missing one is replaced rather than resurrected. The same goes
-- for the session.
--
-- `p_persona` and `p_model` come from the caller rather than the row: the
-- persona templates live in the frontend, as they do for POST /agents, and
-- the model is checked against what the deployment serves by the route.
create or replace function public.finish_onboarding(
  p_workspace_id uuid,
  p_persona text,
  p_model text
)
returns table (agent_id uuid, session_id uuid, created boolean, was_completed boolean)
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  r             public.user_onboarding%rowtype;
  v_agent       uuid;
  v_session     uuid;
  v_created     boolean := false;
  v_model       text;
begin
  select * into r
  from public.user_onboarding
  where user_id = auth.uid()
  for update;

  if not found or r.assistant_name is null then
    raise exception 'name your assistant first' using errcode = 'P0002';
  end if;

  if r.agent_id is not null then
    select id into v_agent from public.agents where id = r.agent_id;
  end if;

  if v_agent is null then
    v_model := coalesce(
      p_model,
      (select w.default_model from public.workspaces w where w.id = p_workspace_id)
    );

    insert into public.agents (
      workspace_id, name, emoji, model, persona, mode, web_search, created_by, workspace_access
    )
    values (
      p_workspace_id,
      r.assistant_name,
      r.assistant_emoji,
      v_model,
      p_persona,
      'normal',
      -- Off, as POST /agents has it since covan#228: the search tool's prompt
      -- overhead is paid on every turn whether or not a search runs.
      false,
      auth.uid(),
      -- "Everyone trains it together" is edit, the level 0104 gave every agent
      -- that existed before sharing was a choice. Solo keeps it private.
      case when r.mode = 'team' then 'edit' else null end
    )
    returning id into v_agent;
    v_created := true;
  end if;

  if r.session_id is not null then
    select cs.id into v_session
    from public.chat_sessions cs
    where cs.id = r.session_id and cs.agent_id = v_agent;
  end if;

  if v_session is null then
    -- Untitled: the first real question titles the thread, as it does for
    -- every other session. The assistant's opening line is not a title.
    insert into public.chat_sessions (agent_id, user_id, workspace_id, title, kind, visibility)
    values (v_agent, auth.uid(), p_workspace_id, null, 'chat', 'private')
    returning id into v_session;
  end if;

  update public.user_onboarding
  set agent_id     = v_agent,
      session_id   = v_session,
      last_step    = 'done',
      completed_at = coalesce(completed_at, now()),
      updated_at   = now()
  where user_id = auth.uid();

  -- Once. This row is what a hosted install watches for; a reload of the last
  -- screen must not look like a second arrival.
  if r.completed_at is null then
    insert into public.onboarding_events (user_id, step, event, at)
    values (auth.uid(), 'finish', 'completed', now());
  end if;

  return query select v_agent, v_session, v_created, (r.completed_at is not null);
end;
$$;

revoke all on function public.finish_onboarding(uuid, text, text) from public, anon;
grant execute on function public.finish_onboarding(uuid, text, text) to authenticated;
