-- 0073 — a routine that ends
--
-- `routines` has carried `status` since 0012 and nothing else: a routine is
-- `active` or it is `paused`, and there has never been a way for one to be
-- *finished*. 0029 gave invitations an expiry and 0060 gave a paused turn one;
-- this surface never got one, and nobody noticed because every routine so far
-- has been a standing order with no natural end.
--
-- covan-ai/covan#104 is the first that has one. "One message each morning of
-- somebody's first week" is seven mornings, and without this it is a daily job
-- you have to remember to delete — which is a worse product than not offering
-- it, because the thing that arrives on morning nine is addressed to somebody
-- who is no longer new.
--
-- ---- why a third status and not a pause ----------------------------------
--
-- Reusing `paused` would have been free. The machinery is all there:
-- `paused_reason` is a column, `announcePause` already tells the owner, and the
-- due query already skips anything that is not active.
--
-- It is wrong twice. A pause means "this will resume" — so a finished series
-- would sit in the list looking like something to un-pause, and un-pausing it
-- would start morning eight of a seven-morning week. And `paused_reason` is
-- where repeated failures write their explanation, so "your first week is over"
-- and "this has failed five times" would be the same shape of row, read by the
-- same code, shown in the same place.
--
-- That is the mistake 0070's header names in as many words: widening one column
-- to carry two meanings. So: a third value, and the cost of it is one badge.
--
-- The engine needs nothing. `claim_due_routines` (0012) and `routines_due_idx`
-- both select `status = 'active'`, so a completed routine stops being claimed
-- the moment the status changes, with no change to either.
--
-- ---- which runs count ----------------------------------------------------
--
-- Only a delivered one. `runs_done` is incremented on the path that records
-- `status = 'ok'` and nowhere else, and the two exclusions are each the whole
-- reason the column is not just "times this ran":
--
--   * A `failed` run must not consume a morning. A week of a dead delivery
--     channel would otherwise complete a series that sent nothing at all, and
--     the routine would read `completed` having never once been read.
--   * A `skipped` run has nothing to spend a morning on — it looked and there
--     was nothing new, or the model declined.
--
-- ---- no policy change ----------------------------------------------------
--
-- Both columns affect only the routine's own schedule. There is no cross-tenant
-- reach here and nothing for a policy to guard, so `routines_insert_own` and
-- `routines_update_own` are NOT touched — which matters, because 0056's header
-- is explicit that restating a policy is where guards get dropped by accident,
-- and `routine-policy.static.test.ts` exists because that nearly happened. A
-- column with no new guard is covered by those policies exactly as they stand.
--
-- The consequence, accepted and written down: `authenticated` holds a
-- table-level UPDATE on this table from 0023, so an owner can PATCH their own
-- `runs_done` back to zero through PostgREST and restart their own series.
-- Nothing crosses a tenant boundary and nothing bills anybody else — it is
-- their routine, their channel and their own mail.

alter table public.routines
  add column if not exists ends_after_runs int,
  add column if not exists runs_done int not null default 0;

comment on column public.routines.ends_after_runs is
  'After how many DELIVERED runs this routine sets itself to completed. Null '
  'means it runs until somebody stops it, which is every routine before 0073.';

comment on column public.routines.runs_done is
  'Delivered runs so far. Incremented only where routine_runs.status is ok - a '
  'failed or skipped run does not consume one.';

-- Dropped and re-added rather than declared inline: `add column if not exists`
-- carries its inline constraints only on the run that actually adds the column,
-- so a tree where the column already exists would get the column and not the
-- check. 0065's note, and 0070 repeated it.
alter table public.routines drop constraint if exists routines_ends_after_runs_check;
-- Bounded at both ends, and the upper bound is the one that matters: this is a
-- number a client sends, `authenticated` can PATCH it, and a series longer than
-- a year is not a series. Same reasoning and the same shape as 0056's
-- `output_retention`.
alter table public.routines add constraint routines_ends_after_runs_check
  check (ends_after_runs is null or ends_after_runs between 1 and 365);

alter table public.routines drop constraint if exists routines_runs_done_check;
alter table public.routines add constraint routines_runs_done_check
  check (runs_done >= 0);

-- The vocabulary. Dropped by the name Postgres generated in 0012 and rewritten,
-- which is 0047's move for `source_kind` and for the same reason: the inline
-- constraint has a generated name and `add column if not exists` will not
-- replace it.
alter table public.routines drop constraint if exists routines_status_check;
alter table public.routines add constraint routines_status_check
  check (status in ('active', 'paused', 'completed'));
