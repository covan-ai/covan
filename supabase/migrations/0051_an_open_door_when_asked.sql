-- =========================================================================
-- An open door when asked
--
-- Web search: the feature that decides whether an agent can look beyond what
-- its documents say. Web search is ON by default for new agents as of
-- 2026-09-17. Models that support it (Opus 5/4.8/4.7/4.6, Sonnet 5/4.6) get
-- web_search_20260209; older models get web_search_20250305.
--
-- The toggle remains for edge cases where teams explicitly want answers
-- limited to their documents only (e.g., summarizing confidential files).
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
