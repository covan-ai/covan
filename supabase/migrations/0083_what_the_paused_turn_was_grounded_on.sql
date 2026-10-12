-- 0083_what_the_paused_turn_was_grounded_on.sql
--
-- A turn that stops to ask before it has said anything has no assistant row
-- yet, so when it resumes `POST /chat/confirm/:id` INSERTs one. That insert
-- wrote every column the reply needs except the two that say what grounded it:
-- `sources` and `grounding` (0005, 0039). Nothing at resume time knew them.
-- The retrieval ran in the request that parked, and `paused_turns` carried the
-- prompt, the steps and the spend (0060, 0065) but nothing about retrieval.
--
-- Measured on 2026-10-09 (covan-cloud#316): one workspace, seven days, 57
-- assistant answers, 17 with `grounding` null, all real model replies, 13 of
-- them written by exactly this insert. That is the 30% the coverage screen
-- (0053) and the gap report (0076) count as "unrecorded". It is also the 30%
-- most likely to BE a gap: a turn reaches for a tool precisely when the
-- documents did not have the answer.
--
-- So the two columns are parked with the turn and spread into the row it
-- resumes into. Same rule as `usage` (0065): written only when there is no
-- reply row yet. Once a row exists it already carries both, and the resume
-- UPDATEs it without touching them.
--
-- Null, no default, no backfill. A row parked before this migration has no
-- value to recover, and null is what the column on `messages` already means:
-- nobody recorded one.

alter table public.paused_turns add column if not exists grounding text;
alter table public.paused_turns add column if not exists sources jsonb;

-- The vocabulary of `messages_grounding_valid` (0039), minus its role half:
-- every paused turn is the assistant's. Separately from the `add column` so a
-- second run of this file re-asserts it, the shape 0065 uses.
alter table public.paused_turns drop constraint if exists paused_turns_grounding_valid;
alter table public.paused_turns add constraint paused_turns_grounding_valid
  check (grounding is null or grounding in ('chunks', 'documents', 'none'));

comment on column public.paused_turns.grounding is
  'What grounded the turn when it parked, as messages.grounding (0039). Written into the reply when the turn resumes into a new row. Null when a reply row already holds it, and on every row parked before 0083.';
comment on column public.paused_turns.sources is
  'The passages the turn cited when it parked, as messages.sources (0005). Same rule as grounding.';

-- No grant change, for 0065's reason. 0060 gives `authenticated` a column
-- whitelist on paused_turns and these are deliberately not on it: the card a
-- person answers needs neither, the reply row they land on is where a client
-- reads them, and the worker holds service_role, whose table-level grant
-- covers columns added later.
