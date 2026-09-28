-- A reply can now end because the platform stopped it, which is neither of the
-- two ceilings 0065 knew about.
--
-- WHY IT IS ITS OWN VALUE. 0065 already split `budget` from `tokens` on the
-- argument that a turn which stopped because it was expensive, reported as one
-- that ran out of tool calls, sends the person to narrow the wrong thing. This
-- is the same argument a third time, and the one with the least in common with
-- the others: neither budget has run out, the runtime this is deployed on
-- simply will not make another outbound call. Cloudflare allows an invocation
-- fifty subrequests on Free, and `lib/harness/loop.ts` now stops the tool loop
-- with room to spare rather than walking into that wall and reporting
-- `Connection error.` (covan#177).
--
-- Folding it into `budget` was the alternative and would have been worse than
-- doing nothing: the gate exists so somebody can tell how often the platform is
-- what ended a turn, and `messages.outcome` is the only place that could ever
-- be read from. Recording it under another name hides the one event the work
-- was for.
--
-- ORDER MATTERS FOR THIS ONE. The worker writes `outcome = 'runtime'` the moment
-- it is deployed, and an insert the constraint refuses is not a degraded reply,
-- it is no reply — `persistAssistant` returns null and the route answers
-- "failed to persist assistant message". So this file goes on before that
-- build does. CI applies migrations only in its RLS job; production is by hand.
--
-- `empty` stays in the list, still written by nothing (covan#217). Removing a
-- value is a different question from adding one — it needs the rows checked
-- first — and doing both in one file would make this one hard to revert.

alter table public.messages drop constraint if exists messages_outcome_known;
alter table public.messages add constraint messages_outcome_known
  check (
    outcome is null
    or outcome in (
      'answered','paused','budget','tokens','runtime','cut_short','empty','truncated'
    )
  );

comment on column public.messages.outcome is
  'How the reply ended: answered; paused (waiting on a confirmation); budget / tokens / runtime (a ceiling ended the tool loop, the model then answered with what it had — ours, ours, and the platform''s); cut_short (the turn threw after doing work); empty; truncated (finish_reason length). Null before 0065.';
