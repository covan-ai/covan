-- =========================================================================
-- The grant 0043 forgot
--
-- 0034 wrote this file once already, for 0033. The words were:
--
--   "From here on a migration that adds a table grants for it, in the same
--    file. Forgetting is loud — PostgREST returns 42501 — and a loud failure is
--    worth more than an inherited grant nobody re-reads."
--
-- 0043 and 0044 obeyed the letter of it and still shipped the bug. They grant,
-- carefully and narrowly, to `authenticated` — column lists, three columns of
-- UPDATE, no INSERT — and to `service_role` they grant nothing at all. Every
-- one of their five tables is written by the service client, so on the hosted
-- project the feature was dead on arrival.
--
-- ---- what it looked like -------------------------------------------------
--
-- Worse than a 500 on the first click, because the first click worked. The
-- OAuth round trip completed: Notion showed its picker, returned a code, and
-- the token exchange succeeded. `GET /connections/callback` then answered 302
-- like it should. It was the INSERT after the exchange that died —
--
--   42501  permission denied for table connections
--
-- — so the browser landed on `/integrations?error=save_failed` with a live
-- grant on Notion's side and no row on ours. Everything a person could see
-- pointed at Notion. The line that named the real cause was in `wrangler tail`,
-- which is not where anybody looks when the third-party consent screen is the
-- last thing they touched.
--
-- ---- why nothing caught it -----------------------------------------------
--
-- `src/lib/migration-grants.test.ts` exists precisely to catch this, and it
-- passed. It asked "does this migration grant something on this table?" and
-- 0043 does — to `authenticated`. The question it was not asking is "to which
-- role", and that is the whole distance between a green suite and a feature
-- nobody can turn on. That test is rewritten alongside this file to ask per
-- role, which is the durable half of this fix; this file is only the repair.
--
-- The RLS suite cannot help here for the reason 0023 and 0034 both record: the
-- compose stack and the Supabase CLI stack still hand out the old permissive
-- default, so every database we are willing to test against grants what
-- production withholds.
--
-- ---- the grants ----------------------------------------------------------
--
-- Table-level and all four verbs, the shape 0034 used. Narrowing them would be
-- theatre: `service_role` has BYPASSRLS, so a column it cannot select through a
-- grant is a column it can reach by any other route it likes. The grants are
-- the gate on *whether* PostgREST will speak to it at all, not on what it may
-- see, and pretending otherwise would leave a reader thinking these tables are
-- more constrained than they are.
--
-- `anon` gets nothing, and `authenticated` keeps exactly what 0043 and 0044
-- gave it. Nothing here widens a client's reach by one column.
--
-- Deliberately not in this list: `feedback` (0041), which also names no
-- `service_role` and is right not to. `routes/feedback.ts` inserts through the
-- caller's own client, so the row is written as the person who wrote it and
-- RLS is the point rather than an obstacle. It is named in the test's
-- exemption list instead, where a decision belongs.
--
-- Applied by hand to the hosted project on 2026-09-04, before this file
-- existed, because the alternative was leaving connections broken while a PR
-- went round. Re-running it there is harmless — a grant is idempotent — and
-- every other database still needs it.
-- =========================================================================

-- ---- connections ---------------------------------------------------------
-- The callback inserts the row (the OAuth exchange and the token encryption
-- both happen in the worker), and the engine updates it every tick: status,
-- next_sync_at, last_sync_at, consecutive_failures, and the claim that
-- `claim_due_connections` hands out.
grant select, insert, update, delete on public.connections to service_role;

-- ---- connection_runs -----------------------------------------------------
-- Written only by the engine — one row per sync, from `sync.ts`. A client
-- reads them and never writes one, which is why 0043's grant to
-- `authenticated` is SELECT alone and stays that way.
grant select, insert, update, delete on public.connection_runs to service_role;

-- ---- slack_installations -------------------------------------------------
-- The install upsert in `routes/slack.ts` runs as the service role: it stores
-- the bot token, encrypted, which no client may write.
grant select, insert, update, delete on public.slack_installations to service_role;

-- ---- slack_identities ----------------------------------------------------
-- Written by the events endpoint on the first message from a Slack user, where
-- there is no Covan caller yet for RLS to resolve — resolving one is the whole
-- purpose of the row.
grant select, insert, update, delete on public.slack_identities to service_role;

-- ---- slack_threads -------------------------------------------------------
-- Same path, same reason: a thread becomes a `chat_sessions` row and the link
-- between them is written while answering, by the engine, on behalf of
-- somebody who is not making an HTTP request to us.
grant select, insert, update, delete on public.slack_threads to service_role;
