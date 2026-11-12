-- =========================================================================
-- A browser that asks
--
-- 0141 made a routine's browser a switch: off, or allowed on every run with
-- nothing asked — the switch was the approval, because a tick had nobody to
-- show a card to. Since 0143 a run can ask: it parks on the question for a
-- day and its owner, or an admin, answers it. So the switch gets the middle
-- setting a conversation always had: ask every time.
--
-- 'ask' offers `browse` to the run as 'all' does, and the first browser task
-- of the run parks it on the same card a conversation shows — the task in the
-- agent's own words, what it may cost, the sites the browser is signed into
-- and the saved login it would type. Nothing at the provider is started or
-- billed until somebody says yes. That is the setting for a routine that
-- reaches into somebody's signed-in account on a page: close a seat, change a
-- price, cancel a booking.
-- =========================================================================

alter table public.routines drop constraint if exists routines_browser_access_known;
alter table public.routines
  add constraint routines_browser_access_known check (browser_access in ('off', 'ask', 'all'));
