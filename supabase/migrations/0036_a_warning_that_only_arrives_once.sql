-- =========================================================================
-- A quota warning that only arrives once a period
--
-- `0015` gave people two switches for what the routine engine tells them. This
-- adds the one piece of state a *third* notice needs, and it is state rather
-- than a switch: the warning fires when an allowance crosses three quarters
-- spent, which is a condition that stays true for every request afterwards.
-- Without somewhere to record that it has already been sent, the first message
-- past the threshold would be followed by one per reply until the month rolled
-- over.
--
-- The column holds the period it warned *for*, not the moment it was sent. The
-- question being asked is "have I already warned about this allowance", and the
-- period's own reset time answers it exactly — no arithmetic about month
-- boundaries, and nothing to get wrong when a period is not a calendar month.
-- A fresh period brings a different reset time, so the comparison fails and one
-- warning goes out.
--
-- Nullable with no default: null means never warned, which is every row that
-- exists today and every row a self-hosted Covan will ever have. There is no
-- allowance to warn about when `QUOTA_MONTHLY_TOKENS` is unset, so this column
-- simply stays null there.
--
-- No new switch to go with it. `quota_exhausted` already means "tell me about
-- my allowance", and splitting that into two toggles would ask people to answer
-- the same question twice.
-- =========================================================================

begin;

alter table public.notification_preferences
  add column if not exists quota_warned_for timestamptz;

comment on column public.notification_preferences.quota_warned_for is
  'The reset time of the period a low-quota warning was last sent for. Null means never. Compared for equality against the current period''s reset time, so a new period sends exactly one warning.';

-- The row is written by the API on the caller's behalf, so the existing
-- own-row insert and update policies from 0015 already cover it. Stated here
-- rather than assumed, because a column that nothing may write is the failure
-- 0023 exists to explain.

insert into covan_meta.migrations (filename)
values ('0036_a_warning_that_only_arrives_once.sql')
on conflict do nothing;

commit;
