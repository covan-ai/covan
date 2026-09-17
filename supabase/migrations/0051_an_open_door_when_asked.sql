-- =========================================================================
-- An open door when asked
--
-- Web search: the feature that decides whether an agent can look beyond what
-- its documents say. Covan's positioning is "based on your team's knowledge",
-- which is a deliberate claim — RAG over the workspace's uploads is not just
-- the first answer but the *intended* one. The web is an escape hatch, not
-- the default behaviour, and opening it by default would contradict what the
-- product promises to do.
--
-- So this is off for every agent that exists, and off for every new one until
-- somebody turns it on. That is not a limitation: it is the shape the feature
-- was designed to have.
--
-- **Why a column and not an env var?** The shape of a question decides
-- whether looking at the internet helps. "Summarise this brief" should stay
-- in the brief; "how many staff do they have" may need the web to answer at
-- all. An env-wide switch treats those two the same, and silently searching
-- the web to summarise a confidential document is the opposite of what a team
-- buying a "your knowledge base" tool would expect to happen.
--
-- No policy change. `agents_update_workspace_member` (0021) governs writes;
-- no separate policy is needed for this one column.
-- =========================================================================

alter table public.agents
  add column if not exists web_search boolean not null default false;
