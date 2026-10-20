-- =========================================================================
-- A source that keeps up
--
-- A connected Notion workspace or Drive folder was re-read every six hours by
-- default (0043). For a team piloting Covan that is the length of a working
-- day: a page corrected at ten is still answered wrong at four, with a
-- citation, which is worse than no answer (covan-cloud#437).
--
-- Thirty minutes instead. A run that finds nothing changed costs a listing
-- and no embeddings — the sync compares versions before it reads a file — so
-- what a shorter interval buys is freshness, not spend. Fifteen stays the
-- floor 0043 set for the providers' rate limits.
--
-- Existing connections still on the old default move with it. Six hours was
-- the default and nothing more; anyone who wants it back has the same
-- choice in the connection's card, which now offers fifteen and thirty
-- minutes as well.
-- =========================================================================

alter table public.connections alter column sync_interval_minutes set default 30;

update public.connections
   set sync_interval_minutes = 30,
       next_sync_at = least(next_sync_at, now() + interval '30 minutes')
 where sync_interval_minutes = 360;
