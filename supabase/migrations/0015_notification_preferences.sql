-- =========================================================================
-- Notification preferences
--
-- Which engine notices a person wants. Not which routine output they want —
-- that is the routine's whole purpose and is governed by the routine itself.
-- These are the messages the engine sends *about* a routine:
--
--   routine_paused    a routine stopped after repeated failures
--   quota_exhausted   a run was skipped because the allowance is spent
--
-- A missing row means "everything on". That is what keeps existing users
-- behaving exactly as they did before this table existed, and it is why the
-- engine must read the row as optional rather than requiring one.
-- =========================================================================

create table if not exists public.notification_preferences (
  user_id         uuid        primary key references auth.users (id) on delete cascade,
  routine_paused  boolean     not null default true,
  quota_exhausted boolean     not null default true,
  updated_at      timestamptz not null default now()
);

alter table public.notification_preferences enable row level security;

drop policy if exists "notification_preferences_select_own" on public.notification_preferences;
create policy "notification_preferences_select_own"
  on public.notification_preferences for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "notification_preferences_insert_own" on public.notification_preferences;
create policy "notification_preferences_insert_own"
  on public.notification_preferences for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists "notification_preferences_update_own" on public.notification_preferences;
create policy "notification_preferences_update_own"
  on public.notification_preferences for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- No delete policy: removing the row is indistinguishable from never having had
-- one, and both mean "everything on". Turning a notice off is an update.
