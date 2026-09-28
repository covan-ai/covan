-- What a discovery step put in front of the model.
--
-- WHY THIS EXISTS. `find_tool` searches a catalogue of about 1,500 Composio
-- operations and hands back at most five. `run_tool` then refuses a slug that
-- was not among them — `ToolContext.offeredSlugs` in `lib/harness/registry.ts`
-- — because the alternative is measurable: in the week of 2026-09-20 the model
-- invented fifteen slugs that do not exist (`GITHUB_GET_PULL_REQUESTS`,
-- `GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS`, and so on), and Composio bills a
-- 404. Fifteen of twenty-three `run_tool` failures, each one a step out of
-- eight and a charge, to learn nothing.
--
-- The guard works, and it almost never runs. It is armed only when `find_tool`
-- answered *in the same turn*, because the four memos it reads are built fresh
-- per turn in `routes/chat-turn.ts`. A conversation's third question rarely
-- searches again — it asks about something the first question already found —
-- so the set is empty, the guard stands down, and the invented slug goes out.
-- It caught two of seventeen.
--
-- WHY A COLUMN AND NOT A PARSE. The offered slugs are already on disk: they are
-- the first word of each candidate block in `result_excerpt`. Reading them back
-- out of that text was the cheaper-looking option and it is the wrong one, for
-- a reason the data settles rather than taste. `result_excerpt` is capped at
-- 2,000 characters and 45 of 61 stored `find_tool` results exceeded it — so a
-- parse recovers the first candidates and silently loses the last ones.
--
-- That failure is not neutral. `run-tool.ts` states the invariant out loud: an
-- empty set means "this tool cannot see where the slug came from", and refusing
-- on a *partial* set would break a working call to prevent a mistake that has
-- not happened. A set has to be complete or absent; it may not be approximate.
-- Written by the same code that did the offering, it is complete by
-- construction, and it stops depending on the exact prose `summarise()` renders.
--
-- The same column answers a question nothing could answer before: how much
-- discovery bought. 94 discovery steps against 28 successful calls was assembled
-- by hand from excerpts; with this it is one `select`.

alter table public.message_steps add column if not exists offered text[];

comment on column public.message_steps.offered is
  'The operation slugs this step added to what the model is allowed to run, '
  'complete rather than trimmed. Null on every step that added none - which is '
  'every tool but find_tool, find_tool when it found nothing, and a repeated '
  'search whose candidates were all offered earlier in the same turn. The union '
  'down a conversation is the set run_tool checks against.';

-- No policy, and that is the point rather than an omission. A step is part of a
-- reply: `message_steps` already answers "who may see this" through
-- `message_is_visible` (0060), and a column added to the table inherits it.
-- Nothing here is reachable except by somebody who could already read the
-- excerpt this was extracted from.
--
-- No grant either. The worker writes it with `service_role`, whose table-level
-- grant covers columns added later; the client-visible read goes through the
-- same row it always did.
