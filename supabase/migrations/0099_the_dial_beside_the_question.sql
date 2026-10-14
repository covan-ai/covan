-- =========================================================================
-- The dial beside the question
--
-- Four settings an agent has owned since 0007 and 0048 — which model answers,
-- how long it thinks first, whether it facilitates or answers, whether it may
-- search the web — can now be chosen for one conversation without editing the
-- agent everybody else is talking to.
--
-- Until now the only way to ask one hard question with more thinking, or on a
-- different model, was to change the agent. That moved the dial for every
-- other conversation with it, a teammate's included, and a member who is not
-- allowed to edit the agent had no dial at all. The choice belongs to the
-- thread: somebody working through a contract wants the careful model for the
-- whole of that thread and the quick one everywhere else. So the columns sit
-- on `chat_sessions`, and a choice made in a thread applies to every reply in
-- it — a new question, `continue`, `regenerate`, and the reply that resumes
-- after an approval — and to no other thread.
--
-- Every column is nullable and null for every session that exists. Null does
-- not mean "no model" or "no thinking": it means the agent decides, which is
-- exactly what happens today. This migration therefore changes no reply.
-- `lib/session-mode.ts` is the one place that says how a session's value and
-- its agent's combine.
--
--   model             a model id. Not checked here, for the reason 0048 gave
--                     for leaving `workspaces.default_model` (0014) alone: the
--                     set of names changes faster than the schema should. The API refuses an id
--                     this deployment does not serve, and a stored id that
--                     stops being served falls back the way an agent's does.
--   reasoning_effort  the same four words 0048 checks on `agents`, because
--                     they are the providers' vocabulary and not ours. One
--                     column carries both "thinking off" (`minimal`) and how
--                     hard to think when it is on; a model that does not
--                     reason ignores it, as it ignores the agent's.
--   web_search        on or off for this thread.
--   mode              'normal' or 'brainstorm', the two words 0007 checks. A
--                     session whose `kind` is 'brainstorm' is one whatever
--                     this says — it has the idea board.
--
-- Who may turn the dial is who may rename the thread: its owner. The row
-- policy `chat_sessions_update_owner` (0028, 0031) already says so, and 0094
-- names the columns a caller's client may write, so the four are added to
-- that grant — update, to turn the dial, and insert, so a session can be
-- started with one already set. `tests/rls/grant-ratchet.test.ts` holds the
-- new list. A member reading a shared thread sees the dial and cannot move it.
-- =========================================================================

alter table public.chat_sessions
  add column if not exists model text;

alter table public.chat_sessions
  add column if not exists reasoning_effort text;

alter table public.chat_sessions
  add column if not exists web_search boolean;

alter table public.chat_sessions
  add column if not exists mode text;

alter table public.chat_sessions
  drop constraint if exists chat_sessions_reasoning_effort_known;

alter table public.chat_sessions
  add constraint chat_sessions_reasoning_effort_known
  check (
    reasoning_effort is null
    or reasoning_effort in ('minimal', 'low', 'medium', 'high')
  );

alter table public.chat_sessions
  drop constraint if exists chat_sessions_mode_known;

alter table public.chat_sessions
  add constraint chat_sessions_mode_known
  check (mode is null or mode in ('normal', 'brainstorm'));

grant insert (model, reasoning_effort, web_search, mode)
  on public.chat_sessions to authenticated;
grant update (model, reasoning_effort, web_search, mode)
  on public.chat_sessions to authenticated;
