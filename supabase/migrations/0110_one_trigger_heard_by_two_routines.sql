-- =========================================================================
-- One trigger, heard by two routines
--
-- 0109 made `(provider, external_id)` unique on
-- `routine_event_subscriptions`, on the assumption that a provider's id for
-- an arrangement names one arrangement and so one routine. The first real
-- provider breaks that assumption on purpose. Composio's create is an upsert:
-- ask for the same trigger type on the same connected account with the same
-- settings, and it answers with the instance that already exists instead of a
-- second one. Two routines that both wait for "a new email in the inbox" on the
-- same Gmail therefore get the same `ti_…` back, and the second one's write of
-- it failed the index — a routine that could never be set up, retried forever
-- with "could not reach Gmail" on its page.
--
-- The code already treats a shared id as shared (`lib/routines/events/
-- composio.ts`): a delivery is offered to every row that holds it, and an
-- instance is ended at the provider only when no other row still names it.
-- So the index stays — the lookup by id is the question every delivery asks —
-- and stops being unique.
--
-- WHAT THIS DELIBERATELY DOES NOT DO.
--
--   * It does not add a table of trigger instances with routines pointing at
--     them. That would be the normalised shape, and it would be a second place
--     for the provider's state to drift from, kept in step by code that runs
--     on every subscribe and release. A shared id is rare — two routines with
--     identical settings on one account — and counting the rows that hold it
--     at the moment of unsubscribing is one indexed read.
--
--   * It does not change who may see or write the rows. 0109's policies and
--     grants are untouched: an index is not a permission.
-- =========================================================================

drop index if exists public.routine_event_subscriptions_external_idx;

create index if not exists routine_event_subscriptions_external_idx
  on public.routine_event_subscriptions (provider, external_id)
  where external_id is not null;
