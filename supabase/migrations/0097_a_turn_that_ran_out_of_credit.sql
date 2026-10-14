-- A turn can now end because the workspace ran out of credit partway through,
-- which is none of the ceilings 0065 and 0067 knew about.
--
-- A turn's credit used to be checked once, before its first step, and a turn
-- can take two dozen. So a turn that began on the last credit went on spending
-- -- and so did every other turn running beside it, each unaware of the rest.
-- The worker now asks before every step whether the workspace has anything
-- left once what running turns have already spent is counted, and a turn that
-- is told no answers with what it has. That ending gets its own word for the
-- reason 0067 gave `runtime` one: recording it as a step budget sends somebody
-- to ask for less, when what they need is more credit.
--
-- ORDER MATTERS, as in 0067: the worker writes `outcome = 'credits'` the moment
-- it is deployed, and an insert this constraint refuses is no reply at all. So
-- this file goes on before that build does. Both tables, because 0070 made
-- them one vocabulary and `usage.test.ts` holds them to it.

alter table public.messages drop constraint if exists messages_outcome_known;
alter table public.messages add constraint messages_outcome_known
  check (
    outcome is null
    or outcome in (
      'answered','paused','budget','tokens','runtime','credits','cut_short','empty','truncated'
    )
  );

alter table public.routine_runs drop constraint if exists routine_runs_outcome_known;
alter table public.routine_runs add constraint routine_runs_outcome_known
  check (
    outcome is null
    or outcome in (
      'answered','paused','budget','tokens','runtime','credits','cut_short','empty','truncated'
    )
  );

comment on column public.messages.outcome is
  'How the reply ended: answered; paused (waiting on a confirmation); budget / tokens / runtime / credits (something ended the tool loop, the model then answered with what it had — ours, ours, the platform''s, the workspace''s credit); cut_short (the turn threw after doing work); empty; truncated (finish_reason length). Null before 0065.';
