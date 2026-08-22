-- 0025_what_the_cache_already_paid_for.sql
--
-- `chat.ts` goes to real trouble to be cacheable. The persona, the document
-- manifest and the prior turns are assembled so the prefix is byte-identical
-- turn over turn, and the retrieved knowledge block is deliberately placed
-- *after* them — just before the latest user turn — so that the one part of the
-- prompt that changes every turn cannot invalidate the part that does not.
-- OpenAI's automatic prompt cache then serves the repeated prefix at a
-- discount: half price on the 4o models, a quarter on the 4.1 models.
--
-- None of which has ever been measured. `0006` recorded `prompt_tokens` and
-- `completion_tokens` and stopped there, so the usage view has always priced
-- every prompt token as fresh. Two things follow, and they point opposite ways:
-- the displayed cost is an overestimate, and — the reason this migration
-- exists — a change that quietly breaks the cache would show up as nothing at
-- all. The arrangement above is load-bearing and currently unobservable.
--
-- Input is roughly two thirds of the tokens and about half the bill, so the
-- discount is worth knowing the size of before anyone tunes the history or
-- retrieval budgets against it. Measured 2026-08-23 on `the-live-project-ref`,
-- the project `VITE_SUPABASE_URL` actually points at: 10 assistant replies
-- averaging 2,248 prompt to 921 completion tokens, which on gpt-4o is about
-- $0.015 a reply.
--
-- Ten replies is a small sample and the database is days old — it was rebuilt
-- from zero on 2026-08-22 — so treat the ratio as the finding and the absolute
-- figures as provisional. The first measurement of this was taken against
-- `the-retired-proj-ref` by mistake, which is the retired predecessor and still
-- holds 91 replies of older traffic; it is reachable and healthy and looks
-- exactly like production until you check the ref, so check the ref.
--
-- Nullable with no default and no backfill: every reply already stored was
-- billed under an unknown cache state, and writing 0 would assert those prompts
-- missed the cache entirely. They may well not have. Null means "not recorded",
-- which is the truth, and `estimateCostUsd` reads a missing count as no
-- discount — so historical rows keep the figure they have always shown.
--
-- Reported by OpenAI as `usage.prompt_tokens_details.cached_tokens`, and it is
-- a SUBSET of `prompt_tokens`, not an addition. Anything summing the two would
-- double-count; `worker/src/lib/pricing.ts` subtracts it back out.

alter table public.messages add column if not exists cached_tokens int;

-- DROP first, unlike 0022 which replaced this function in place. `create or
-- replace function` cannot change a function's return type, and adding columns
-- to a `returns table` is exactly that — it fails with "cannot change return
-- type of existing function" and the migration stops half-applied. 0022 could
-- replace because its returned columns were identical; this one cannot.
--
-- Dropping means the grants go too. On this database they are explicit rather
-- than inherited (`anon`, `authenticated` and `service_role` each hold EXECUTE,
-- checked 2026-08-23), and a recreated function would come back with whatever
-- the platform default happens to be that day — the moving target 0023 was
-- written about. So they are re-granted below, in this file, rather than left
-- to be inherited. Without EXECUTE the symptom is the same unhelpful 42501 from
-- PostgREST that 0023 documents.
drop function if exists public.workspace_usage(uuid);

-- Unchanged from 0022 except for the two new sums: still `security invoker`,
-- still scoping sessions with `s.user_id = auth.uid()` in the join rather than
-- leaning on a select policy to do it (0022 explains at length why that
-- distinction matters), and still a LEFT JOIN with the message condition in the
-- ON clause so an agent nobody has chatted with keeps appearing at zero.
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
         -- The denominator a cache hit rate has to be divided by. Not
         -- `prompt_tokens`: that includes every reply from before this column
         -- existed, all of which contribute nothing to the numerator, so
         -- dividing by it would report a rate that starts near zero and climbs
         -- for weeks purely as old replies are outnumbered. Restricting the sum
         -- to rows that actually carry a measurement makes the ratio mean "of
         -- the input we have measured, this much was cached" from the very
         -- first reply after 0025.
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

-- The three roles that held EXECUTE before the drop. `anon` is included to
-- restore the state this database was already in and not to widen anything:
-- the function is security invoker and scopes every row by `auth.uid()`, so a
-- caller who has not signed in reads nothing through it.
grant execute on function public.workspace_usage(uuid) to anon, authenticated, service_role;
