-- =========================================================================
-- What to be asked about
--
-- 0143 built the engine for a yes given while nobody was watching; this is
-- the switch that turns it on in the product, and it is a column because the
-- product's half of it is an email.
--
-- From this migration's code on, a routine's run, an event's run and a
-- wake-up the agent set for itself no longer refuse a change that needs a
-- person: they park on the question for a day and ask the person the turn
-- runs as. Asking is an email the moment the request is made — not the
-- reminder an hour later (0133), which is for somebody who walked away from
-- a conversation they were in. A request at 03:00 is somebody being woken
-- by their own routine, so it is a switch of its own on Settings ›
-- Preferences, on by default: a routine that waits a day on a question
-- nobody was told about is a routine that silently did nothing.
--
-- Turning it off stops the email and nothing else. The request still waits
-- in the Inbox, an admin can still answer a routine's, and the hourly
-- reminder still follows its own switch.
-- =========================================================================

alter table public.notification_preferences
  add column if not exists approval_requests boolean not null default true;

-- An upsert keyed on user_id: the same columns both ways (0094).
grant insert (approval_requests) on public.notification_preferences to authenticated;
grant update (approval_requests) on public.notification_preferences to authenticated;
