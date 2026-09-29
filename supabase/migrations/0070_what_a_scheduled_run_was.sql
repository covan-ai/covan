-- 0070 — what a scheduled run was
--
-- `routine_runs` has said how a run went since 0012 — `ok`, `skipped`,
-- `failed` — and that is a delivery verdict, not an account of the model call
-- underneath it. A scheduled run goes through the same `runAgentTurn` a chat
-- turn does (`worker/src/lib/routines/agent-run.ts`) or the same `complete`
-- (`summarise.ts`), produces the same passes and the same finish reason, and
-- threw both away: the model it resolved was discarded, and `replyOutcome()`
-- was never called on this path at all.
--
-- So two runs that both read "ok" could be a report the model finished and a
-- report cut off at its token ceiling, and nothing on the row tells them
-- apart. The two columns here are the same two facts `messages` has carried
-- since 0064 and 0065, asked of the surface with nobody watching it.
--
-- `status` stays exactly as it is. It answers "did my routine send anything?"
-- and is user-facing; `outcome` answers "and what happened to the model", which
-- is a different question with a different reader. Widening `status` to carry
-- both would have made one column mean two things.
--
-- **Deliberately NOT writing to `messages`.** A scheduled run is not a
-- conversation and has no session; covan-ai/covan#217 says so explicitly, and
-- the alternative would put rows in a transcript nobody opened.
--
-- ---- the vocabulary, and the value in it that had nowhere to be written ----
--
-- Identical to `messages_outcome_known` as 0067 left it, because one word has
-- to mean one thing across both histories — `worker/src/lib/harness/usage.test.ts`
-- asserts every `*_outcome_known` constraint against the single
-- `MESSAGE_OUTCOMES` list, so a third table narrowing it would fail there
-- rather than in production.
--
-- Two members are reachable here only in one direction, and that is worth
-- writing down rather than discovering:
--
--   * `paused` never appears on a `routine_runs` row. A pause is a question
--     waiting for a person and a tick has nobody to ask, so a scheduled run
--     that stops to ask is `cut_short` — the same word the chat path uses for a
--     turn that asked and was never parked. `lib/harness/usage.ts` derives that
--     from `parked: false`, which is a constant on this path.
--
--   * `empty` was unreachable on EITHER table until now, and the choice
--     covan-ai/covan#217 asks for is made here: it is kept in the vocabulary
--     and written where it belongs, rather than dropped. `routes/chat.ts` sends
--     an SSE error and persists nothing when a streamed reply comes back with
--     no text, so no row exists to carry it — but `POST /chat/confirm/:id`
--     DOES write a row for a resumed half that said nothing, with the content
--     `(no reply)`, and until now recorded it as `answered`. A row reading
--     "(no reply)" and claiming it answered is exactly the kind of false
--     positive this column was added to remove, so `replyOutcome` now takes
--     whether anything was said and that row says `empty`. Dropping the value
--     instead would have left the claim in place.
--
-- No backfill. Both columns are null for every run before this, which is the
-- truth: nothing recorded them.

alter table public.routine_runs
  add column if not exists model text,
  add column if not exists outcome text;

comment on column public.routine_runs.model is
  'Which model answered this run, as resolveModel settled it. Null for a run '
  'that made no model call, and for every run before 0070.';

comment on column public.routine_runs.outcome is
  'How the model stopped, in the same vocabulary as messages.outcome. Never '
  'paused - a tick has nobody to ask, so a run that stopped to ask is '
  'cut_short. Null for a run that made no model call.';

-- Dropped and re-added rather than declared inline: `add column if not exists`
-- carries its inline constraints only on the run that actually adds the column,
-- so a tree where the column already exists would get the column and not the
-- check. Same reasoning as 0065's note.
alter table public.routine_runs drop constraint if exists routine_runs_outcome_known;
alter table public.routine_runs add constraint routine_runs_outcome_known
  check (
    outcome is null
    or outcome in (
      'answered',
      'paused',
      'budget',
      'tokens',
      'runtime',
      'cut_short',
      'empty',
      'truncated'
    )
  );

-- No policy changes. `routine_runs_select_visible` (0012) scopes reads by the
-- routine's workspace and knows nothing about which columns exist, so two more
-- columns are covered by it the moment they are added.
