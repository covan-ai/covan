-- =========================================================================
-- Onboarding
--
-- What a new account told us about itself on the way in: what they do, what
-- they came for, how big the team is, and where they heard about us. Three of
-- those four change what the first run does — role and use case pre-fill the
-- first agent, team size decides whether the invite step is offered at all.
-- Referral changes nothing for the user, which is why it is asked last, stays
-- optional, and is only asked at all on a hosted install.
--
-- A missing row means onboarding has not finished. That is deliberate: the
-- signup trigger is left alone, and the row appears with the first answer. A
-- row whose `completed_at` is null is someone who started and walked away — the
-- flow resumes them where they stopped.
--
-- The columns are `text` rather than enums for the reason 0014 gives for
-- `default_model`: the option list changes faster than the schema should, so
-- the API validates against the list it actually supports
-- (worker/src/lib/onboarding.ts). A value that falls out of the list later
-- breaks nothing — it becomes "other" in a chart.
-- =========================================================================

create table if not exists public.user_onboarding (
  user_id         uuid        primary key references auth.users (id) on delete cascade,
  role            text,
  use_case        text,
  team_size       text,
  referral_source text,
  completed_at    timestamptz,
  updated_at      timestamptz not null default now()
);

alter table public.user_onboarding enable row level security;

drop policy if exists "user_onboarding_select_own" on public.user_onboarding;
create policy "user_onboarding_select_own"
  on public.user_onboarding for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "user_onboarding_insert_own" on public.user_onboarding;
create policy "user_onboarding_insert_own"
  on public.user_onboarding for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists "user_onboarding_update_own" on public.user_onboarding;
create policy "user_onboarding_update_own"
  on public.user_onboarding for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- No delete policy: the row is cascaded away with the user, and short of that
-- there is no reason to remove it. Deleting it would read as "never onboarded"
-- and put a working account back through the wizard.

-- ---- backfill --------------------------------------------------------------
-- Everyone who already has an account has already done their first run, by
-- definition. Without this they would all meet the wizard on their next
-- sign-in. `completed_at` is stamped with when they signed up, which is the
-- closest true answer available.
insert into public.user_onboarding (user_id, completed_at)
select id, created_at from public.profiles
on conflict (user_id) do nothing;
