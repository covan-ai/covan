-- 0022_usage_is_your_own.sql
--
-- The Usage section says "Yours alone — your conversations are private, and so
-- are these figures." It stopped being true two migrations after it was
-- written.
--
-- `workspace_usage` is `security invoker`, and 0006's header explains that this
-- is what makes it private: chat sessions were per-user, so RLS scoped the
-- aggregate to the caller without the query having to say so. Then 0008 added
-- shared sessions, and the select policies on `chat_sessions` and `messages`
-- began admitting any shared session in the workspace. Brainstorms are created
-- shared by default (worker/src/routes/sessions.ts), so most people's totals
-- silently began including their colleagues' conversations. Nothing failed;
-- the number just quietly started meaning something else.
--
-- Depending on a select policy to do a query's scoping is what broke: the
-- policy answers "may this person see this row", the function needed "is this
-- row this person's", and the two were the same answer only until sharing
-- existed. So the join now says which sessions it means, and the guarantee no
-- longer moves when a policy does. 0006's header describes the arrangement as
-- it was, not as it is; read it as history.
--
-- Making the figures true rather than relabelling them, because the quota
-- number directly above on the same screen is per-user and always has been —
-- two numbers side by side had come to mean two different things.
--
-- Still a LEFT JOIN with the condition in the ON clause, not the WHERE: every
-- agent in the workspace has to keep appearing, at zero, for someone who has
-- not chatted with it yet. Moving it to WHERE would drop those rows.

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
  left join public.chat_sessions s
    on s.agent_id = a.id and s.user_id = auth.uid()
  left join public.messages m on m.session_id = s.id and m.role = 'assistant'
  where a.workspace_id = p_workspace_id
  group by a.id, a.name, a.emoji, a.model
  order by (coalesce(sum(m.prompt_tokens), 0) + coalesce(sum(m.completion_tokens), 0)) desc;
$$;
