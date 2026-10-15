-- A reply can now end because the person asking pressed stop.
--
-- Stopping used to be the browser closing its connection, and the worker could
-- not tell that from a tab being closed: both kept the words written so far
-- and recorded them as `answered`. A turn now runs on the server whether or
-- not anybody is watching (`worker/src/lib/turns`), so stop is a request of its
-- own, and the reply it keeps can say what happened to it. Without its own
-- word a reply cut off mid-sentence reads, after a reload, exactly like one
-- that finished.
--
-- ORDER MATTERS, as in 0067 and 0097: the worker writes `outcome = 'stopped'`
-- the moment it is deployed, and an insert this constraint refuses is no reply
-- at all — the words the person stopped to keep would be the thing lost. So
-- this file goes on before that build does. Both tables, because 0070 made them
-- one vocabulary and `usage.test.ts` holds them to it, although a scheduled run
-- has nobody to press stop and will never write it.

alter table public.messages drop constraint if exists messages_outcome_known;
alter table public.messages add constraint messages_outcome_known
  check (
    outcome is null
    or outcome in (
      'answered','paused','budget','tokens','runtime','credits','cut_short','empty','truncated',
      'stopped'
    )
  );

alter table public.routine_runs drop constraint if exists routine_runs_outcome_known;
alter table public.routine_runs add constraint routine_runs_outcome_known
  check (
    outcome is null
    or outcome in (
      'answered','paused','budget','tokens','runtime','credits','cut_short','empty','truncated',
      'stopped'
    )
  );

comment on column public.messages.outcome is
  'How the reply ended: answered; paused (waiting on a confirmation); budget / tokens / runtime / credits (something ended the tool loop, the model then answered with what it had — ours, ours, the platform''s, the workspace''s credit); cut_short (the turn threw after doing work); empty; truncated (finish_reason length); stopped (the person pressed stop, and the words are what was written before). Null before 0065.';
