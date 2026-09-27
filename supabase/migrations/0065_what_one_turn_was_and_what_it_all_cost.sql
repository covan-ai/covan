-- 0065_what_one_turn_was_and_what_it_all_cost.sql
--
-- 0062 recorded what a pass cost and 0064 recorded what the model spent
-- thinking before it answered. Both describe a reply. Neither says which model
-- wrote it, how it ended, or what the half of the turn that happened before a
-- confirmation cost. This adds those three.

-- ---- which model answered -------------------------------------------------
--
-- `messages` has never said which model answered. Every by-model table so
-- far joins chat_sessions.agent_id -> agents.model, which is the agent's
-- model TODAY; an agent whose model changed mid-week moves its whole history
-- with it. 2026-09-20..27: a gpt-5 agent carrying 19,704 cache_write_tokens,
-- a number OpenAI does not report.
alter table public.messages add column if not exists model text;
comment on column public.messages.model is
  'The model id that produced this reply, as sent to the provider. Null on user rows and on rows written before 0065.';

-- ---- how it ended ---------------------------------------------------------
--
-- Why a reply ended, so "This turn stopped before it could answer" stops
-- being found by string-matching content.
alter table public.messages add column if not exists outcome text;

-- Separately from the `add column` above, so re-running this file re-asserts
-- the constraint rather than skipping it: `add column if not exists` carries
-- its inline constraints only on the run that actually adds the column.
alter table public.messages drop constraint if exists messages_outcome_known;
alter table public.messages add constraint messages_outcome_known
  check (outcome is null or outcome in ('answered','paused','budget','tokens','cut_short','empty','truncated'));

comment on column public.messages.outcome is
  'How the reply ended: answered; paused (waiting on a confirmation); budget / tokens (a ceiling ended the tool loop, the model then answered with what it had); cut_short (the turn threw after doing work); empty; truncated (finish_reason length). Null before 0065.';

-- ---- what the parked half cost --------------------------------------------
--
-- A parked turn carries its transcript and its steps (0060) but not what
-- those steps cost. On resume the row was written with the resumed half's
-- usage only, so a turn that paused once lost every pass before the pause
-- from `messages` (still charged to quota - see recordSpend). 10 of the 29
-- turns with pass_usage between 2026-09-24 and 09-26 start above index 0.
alter table public.paused_turns add column if not exists usage jsonb;
comment on column public.paused_turns.usage is
  'What the turn had already spent when it parked: {promptTokens, completionTokens, cachedTokens, cacheWriteTokens, reasoningTokens, passes: [...]}, each nullable. Summed into the reply when the turn resumes. A pause that asked before speaking and then expired leaves this as the only record of its first half; it was charged to the allowance when it parked.';

-- No grant change. 0060 gives `authenticated` a column whitelist on
-- paused_turns and this column is deliberately not on it: no client reads what
-- a turn spent, and the worker holds service_role, whose table-level grant
-- covers columns added later.
