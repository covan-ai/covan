-- Each write names its columns: the tables 0023 granted wholesale are granted
-- the columns the product writes through a caller's own client, and no more.
--
-- 0023 restored the table-wide INSERT and UPDATE that Supabase had stopped
-- handing out, on every table that existed then, and left the policies to do
-- all of the work. A policy scopes the ROW. It says nothing about which
-- columns of a row the caller may set, and several earlier migrations closed
-- exactly that gap: an engine column on a document (0085), a
-- membership's user (0086), a key's tags (0088), an invitation's status
-- (0090). Those were closed one at a time. This closes the rest the same way,
-- from a map of every write the API makes with a caller's client:
--
--   messages           a person's own turn: session, role, text, sender. The
--                      version columns (`superseded_at`, `original_message_id`)
--                      are `show_message_version`'s, and grounding, tokens and
--                      outcome are the service role's.
--   chat_sessions      created with an agent, a title, a kind and a
--                      visibility; renamed and re-shared after. `updated_at`
--                      is `touch_session`'s.
--   routines           what the routine form and `schedule_job` set, and what
--                      editing one changes. Never the engine's bookkeeping
--                      (`claimed_at`, `cursor`, `runs_done`, `last_run_at`),
--                      its identity (`id`, `workspace_id`, `user_id`,
--                      `agent_id`, the source), or its key (0088's default).
--   agents             created and tuned; `created_by` is set once.
--   api_keys           created, renamed, revoked. `last_used_at` is the
--                      service role's.
--   knowledge_bundles  created, renamed, described.
--   ideas              a card's text, stage and order.
--   document_chunks    a passage, written with its document; moved with it.
--   favorites, feedback, agent_bundles   inserted, never updated.
--   workspaces         renamed and configured. Created only by
--                      `create_workspace`.
--   profiles           never inserted by a client — `handle_new_user` does.
--   workspace_events, routine_runs   written only by definer functions and
--                      the service role.
--
-- An upsert is an INSERT whose conflict becomes an UPDATE of every column it
-- names, the conflict key included, so a table written by upsert is granted
-- the same columns both ways.
--
-- `tests/rls/grant-ratchet.test.ts` holds the result: a grant that widens
-- fails it, and one that narrows has to be written into it.

revoke insert, update on public.messages from anon, authenticated;
grant insert (session_id, role, content, sender_id) on public.messages to authenticated;
grant update (content) on public.messages to authenticated;

revoke insert, update on public.chat_sessions from anon, authenticated;
grant insert (agent_id, user_id, title, workspace_id, kind, visibility)
  on public.chat_sessions to authenticated;
grant update (title, visibility) on public.chat_sessions to authenticated;

revoke insert, update on public.routines from anon, authenticated;
grant insert (workspace_id, agent_id, user_id, name, visibility, source_kind, source_config,
              instruction, delivery_channel_id, schedule_cron, timezone, trigger_kind,
              output_bundle_id, output_retention, ends_after_runs, next_run_at)
  on public.routines to authenticated;
grant update (name, instruction, visibility, delivery_channel_id, trigger_kind,
              output_bundle_id, output_retention, schedule_cron, timezone, next_run_at,
              status, paused_reason, consecutive_failures, updated_at)
  on public.routines to authenticated;

revoke insert, update on public.agents from anon, authenticated;
grant insert (workspace_id, name, emoji, model, persona, mode, temperature,
              reasoning_effort, web_search, created_by)
  on public.agents to authenticated;
grant update (name, emoji, model, persona, mode, temperature, reasoning_effort, web_search)
  on public.agents to authenticated;

revoke insert, update on public.api_keys from anon, authenticated;
grant insert (workspace_id, user_id, name, token_hash, prefix) on public.api_keys to authenticated;
grant update (name, revoked_at) on public.api_keys to authenticated;

revoke insert, update on public.knowledge_bundles from anon, authenticated;
grant insert (workspace_id, name, description, created_by)
  on public.knowledge_bundles to authenticated;
grant update (name, description) on public.knowledge_bundles to authenticated;

revoke insert, update on public.ideas from anon, authenticated;
grant insert (session_id, workspace_id, title, detail, stage, position, created_by,
              source_message_id)
  on public.ideas to authenticated;
grant update (title, detail, stage, position, updated_at) on public.ideas to authenticated;

revoke insert, update on public.document_chunks from anon, authenticated;
grant insert (document_id, bundle_id, workspace_id, chunk_index, content, context, embedding)
  on public.document_chunks to authenticated;
grant update (bundle_id) on public.document_chunks to authenticated;

revoke insert, update on public.favorites from anon, authenticated;
grant insert (user_id, agent_id) on public.favorites to authenticated;

revoke insert, update on public.feedback from anon, authenticated;
grant insert (user_id, workspace_id, kind, message, path, message_id)
  on public.feedback to authenticated;

revoke insert, update on public.agent_bundles from anon, authenticated;
grant insert (agent_id, bundle_id) on public.agent_bundles to authenticated;

revoke insert, update on public.workspaces from anon, authenticated;
grant update (name, slug, default_model, gap_report_enabled) on public.workspaces to authenticated;

revoke insert on public.profiles from anon, authenticated;

revoke insert, update on public.workspace_events from anon, authenticated;
revoke insert, update on public.routine_runs from anon, authenticated;

-- An upsert keyed on (agent_id, tool_connection_id, slug). `granted_by` stays
-- insertable because 0059's trigger overwrites it with the caller, which is
-- what `tests/rls/agent-harness.test.ts` holds; it is never trusted as sent.
revoke insert, update on public.tool_connection_grants from anon, authenticated;
grant insert (agent_id, tool_connection_id, workspace_id, slug, mode, granted_by)
  on public.tool_connection_grants to authenticated;
grant update (agent_id, tool_connection_id, workspace_id, slug, mode)
  on public.tool_connection_grants to authenticated;
