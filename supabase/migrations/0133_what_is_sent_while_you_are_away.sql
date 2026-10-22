-- =========================================================================
-- What is sent while you are away
--
-- The three emails 0127 and 0128 made switches for:
--
--   * "An agent needs me and I have been away for an hour" (A16, on by
--     default). Something waits on a person — an action to approve (0060) or
--     a question an agent asked (0122) — and that person has not had Covan
--     open for an hour: `workspace_members.last_seen_at`, which the app
--     stamps while it is open (0128). One email per thing, ever: the
--     approval's `reminded_at` (0128), the question's `ask_reminded_at`
--     below. Five minutes' grace first, so something answered at once is
--     never mailed about.
--   * "Weekly summary, Monday morning" (A16, off) and "Weekly usage summary —
--     credits and threads per agent, sent to owners and admins" (A9, off).
--     Both go out once a week, after 08:00 on Monday in the workspace's own
--     time zone (0127; UTC without one). `claim_weekly_summaries` stamps
--     `weekly_usage_sent_for` with that Monday as it hands a workspace out,
--     so a week is claimed once however many ticks see it.
--   * "A routine fails" (A16, on) needs nothing here: the engine reads the
--     owner's switch when a run fails (worker/src/lib/routines/executor.ts).
--
-- Both claims are the engine's: granted to the service role alone.
-- =========================================================================

alter table public.messages
  add column if not exists ask_reminded_at timestamptz;

-- A zone Postgres knows, or UTC: a name the shape check (0127) let through
-- but `at time zone` does not know must not stop every workspace's summary.
create or replace function public.known_timezone(p_name text)
returns text
language sql
stable
set search_path = pg_catalog, public
as $$
  select case
    when p_name is not null and exists (select 1 from pg_catalog.pg_timezone_names t where t.name = p_name)
      then p_name
    else 'UTC'
  end;
$$;

-- `p_now` is for the tests: a week's Monday cannot be waited for.
create or replace function public.claim_weekly_summaries(
  p_limit integer,
  p_now   timestamptz default now()
)
returns table (
  workspace_id       uuid,
  name               text,
  timezone           text,
  week_of            date,
  weekly_usage_email boolean
)
language sql
security definer
set search_path = pg_catalog, public
as $$
  with local as (
    select w.id,
           (p_now at time zone public.known_timezone(w.timezone)) as here
      from public.workspaces w
     where w.deletes_at is null
       and (
         w.weekly_usage_email
         or exists (
           select 1
             from public.workspace_members m
             join public.notification_preferences np on np.user_id = m.user_id
            where m.workspace_id = w.id and np.weekly_summary
         )
       )
  ),
  due as (
    select w.id, l.here::date as monday
      from local l
      join public.workspaces w on w.id = l.id
     where extract(isodow from l.here) = 1
       and extract(hour from l.here) >= 8
       and (w.weekly_usage_sent_for is null or w.weekly_usage_sent_for < l.here::date)
     order by w.id
     limit greatest(least(coalesce(p_limit, 2), 20), 1)
     for update of w skip locked
  )
  update public.workspaces w
     set weekly_usage_sent_for = due.monday
    from due
   where w.id = due.id
  returning w.id, w.name, public.known_timezone(w.timezone), due.monday, w.weekly_usage_email;
$$;

-- Each thing waiting on somebody who has been away an hour and wants to be
-- told, marked as told as it is handed out.
create or replace function public.claim_needs_you_reminders(p_limit integer)
returns table (
  kind           text,
  ref_id         uuid,
  user_id        uuid,
  workspace_id   uuid,
  workspace_name text,
  session_id     uuid,
  session_title  text,
  agent_id       uuid,
  agent_name     text,
  summary        text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_limit integer := greatest(least(coalesce(p_limit, 10), 50), 1);
begin
  return query
  with due as (
    select p.id
      from public.paused_turns p
      join public.workspace_members wm
        on wm.workspace_id = p.workspace_id and wm.user_id = p.user_id
      left join public.notification_preferences np on np.user_id = p.user_id
     where p.status = 'pending'
       and p.reminded_at is null
       and p.expires_at > now()
       and p.created_at < now() - interval '5 minutes'
       and (wm.last_seen_at is null or wm.last_seen_at < now() - interval '1 hour')
       and coalesce(np.needs_me_away, true)
     order by p.created_at
     limit v_limit
     for update of p skip locked
  ),
  marked as (
    update public.paused_turns p
       set reminded_at = now()
      from due
     where p.id = due.id
    returning p.*
  )
  select 'approval'::text, m.id, m.user_id, m.workspace_id, w.name, m.session_id,
         coalesce(s.title, 'Untitled thread'), m.agent_id, a.name, left(m.summary, 300)
    from marked m
    join public.workspaces w on w.id = m.workspace_id
    join public.chat_sessions s on s.id = m.session_id
    join public.agents a on a.id = m.agent_id;

  return query
  with due as (
    select msg.id
      from public.messages msg
      join public.chat_sessions s on s.id = msg.session_id and s.deleted_at is null
      join public.workspace_members wm
        on wm.workspace_id = s.workspace_id and wm.user_id = s.user_id
      left join public.notification_preferences np on np.user_id = s.user_id
     where msg.ask is not null
       and msg.ask_reminded_at is null
       and msg.created_at < now() - interval '5 minutes'
       and msg.created_at > now() - interval '24 hours'
       and not exists (
         select 1 from public.messages later
          where later.session_id = msg.session_id
            and later.role = 'user'
            and later.created_at > msg.created_at
       )
       and (wm.last_seen_at is null or wm.last_seen_at < now() - interval '1 hour')
       and coalesce(np.needs_me_away, true)
     order by msg.created_at
     limit v_limit
     for update of msg skip locked
  ),
  marked as (
    update public.messages msg
       set ask_reminded_at = now()
      from due
     where msg.id = due.id
    returning msg.id, msg.session_id, msg.ask
  )
  select 'question'::text, m.id, s.user_id, s.workspace_id, w.name, m.session_id,
         coalesce(s.title, 'Untitled thread'), s.agent_id, a.name,
         left(m.ask ->> 'question', 300)
    from marked m
    join public.chat_sessions s on s.id = m.session_id
    join public.workspaces w on w.id = s.workspace_id
    join public.agents a on a.id = s.agent_id;
end $$;

revoke all on function public.known_timezone(text) from public, anon;
grant execute on function public.known_timezone(text) to authenticated, service_role;
revoke all on function public.claim_weekly_summaries(integer, timestamptz) from public, anon, authenticated;
grant execute on function public.claim_weekly_summaries(integer, timestamptz) to service_role;
revoke all on function public.claim_needs_you_reminders(integer) from public, anon, authenticated;
grant execute on function public.claim_needs_you_reminders(integer) to service_role;
