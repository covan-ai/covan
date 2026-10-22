-- =========================================================================
-- A first agent with a face
--
-- The first run is three steps now (A14, A29): name the workspace, set up the
-- first agent, give it its first documents. The agent step asks for a mark
-- instead of an emoji (0120) and for what the agent should do — a few jobs
-- picked from chips ("Answer customer questions", "Draft replies") — from
-- which the persona is written. Both are answers like the others in this
-- row, kept so a reload resumes with them, and `finish_onboarding` makes the
-- agent wear the mark.
--
-- `assistant_jobs` is text[] with each element shaped like a step id, at most
-- eight: the chips are the interface's, and the database only keeps them from
-- being a place to put anything else. `assistant_emoji` stays, unread by the
-- new run, as `agents.emoji` does.
-- =========================================================================

alter table public.user_onboarding
  add column if not exists assistant_avatar text,
  add column if not exists assistant_jobs   text[];

alter table public.user_onboarding
  drop constraint if exists user_onboarding_assistant_avatar_check;
alter table public.user_onboarding
  add constraint user_onboarding_assistant_avatar_check
  check (assistant_avatar is null or assistant_avatar in (
    'headset', 'fox', 'owl', 'bear', 'cat', 'robot', 'penguin', 'blob'
  ));

alter table public.user_onboarding
  drop constraint if exists user_onboarding_assistant_jobs_check;
alter table public.user_onboarding
  add constraint user_onboarding_assistant_jobs_check
  check (
    assistant_jobs is null
    or (
      cardinality(assistant_jobs) <= 8
      and array_to_string(assistant_jobs, ',') ~ '^([a-z][a-z0-9_-]{0,39})?(,[a-z][a-z0-9_-]{0,39})*$'
    )
  );

-- 0119's function, unchanged but for the mark.
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
      workspace_id, name, emoji, avatar, model, persona, mode, web_search, created_by,
      workspace_access
    )
    values (
      p_workspace_id,
      r.assistant_name,
      r.assistant_emoji,
      r.assistant_avatar,
      v_model,
      p_persona,
      'normal',
      false,
      auth.uid(),
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

  if r.completed_at is null then
    insert into public.onboarding_events (user_id, step, event, at)
    values (auth.uid(), 'finish', 'completed', now());
  end if;

  return query select v_agent, v_session, v_created, (r.completed_at is not null);
end;
$$;

revoke all on function public.finish_onboarding(uuid, text, text) from public, anon;
grant execute on function public.finish_onboarding(uuid, text, text) to authenticated;
