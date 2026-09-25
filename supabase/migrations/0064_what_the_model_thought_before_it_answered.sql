-- 0064_what_the_model_thought_before_it_answered.sql
--
-- 0062 made the INPUT side of a turn legible and the caching work that followed
-- cut it roughly in half. This records the one number that decides what to do
-- next, because the money moved while nobody was looking at it.
--
-- ---- what the measurement says -------------------------------------------
--
-- Nine tool-using replies on the live project after the 2026-09-24 deploy,
-- split by provider (`cache_write_tokens is null` is the tell: only Anthropic
-- reports a write count, so a null is an OpenAI reply and a number is a
-- Claude one):
--
--            replies   fresh    cached   completion   avg completion
--   Claude         4   11,428   125,163       2,686              672
--   GPT-5          5   28,924    79,872      29,505            5,901
--
-- Priced: a Claude turn costs about $0.048 and a GPT-5 turn about $0.068, and
-- on the GPT-5 turns **86% of the bill is output**. Every remaining lever in
-- the cost plan — the history budget, the tool-output cap, the uncapped
-- brainstorm transcript — is on the input side, which is now 13% of what a
-- GPT-5 tool turn costs. They were ranked before the caching work landed and
-- the ranking did not survive it.
--
-- The obvious reading is that GPT-5 deliberates and Claude, on these agents,
-- does not: `lib/completion.ts` keeps extended thinking off by default and the
-- 672-token Claude average agrees. But that is a reading, not a measurement.
--
-- ---- why a column rather than an inference -------------------------------
--
-- `completion_tokens_details.reasoning_tokens` has been on every OpenAI
-- response this Worker has ever received and nothing has ever read it. So the
-- 5,901 cannot be divided: an answer that is genuinely long and an answer
-- preceded by 5,000 tokens of deliberation are the same row, and they call for
-- opposite fixes. Lowering `reasoning_effort` on an agent whose length is real
-- prose would cut quality for no saving; leaving it alone on an agent that
-- thinks for five thousand tokens to write four hundred is the largest single
-- line on the bill going unexamined.
--
-- This is the same argument 0062 made about `cache_write_tokens`, and it was
-- right then: the count is separated out BEFORE the change that would act on
-- it, not after, so that the effect can be read off the same column that
-- justified the change.
--
-- Reasoning tokens are a SUBSET of `completion_tokens`, not an addition, so
-- `lib/pricing.ts` needs nothing: the billing has always been correct and only
-- the diagnosis was missing. Nothing in this file touches the three
-- `workspace_usage*` functions for the same reason — their cost estimate is
-- already right, and dropping and recreating three functions to surface a
-- number nobody has asked to see on that page would be all of 0062's risk for
-- none of its purpose.
--
-- ---- nullable, no default, no backfill -----------------------------------
--
-- 0025 and 0062's reasoning, unchanged. Every reply already stored was billed
-- with its reasoning already inside `completion_tokens`, and writing 0 would
-- assert those answers involved no deliberation. Several certainly did. Null
-- means "not recorded", which is true.
--
-- Null is also the permanent answer for Anthropic, and for a good reason
-- rather than a gap: when extended thinking is off there is nothing to report,
-- and when it is on the thinking is billed inside `output_tokens` with no
-- separate count in the response at all. A zero there would be a claim the API
-- never made.

alter table public.messages add column if not exists reasoning_tokens int;

-- Separately from the `add column`, so re-running this file re-asserts the
-- constraint rather than skipping it: `add column if not exists` carries its
-- inline constraints only on the run that actually adds the column. 0062 learnt
-- this the same way.
alter table public.messages
  drop constraint if exists messages_reasoning_tokens_nonneg;
alter table public.messages
  add constraint messages_reasoning_tokens_nonneg
  check (reasoning_tokens is null or reasoning_tokens >= 0);

comment on column public.messages.reasoning_tokens is
  'Completion tokens the model spent deliberating before it answered, from '
  'OpenAI completion_tokens_details.reasoning_tokens. A SUBSET of '
  'completion_tokens, not an addition - pricing already counts them. Null on '
  'Anthropic, which bills thinking inside output_tokens and reports no '
  'separate count, and on every reply written before 0064.';

-- ---- and inside pass_usage ------------------------------------------------
--
-- No schema change; `pass_usage` is jsonb and gains a `reasoning` key per
-- entry. Recorded here because the per-pass split is the whole question for a
-- tool loop: reasoning on the first pass only is a fixed cost per turn, and
-- reasoning on all seven is a cost that grows with the step budget. Those two
-- shapes sum to the same row total and argue for different fixes, which is the
-- same reason `pass_usage` exists at all.
--
-- Entries written before 0064 have no `reasoning` key. Absent is not zero, and
-- a reader should treat a missing key the way it treats a null column.

-- ---- verify --------------------------------------------------------------
--
-- Paste after applying.
--
--   select column_name, is_nullable from information_schema.columns
--    where table_schema = 'public' and table_name = 'messages'
--      and column_name = 'reasoning_tokens';
--
--   select conname from pg_constraint
--    where conrelid = 'public.messages'::regclass
--      and conname = 'messages_reasoning_tokens_nonneg';
--
-- And the backfill check - this must return 0, every existing row untouched:
--
--   select count(*) from public.messages where reasoning_tokens is not null;
