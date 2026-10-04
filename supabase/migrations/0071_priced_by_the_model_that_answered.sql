-- Group each usage row by the model that answered it, so a reply can be priced
-- at what it actually cost.
--
-- WHY. `0065` added `messages.model` and #206 started writing it on every path
-- that writes a reply. Nothing read it (covan#208), so `/usage` went on pricing
-- every reply with the agent's model TODAY — joined `chat_sessions.agent_id →
-- agents.model` — and an agent moved from one model to another took its whole
-- history onto the new price list. `0065`'s own header names the shape that
-- makes it visible: a gpt-5 agent carrying 19,704 `cache_write_tokens`, a
-- number OpenAI does not report.
--
-- The money this was off by is not marginal. In the week to 2026-10-04, 64 of
-- 66 assistant turns were Anthropic: Sonnet 5 bills $10/M output against
-- gpt-4.1's $8, Opus 5 bills $25, and a cached Anthropic token is $0.20
-- against $0.50. One workspace's figure can be wrong in either direction by
-- more than 2x.
--
-- WHY A COLUMN AND NOT MORE ROWS. The obvious shape is one row per (agent,
-- model), and it breaks two invariants that exist for a reason. `workspace_usage`
-- returns one row per agent and the screen renders one row per agent; and
-- `workspace_usage_monthly` returns exactly `p_months` buckets whether or not
-- anybody used them, because a month that closes up makes a fall in spend look
-- like a flat line (`tests/rls/workspace-usage.test.ts` pins both). A jsonb
-- column adds the dimension the price list needs without moving either: the
-- scalar sums still answer "how many tokens moved", and `by_model` answers "at
-- which prices", and the caller folds the second into one figure.
--
-- WHY THE FALLBACK IS IN SQL. `coalesce(m.model, a.model)` rather than a null
-- carried to the caller: 183 of production's 254 assistant replies predate the
-- column, every reply written after 2026-09-27T19:12Z has it, and the only
-- honest price for a reply that recorded no model is the agent's own. Doing it
-- here means one definition of that rule instead of one per reader.
--
-- (covan#208 says 361, counting every row of `messages` with a null `model`.
-- 277 of those are user messages, which have no model and never will. Measured
-- 2026-10-05: 460 null of 531 rows, 183 of them assistant replies.)
--
-- WHY EVERY CTE COLUMN CARRIES A PREFIX. Two of these are `plpgsql`, and there
-- a `returns table (...)` entry is an OUT *variable* as well as an output
-- column — so a CTE column called `agent_id` or `prompt_tokens` is ambiguous
-- inside the body and the function raises `42702` at call time, not at create
-- time. The live suite caught it; nothing else would have.
--
-- NOTHING ELSE CHANGES. Same `security invoker` / `security definer` split,
-- same `s.user_id = auth.uid()` on the per-caller function and deliberately not
-- on the admin one, same LEFT JOIN with the message condition in the ON clause
-- so an agent nobody has chatted with keeps appearing at zero, same ordering.
--
-- A return-type change forces a DROP (`create or replace` refuses: "cannot
-- change return type of existing function"), and on this database function
-- grants are explicit rather than the bare PUBLIC default — so the drop takes
-- them with it and they are re-granted at the bottom of this file. 0025 and
-- 0062 both learned that the hard way.

drop function if exists public.workspace_usage(uuid);
drop function if exists public.workspace_usage_all(uuid);
drop function if exists public.workspace_usage_monthly(uuid, int);

-- The caller's own conversations. `security invoker`, scoping sessions with
-- `s.user_id = auth.uid()` in the join rather than leaning on a select policy.
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
  measured_prompt_tokens bigint,
  by_model jsonb
)
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  with mine as (
    select a.id as x_agent_id,
           a.name as x_agent_name,
           a.emoji as x_agent_emoji,
           a.model as x_agent_model,
           m.id as x_message_id,
           coalesce(m.model, a.model) as x_reply_model,
           m.prompt_tokens as x_prompt,
           m.completion_tokens as x_completion,
           m.cached_tokens as x_cached,
           m.cache_write_tokens as x_written
    from public.agents a
    left join public.chat_sessions s
      on s.agent_id = a.id and s.user_id = auth.uid()
    left join public.messages m on m.session_id = s.id and m.role = 'assistant'
    where a.workspace_id = p_workspace_id
  ),
  per_model as (
    select mine.x_agent_id,
           mine.x_reply_model,
           coalesce(sum(mine.x_prompt), 0) as p_prompt,
           coalesce(sum(mine.x_completion), 0) as p_completion,
           coalesce(sum(mine.x_cached), 0) as p_cached,
           coalesce(sum(mine.x_written), 0) as p_written
    from mine
    where mine.x_message_id is not null
    group by mine.x_agent_id, mine.x_reply_model
  )
  select mine.x_agent_id,
         mine.x_agent_name,
         mine.x_agent_emoji,
         mine.x_agent_model,
         count(mine.x_message_id) as message_count,
         coalesce(sum(mine.x_prompt), 0) as prompt_tokens,
         coalesce(sum(mine.x_completion), 0) as completion_tokens,
         coalesce(sum(mine.x_cached), 0) as cached_tokens,
         coalesce(sum(mine.x_written), 0) as cache_write_tokens,
         -- The denominator a cache hit rate has to be divided by; 0025 explains
         -- why it is not `prompt_tokens`. Still keyed on `cached_tokens` and not
         -- on the write column: an OpenAI reply records a read count and will
         -- never record a write one.
         coalesce(sum(mine.x_prompt) filter (where mine.x_cached is not null), 0)
           as measured_prompt_tokens,
         -- Null, not an empty array, for an agent nobody has chatted with: the
         -- caller distinguishes "no replies" from "this schema has no model
         -- column" by whether the field is an array at all.
         (select jsonb_agg(
                   jsonb_build_object(
                     'model', pm.x_reply_model,
                     'promptTokens', pm.p_prompt,
                     'completionTokens', pm.p_completion,
                     'cachedTokens', pm.p_cached,
                     'cacheWriteTokens', pm.p_written
                   )
                   order by pm.p_prompt desc
                 )
          from per_model pm
          where pm.x_agent_id = mine.x_agent_id) as by_model
  from mine
  group by mine.x_agent_id, mine.x_agent_name, mine.x_agent_emoji, mine.x_agent_model
  order by (coalesce(sum(mine.x_prompt), 0) + coalesce(sum(mine.x_completion), 0)) desc;
$$;

-- Everybody's conversations. The only difference from the function above that
-- matters is still the missing `s.user_id = auth.uid()`, and the admin check
-- that earns it.
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
  measured_prompt_tokens bigint,
  by_model jsonb
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
  with everyones as (
    select a.id as x_agent_id,
           a.name as x_agent_name,
           a.emoji as x_agent_emoji,
           a.model as x_agent_model,
           m.id as x_message_id,
           coalesce(m.model, a.model) as x_reply_model,
           m.prompt_tokens as x_prompt,
           m.completion_tokens as x_completion,
           m.cached_tokens as x_cached,
           m.cache_write_tokens as x_written
    from public.agents a
    left join public.chat_sessions s on s.agent_id = a.id
    left join public.messages m on m.session_id = s.id and m.role = 'assistant'
    where a.workspace_id = p_workspace_id
  ),
  per_model as (
    select everyones.x_agent_id,
           everyones.x_reply_model,
           coalesce(sum(everyones.x_prompt), 0) as p_prompt,
           coalesce(sum(everyones.x_completion), 0) as p_completion,
           coalesce(sum(everyones.x_cached), 0) as p_cached,
           coalesce(sum(everyones.x_written), 0) as p_written
    from everyones
    where everyones.x_message_id is not null
    group by everyones.x_agent_id, everyones.x_reply_model
  )
  select everyones.x_agent_id,
         everyones.x_agent_name,
         everyones.x_agent_emoji,
         everyones.x_agent_model,
         count(everyones.x_message_id) as message_count,
         coalesce(sum(everyones.x_prompt), 0) as prompt_tokens,
         coalesce(sum(everyones.x_completion), 0) as completion_tokens,
         coalesce(sum(everyones.x_cached), 0) as cached_tokens,
         coalesce(sum(everyones.x_written), 0) as cache_write_tokens,
         coalesce(
           sum(everyones.x_prompt) filter (where everyones.x_cached is not null), 0
         ) as measured_prompt_tokens,
         (select jsonb_agg(
                   jsonb_build_object(
                     'model', pm.x_reply_model,
                     'promptTokens', pm.p_prompt,
                     'completionTokens', pm.p_completion,
                     'cachedTokens', pm.p_cached,
                     'cacheWriteTokens', pm.p_written
                   )
                   order by pm.p_prompt desc
                 )
          from per_model pm
          where pm.x_agent_id = everyones.x_agent_id) as by_model
  from everyones
  group by everyones.x_agent_id, everyones.x_agent_name, everyones.x_agent_emoji, everyones.x_agent_model
  order by (
    coalesce(sum(everyones.x_prompt), 0) + coalesce(sum(everyones.x_completion), 0)
  ) desc;
end;
$$;

-- The month-by-month trend, now priceable. Still exactly `p_months` buckets:
-- the model dimension lives inside `by_model`, so an unused month is one row of
-- zeros with a null `by_model` rather than a missing bucket.
create function public.workspace_usage_monthly(p_workspace_id uuid, p_months int default 6)
returns table (
  month date,
  message_count bigint,
  prompt_tokens bigint,
  completion_tokens bigint,
  cached_tokens bigint,
  cache_write_tokens bigint,
  by_model jsonb
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
  ),
  replies as (
    select date_trunc('month', m.created_at) as x_bucket,
           coalesce(m.model, a.model) as x_reply_model,
           m.id as x_message_id,
           m.prompt_tokens as x_prompt,
           m.completion_tokens as x_completion,
           m.cached_tokens as x_cached,
           m.cache_write_tokens as x_written
    from public.messages m
    join public.chat_sessions s on s.id = m.session_id
    join public.agents a on a.id = s.agent_id
    where m.role = 'assistant'
      and a.workspace_id = p_workspace_id
      and m.created_at >= (select min(bucket) from span)
  ),
  per_model as (
    select replies.x_bucket,
           replies.x_reply_model,
           count(replies.x_message_id) as p_count,
           coalesce(sum(replies.x_prompt), 0) as p_prompt,
           coalesce(sum(replies.x_completion), 0) as p_completion,
           coalesce(sum(replies.x_cached), 0) as p_cached,
           coalesce(sum(replies.x_written), 0) as p_written
    from replies
    group by replies.x_bucket, replies.x_reply_model
  )
  -- `::bigint` on every one of these, because summing a sum is not the type it
  -- came from: `count()` and `sum(int)` are bigint, and `sum(bigint)` is
  -- numeric, which a `returns table (... bigint)` refuses at call time with
  -- `42804`. The per-model grouping is what introduced the second sum.
  select span.bucket::date,
         coalesce(sum(pm.p_count), 0)::bigint as message_count,
         coalesce(sum(pm.p_prompt), 0)::bigint as prompt_tokens,
         coalesce(sum(pm.p_completion), 0)::bigint as completion_tokens,
         coalesce(sum(pm.p_cached), 0)::bigint as cached_tokens,
         coalesce(sum(pm.p_written), 0)::bigint as cache_write_tokens,
         (select jsonb_agg(
                   jsonb_build_object(
                     'model', x.x_reply_model,
                     'promptTokens', x.p_prompt,
                     'completionTokens', x.p_completion,
                     'cachedTokens', x.p_cached,
                     'cacheWriteTokens', x.p_written
                   )
                   order by x.p_prompt desc
                 )
          from per_model x
          where x.x_bucket = span.bucket) as by_model
  from span
  left join per_model pm on pm.x_bucket = span.bucket
  group by span.bucket
  order by span.bucket;
end;
$$;

-- The grants the DROPs above took with them, exactly as 0062 left them: `anon`
-- keeps EXECUTE on `workspace_usage` to preserve a state the database was
-- already in (0025), and the other two decline to treat that as a precedent.
grant execute on function public.workspace_usage(uuid) to anon, authenticated, service_role;
revoke execute on function public.workspace_usage_all(uuid) from public;
revoke execute on function public.workspace_usage_monthly(uuid, int) from public;
grant execute on function public.workspace_usage_all(uuid) to authenticated, service_role;
grant execute on function public.workspace_usage_monthly(uuid, int) to authenticated, service_role;

-- ---- verify --------------------------------------------------------------
--
-- Paste after applying. One statement, because the SQL editor shows only the
-- last result: three signatures carrying `by_model`, three EXECUTE grants that
-- survived the drop, and the sum that must not move.
--
-- No ledger insert in this file, and no `begin`/`commit` either: `migrate.sh`
-- wraps each file in its own transaction and appends the
-- `covan_meta.migrations` row itself, so a file carrying its own would make the
-- script's insert a duplicate-key error. A hand-applied run through the SQL
-- editor is the route that has to add that row by hand.
--
-- select (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--         where n.nspname = 'public'
--           and p.proname in ('workspace_usage', 'workspace_usage_all', 'workspace_usage_monthly')
--           and pg_get_function_result(p.oid) like '%by_model jsonb%') as functions_with_by_model,
--        has_function_privilege('anon', 'public.workspace_usage(uuid)', 'execute') as anon_keeps_usage,
--        has_function_privilege('authenticated', 'public.workspace_usage_all(uuid)', 'execute') as auth_keeps_all,
--        has_function_privilege('authenticated', 'public.workspace_usage_monthly(uuid, int)', 'execute') as auth_keeps_monthly,
--        (select count(*) from public.messages where role = 'assistant') as assistant_rows,
--        (select count(*) from covan_meta.migrations
--          where filename = '0071_priced_by_the_model_that_answered.sql') as ledger_row;
--
-- Expect: 3, true, true, true, the row count from before, 1.
