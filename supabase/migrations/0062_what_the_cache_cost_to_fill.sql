-- 0062_what_the_cache_cost_to_fill.sql
--
-- 0025 recorded what the prompt cache SAVED and stopped there. This records
-- what it COST, which turns out to be the half that decides whether a change
-- to the caching was worth making.
--
-- Anthropic bills a cache in two directions: a read is a tenth of input, and a
-- write is 1.25x input. `lib/completion.ts` has read both numbers since Claude
-- was offered here — `cache_read_input_tokens` and
-- `cache_creation_input_tokens` — and stored only the first, folding the second
-- into `prompt_tokens` where it is indistinguishable from ordinary fresh
-- input. `lib/pricing.ts` then priced it at the plain `in` rate and said so in
-- its own comment, on the argument that the premium "rounds to nothing over a
-- month".
--
-- That argument holds exactly as long as nobody is deliberately writing to the
-- cache. The moment a change is made to increase cache HITS, it increases cache
-- WRITES first, and the unpriced 25% lands precisely where somebody is looking
-- for an effect: a net loss could be recorded as a gain, and nothing in the
-- database would disagree. So the count is separated out before any such
-- change is made, not after.
--
-- ---- why the tool loop forced the rest of this ---------------------------
--
-- Measured on the live project on 2026-09-24: of 142 assistant replies, the 8
-- that used tools carry 45% of all recorded input tokens — 52,613 prompt tokens
-- on average against 3,860 for a reply that called nothing. The cost is
-- super-linear in steps: 1 step ~14k prompt tokens, 4 steps ~76k, 6 steps
-- ~117k. All eight were Claude models.
--
-- The turn-level total cannot say why. `lib/harness/loop.ts` makes one model
-- call per pass and re-sends the whole accumulated transcript each time, so
-- 117k is the sum of several requests — and eight even passes and one enormous
-- final pass sum identically while meaning opposite things. Hence `pass_usage`:
-- the per-request numbers cannot be derived from the total afterwards, so they
-- are kept at the time.
--
-- ---- and why `result_chars` is a length and not a text -------------------
--
-- `message_steps.result_excerpt` stops at `MAX_STEP_EXCERPT_CHARS` (2,000)
-- while the model is shown up to `MAX_TOOL_OUTPUT_CHARS` (8,000). Every large
-- result therefore looks identical from the outside, which is why the
-- tool-output budget has never been tuned against anything: four of the four
-- `describe_connection` calls on record are flush against the excerpt ceiling
-- and there is no way to tell 2,001 characters from 8,000. Recording the length
-- answers that without storing a single extra character of anybody's data — and
-- the length is the figure that matters, because it is what every remaining
-- pass of the turn re-sends.
--
-- ---- nullable, no default, no backfill -----------------------------------
--
-- 0025's reasoning applies unchanged and is worth repeating: every reply
-- already stored was billed under an unknown cache state, and writing 0 would
-- assert those prompts wrote nothing to the cache. Some of them certainly did.
-- Null means "not recorded", which is the truth, and `estimateCostUsd` reads a
-- missing count as no premium — so historical rows keep the figure they have
-- always shown.
--
-- Null is also the permanent, correct answer for every OpenAI reply written
-- after this migration: that cache populates itself for free and reports no
-- write count at all. A zero there would be a measurement; a null is the
-- absence of one, and only the second is true.

alter table public.messages add column if not exists cache_write_tokens int;

comment on column public.messages.cache_write_tokens is
  'Prompt tokens the provider charged a storage premium for (Anthropic 1.25x). '
  'A SUBSET of prompt_tokens and disjoint from cached_tokens - a token is read '
  'from the cache or written into it, never both. Null on OpenAI, whose cache '
  'is free to fill, and on every reply written before 0062.';

-- One entry per model call the reply made, in order:
--   [{"index":0,"prompt":14312,"cached":0,"written":11890,"completion":204}, ...]
--
-- jsonb rather than a `message_passes` table, and the choice is about what
-- these rows are for. They are read by hand, in a SQL editor, while somebody is
-- asking a question about spend — never by the product, never joined, never
-- filtered. A table would buy indexes nothing queries and cost a second write
-- and a second delete path on the hot chat route. `message_steps` is a table
-- because the transcript view renders it on every message load; this is not.
--
-- A pass is not a step and cannot be folded into `message_steps`: the last pass
-- of a turn is the one that finally answers, so it runs no tool and would have
-- no row to live on. That pass is also the one carrying the largest transcript,
-- which makes it the most interesting of the lot.
alter table public.messages add column if not exists pass_usage jsonb;

comment on column public.messages.pass_usage is
  'Per-model-call token usage for a reply that took several passes, in order. '
  'Their sum is the row prompt_tokens/completion_tokens. Null on a reply that '
  'made one call, and on every reply written before 0062.';

alter table public.message_steps add column if not exists result_chars int;
alter table public.message_steps add column if not exists pass_index int;

-- Separately from the `add column`s above, so re-running this file re-asserts
-- them rather than skipping them: `add column if not exists` carries its inline
-- constraints only on the run that actually adds the column.
alter table public.message_steps
  drop constraint if exists message_steps_result_chars_nonneg;
alter table public.message_steps
  add constraint message_steps_result_chars_nonneg
  check (result_chars is null or result_chars >= 0);

alter table public.message_steps
  drop constraint if exists message_steps_pass_index_nonneg;
alter table public.message_steps
  add constraint message_steps_pass_index_nonneg
  check (pass_index is null or pass_index >= 0);

comment on column public.message_steps.result_chars is
  'How many characters of this tool result the MODEL was shown, after '
  'MAX_TOOL_OUTPUT_CHARS. Not the length of result_excerpt, which is trimmed '
  'four times harder for the transcript view. Null on a pending step, which '
  'has not answered anything yet.';

comment on column public.message_steps.pass_index is
  'Which model call in the turn asked for this tool, from zero. The loop bills '
  'a pass, not a tool: one pass asking for three tools is one prompt charge.';

-- The existing `tokens` column is left alone and still written by nothing. Its
-- own comment in 0060 explains why, and 0062 does not disagree with it: "a
-- provider bills a pass, not a tool, and inventing a split would be a number
-- that looks precise and is not". `pass_index` is the honest version of the
-- same intent — it says which charge a step belongs to without pretending to
-- divide it.

-- ---- the three usage functions -------------------------------------------
--
-- All three gain one summed column, so the estimated cost on the usage page
-- includes the write premium rather than pricing it as fresh input. DROP first
-- rather than `create or replace`, for the reason 0025 sets out at length: a
-- function's return type cannot be changed in place, and adding a column to a
-- `returns table` is exactly that — it fails with "cannot change return type of
-- existing function" and leaves the migration half-applied.
--
-- Dropping takes the grants with it, so each is re-granted below in this file
-- rather than left to whatever the platform default happens to be that day —
-- the moving target 0023 was written about. The grants below restore exactly
-- what each function held: `anon` on `workspace_usage` (0025, to preserve a
-- state the database was already in) and not on the other two (0032, which
-- declined to treat that as a precedent).

drop function if exists public.workspace_usage(uuid);
drop function if exists public.workspace_usage_all(uuid);
drop function if exists public.workspace_usage_monthly(uuid, int);

-- Unchanged from 0025 but for the one new sum: still `security invoker`, still
-- scoping sessions with `s.user_id = auth.uid()` in the join rather than
-- leaning on a select policy, still a LEFT JOIN with the message condition in
-- the ON clause so an agent nobody has chatted with keeps appearing at zero.
create function public.workspace_usage(p_workspace_id uuid)
returns table (
  agent_id uuid,
  agent_name text,
  agent_emoji text,
  agent_model text,
  message_count bigint,
  prompt_tokens bigint,
  completion_tokens bigint,
  cached_tokens bigint,
  cache_write_tokens bigint,
  measured_prompt_tokens bigint
)
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select a.id,
         a.name,
         a.emoji,
         a.model,
         count(m.id) as message_count,
         coalesce(sum(m.prompt_tokens), 0) as prompt_tokens,
         coalesce(sum(m.completion_tokens), 0) as completion_tokens,
         coalesce(sum(m.cached_tokens), 0) as cached_tokens,
         coalesce(sum(m.cache_write_tokens), 0) as cache_write_tokens,
         -- The denominator a cache hit rate has to be divided by; 0025 explains
         -- why it is not `prompt_tokens`. Still keyed on `cached_tokens` and
         -- not on the new column: a reply from an OpenAI model records a read
         -- count and will never record a write one, so keying on writes would
         -- drop every OpenAI reply out of the denominator.
         coalesce(sum(m.prompt_tokens) filter (where m.cached_tokens is not null), 0)
           as measured_prompt_tokens
  from public.agents a
  left join public.chat_sessions s
    on s.agent_id = a.id and s.user_id = auth.uid()
  left join public.messages m on m.session_id = s.id and m.role = 'assistant'
  where a.workspace_id = p_workspace_id
  group by a.id, a.name, a.emoji, a.model
  order by (coalesce(sum(m.prompt_tokens), 0) + coalesce(sum(m.completion_tokens), 0)) desc;
$$;

-- Unchanged from 0032 but for the same new sum. The only difference from the
-- function above that matters is still the missing `s.user_id = auth.uid()`,
-- and the admin check that earns it.
create function public.workspace_usage_all(p_workspace_id uuid)
returns table (
  agent_id uuid,
  agent_name text,
  agent_emoji text,
  agent_model text,
  message_count bigint,
  prompt_tokens bigint,
  completion_tokens bigint,
  cached_tokens bigint,
  cache_write_tokens bigint,
  measured_prompt_tokens bigint
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if not public.is_workspace_admin(p_workspace_id) then
    raise exception 'not an admin of this workspace' using errcode = '42501';
  end if;

  return query
  select a.id,
         a.name,
         a.emoji,
         a.model,
         count(m.id) as message_count,
         coalesce(sum(m.prompt_tokens), 0) as prompt_tokens,
         coalesce(sum(m.completion_tokens), 0) as completion_tokens,
         coalesce(sum(m.cached_tokens), 0) as cached_tokens,
         coalesce(sum(m.cache_write_tokens), 0) as cache_write_tokens,
         coalesce(sum(m.prompt_tokens) filter (where m.cached_tokens is not null), 0)
           as measured_prompt_tokens
  from public.agents a
  left join public.chat_sessions s on s.agent_id = a.id
  left join public.messages m on m.session_id = s.id and m.role = 'assistant'
  where a.workspace_id = p_workspace_id
  group by a.id, a.name, a.emoji, a.model
  order by (coalesce(sum(m.prompt_tokens), 0) + coalesce(sum(m.completion_tokens), 0)) desc;
end;
$$;

-- Unchanged from 0032 but for the same new sum, `generate_series` span and all.
create function public.workspace_usage_monthly(p_workspace_id uuid, p_months int default 6)
returns table (
  month date,
  message_count bigint,
  prompt_tokens bigint,
  completion_tokens bigint,
  cached_tokens bigint,
  cache_write_tokens bigint
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_months int := greatest(1, least(coalesce(p_months, 6), 24));
begin
  if not public.is_workspace_admin(p_workspace_id) then
    raise exception 'not an admin of this workspace' using errcode = '42501';
  end if;

  return query
  with span as (
    select generate_series(
             date_trunc('month', now()) - make_interval(months => v_months - 1),
             date_trunc('month', now()),
             interval '1 month'
           ) as bucket
  )
  select span.bucket::date,
         count(m.id) as message_count,
         coalesce(sum(m.prompt_tokens), 0) as prompt_tokens,
         coalesce(sum(m.completion_tokens), 0) as completion_tokens,
         coalesce(sum(m.cached_tokens), 0) as cached_tokens,
         coalesce(sum(m.cache_write_tokens), 0) as cache_write_tokens
  from span
  left join public.messages m
    on m.role = 'assistant'
   and date_trunc('month', m.created_at) = span.bucket
   and exists (
         select 1
         from public.chat_sessions s
         join public.agents a on a.id = s.agent_id
         where s.id = m.session_id
           and a.workspace_id = p_workspace_id
       )
  group by span.bucket
  order by span.bucket;
end;
$$;

grant execute on function public.workspace_usage(uuid) to anon, authenticated, service_role;
revoke execute on function public.workspace_usage_all(uuid) from public;
revoke execute on function public.workspace_usage_monthly(uuid, int) from public;
grant execute on function public.workspace_usage_all(uuid) to authenticated, service_role;
grant execute on function public.workspace_usage_monthly(uuid, int) to authenticated, service_role;

-- ---- verify --------------------------------------------------------------
--
-- Paste after applying. Four columns and three functions; anything missing
-- here is a migration that stopped half way, which is the failure mode the
-- DROPs above make possible.
--
--   select column_name from information_schema.columns
--    where table_schema = 'public'
--      and (table_name, column_name) in (
--        ('messages', 'cache_write_tokens'), ('messages', 'pass_usage'),
--        ('message_steps', 'result_chars'), ('message_steps', 'pass_index'));
--
--   select p.proname, pg_get_function_result(p.oid) like '%cache_write_tokens%' as has_column
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname like 'workspace_usage%';
