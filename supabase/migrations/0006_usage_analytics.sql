-- =========================================================================
-- Usage & cost analytics
--
-- Record token usage per assistant reply and expose per-agent aggregates so
-- the dashboard can show how much each agent is used and a rough cost estimate.
--
-- Privacy: workspace_usage runs security invoker, so RLS applies — chat
-- sessions are private per user, so the aggregate reflects the CURRENT user's
-- own conversations, not everyone's. All workspace agents still appear (0 usage
-- when the user hasn't chatted with them).
-- =========================================================================

alter table public.messages add column if not exists prompt_tokens int;
alter table public.messages add column if not exists completion_tokens int;

create or replace function public.workspace_usage(p_workspace_id uuid)
returns table (
  agent_id uuid,
  agent_name text,
  agent_emoji text,
  agent_model text,
  message_count bigint,
  prompt_tokens bigint,
  completion_tokens bigint
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
         coalesce(sum(m.completion_tokens), 0) as completion_tokens
  from public.agents a
  left join public.chat_sessions s on s.agent_id = a.id
  left join public.messages m on m.session_id = s.id and m.role = 'assistant'
  where a.workspace_id = p_workspace_id
  group by a.id, a.name, a.emoji, a.model
  order by (coalesce(sum(m.prompt_tokens), 0) + coalesce(sum(m.completion_tokens), 0)) desc;
$$;
