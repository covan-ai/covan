-- What a routine actually sent, kept alongside the run that sent it.
--
-- The engine deliberately persists no source content: routines.cursor holds
-- fingerprints (seen keys, an etag, a content hash) and nothing else, so a feed
-- this workspace watches is never mirrored into our database. This column does
-- not change that. It stores the agent's own generated summary — text we wrote,
-- already delivered to the owner's inbox or Slack — so that "what did it send
-- me last Tuesday?" has an answer inside the product instead of only in a
-- mailbox the user may have cleared.
--
-- Nullable on purpose: `skipped` and `failed` runs have no summary, and every
-- run recorded before this migration has none either.
alter table public.routine_runs
  add column if not exists summary text;

-- No policy changes needed. routine_runs_select_visible already scopes reads to
-- the routine's owner and, once shared, its workspace — which is exactly the
-- audience allowed to see what the routine produced.
