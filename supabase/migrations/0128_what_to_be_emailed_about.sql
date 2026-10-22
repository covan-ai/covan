-- =========================================================================
-- What to be emailed about, and who has been here lately
--
-- Settings › Preferences (A16) has three switches under "Email me when —
-- everything else stays in the Inbox": an agent needs me and I have been away
-- for an hour (on), a routine fails (on), a weekly summary on Monday morning
-- (off). They are three more columns on `notification_preferences` (0015),
-- the caller's own row, with the defaults a missing row already means.
--
-- "Away for an hour" needs to know when somebody was last here, which is also
-- the Team table's Last active (A3). `workspace_members.last_seen_at` is
-- stamped by `touch_presence()` when Home or the Inbox is read — a definer
-- function that writes the caller's own row and nothing else. There is
-- deliberately NO update policy for members on `workspace_members`: one would
-- be OR-ed with the admin's and let a member rewrite their own role.
-- `paused_turns.reminded_at` keeps the reminder to one per question.
--
-- And the account's own sign-ins (A16 › Security): the sessions GoTrue holds
-- for the caller and the providers they signed in with. `auth` is outside
-- RLS, so each is a definer function that answers for `auth.uid()` alone and
-- returns only what the screen shows — never a token, never an address.
-- =========================================================================

alter table public.notification_preferences
  add column if not exists needs_me_away  boolean not null default true,
  add column if not exists routine_failed boolean not null default true,
  add column if not exists weekly_summary boolean not null default false;

-- An upsert keyed on user_id: the same columns both ways (0094).
grant insert (needs_me_away, routine_failed, weekly_summary) on public.notification_preferences to authenticated;
grant update (needs_me_away, routine_failed, weekly_summary) on public.notification_preferences to authenticated;

alter table public.paused_turns
  add column if not exists reminded_at timestamptz;

alter table public.workspace_members
  add column if not exists last_seen_at timestamptz;

create or replace function public.touch_presence(p_workspace_id uuid)
returns void
language sql
security definer
set search_path = pg_catalog, public
as $$
  update public.workspace_members
     set last_seen_at = now()
   where workspace_id = p_workspace_id
     and user_id = auth.uid()
     and (last_seen_at is null or last_seen_at < now() - interval '1 minute');
$$;

-- ---- the account's own sign-ins ------------------------------------------

create or replace function public.my_sessions()
returns table (id uuid, user_agent text, created_at timestamptz, last_seen_at timestamptz, current boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id,
         s.user_agent,
         s.created_at,
         coalesce(s.refreshed_at::timestamptz, s.updated_at, s.created_at),
         coalesce(s.id::text = (auth.jwt() ->> 'session_id'), false)
    from auth.sessions s
   where s.user_id = auth.uid()
     and (s.not_after is null or s.not_after > now())
   order by 4 desc;
$$;

create or replace function public.revoke_my_session(p_session_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_session_id::text = (auth.jwt() ->> 'session_id') then
    raise exception 'sign out of this device from the account menu' using errcode = '22023';
  end if;
  delete from auth.sessions s where s.id = p_session_id and s.user_id = auth.uid();
  return found;
end $$;

create or replace function public.my_identities()
returns table (provider text, email text, created_at timestamptz, last_sign_in_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select i.provider, i.email, i.created_at, i.last_sign_in_at
    from auth.identities i
   where i.user_id = auth.uid()
   order by i.created_at;
$$;

revoke all on function public.touch_presence(uuid) from public, anon;
grant execute on function public.touch_presence(uuid) to authenticated, service_role;
revoke all on function public.my_sessions() from public, anon;
grant execute on function public.my_sessions() to authenticated, service_role;
revoke all on function public.revoke_my_session(uuid) from public, anon;
grant execute on function public.revoke_my_session(uuid) to authenticated, service_role;
revoke all on function public.my_identities() from public, anon;
grant execute on function public.my_identities() to authenticated, service_role;
