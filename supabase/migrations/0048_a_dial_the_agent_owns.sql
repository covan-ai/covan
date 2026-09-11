-- =========================================================================
-- A dial the agent owns
--
-- Two settings that existed in the code and nowhere else: how much the model
-- varies its wording, and how long it thinks before it starts writing.
--
-- Both were decided by `mode`. `lib/prompt.ts` returned 0.9 for a brainstorm
-- agent and nothing at all for a normal one, and `reasoning_effort` was sent
-- only by the three callers whose task is shaping rather than thinking, always
-- as `minimal`. So a team that wanted its support agent to answer the same way
-- twice, or its analyst to think harder before answering, had one control
-- between them — the mode picker — and it moved four behaviours at once.
--
-- Both columns are nullable, and null is the default for every agent that
-- exists. It does not mean "no temperature" or "no thinking": it means the mode
-- decides, which is exactly what happens today. This migration therefore
-- changes no reply. The dial appears; nobody is moved to a new setting by it.
--
-- `temperature` is `real` rather than `numeric` because it is a model
-- parameter, not money, and 0.7 has never needed to be exactly 0.7.
--
-- The range check is on the column rather than only in the API, unlike
-- `workspaces.default_model` (0014), and for the opposite reason: the set of
-- model *names* changes faster than the schema should, but the meaning of a
-- temperature does not. 0 to 2 is what both providers accept, and a row outside
-- it is a 400 from the provider on every turn until somebody edits it back.
--
-- `reasoning_effort` is checked against a fixed list for the same reason — the
-- four names are the API's vocabulary, not ours. A model that does not reason
-- ignores the column, which `lib/models.ts` decides per id and is why this is
-- not a `not null default 'medium'`: "the model's own default" and "medium"
-- are different requests, and only one of them is what an untouched agent has
-- been getting.
--
-- No policy change. `agents_update_workspace_member` (0021) is a row policy and
-- already governs who may write these columns; a viewer cannot, a member can.
-- =========================================================================

alter table public.agents
  add column if not exists temperature real;

alter table public.agents
  add column if not exists reasoning_effort text;

alter table public.agents
  drop constraint if exists agents_temperature_range;

alter table public.agents
  add constraint agents_temperature_range
  check (temperature is null or (temperature >= 0 and temperature <= 2));

alter table public.agents
  drop constraint if exists agents_reasoning_effort_known;

alter table public.agents
  add constraint agents_reasoning_effort_known
  check (
    reasoning_effort is null
    or reasoning_effort in ('minimal', 'low', 'medium', 'high')
  );
