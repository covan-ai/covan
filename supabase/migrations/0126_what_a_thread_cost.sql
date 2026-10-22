-- =========================================================================
-- What a thread cost
--
-- The Threads table (A5) has a Credits column: what each thread on the page
-- has spent so far. The figure is priced by the API from the models and
-- tokens its replies recorded, as every usage figure is; this is the read
-- that adds them up per thread and model.
--
-- Security invoker, on purpose: a thread's cost is shown beside a thread the
-- caller can already open, so the messages it sums are exactly the ones the
-- policies already let them read. A thread they cannot see contributes
-- nothing, even if its id is in the list.
-- =========================================================================

create or replace function public.session_token_totals(p_session_ids uuid[])
returns table (
  session_id         uuid,
  model              text,
  prompt_tokens      bigint,
  completion_tokens  bigint,
  cached_tokens      bigint,
  cache_write_tokens bigint
)
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select m.session_id,
         m.model,
         coalesce(sum(m.prompt_tokens), 0)::bigint,
         coalesce(sum(m.completion_tokens), 0)::bigint,
         coalesce(sum(m.cached_tokens), 0)::bigint,
         coalesce(sum(m.cache_write_tokens), 0)::bigint
    from public.messages m
   where m.session_id = any (p_session_ids)
     and m.role = 'assistant'
     and (m.prompt_tokens is not null or m.completion_tokens is not null)
   group by m.session_id, m.model;
$$;

revoke all on function public.session_token_totals(uuid[]) from public, anon;
grant execute on function public.session_token_totals(uuid[]) to authenticated, service_role;
