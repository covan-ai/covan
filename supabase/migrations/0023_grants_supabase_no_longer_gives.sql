-- The table grants Supabase used to hand out for free.
--
-- Every migration before this one assumes that creating a table in `public`
-- makes it reachable through PostgREST. 0012 says so out loud — it opens by
-- stripping "the blanket grant Supabase gives `authenticated`". That grant came
-- from ALTER DEFAULT PRIVILEGES on the `postgres` role, and Supabase has since
-- narrowed it: a project created today gives anon, authenticated and
-- service_role only TRUNCATE, REFERENCES and TRIGGER on a newly created table.
-- No SELECT, no INSERT, no UPDATE, no DELETE.
--
-- The symptom is total and it does not look like a permissions problem: every
-- request through PostgREST answers `42501 permission denied for table ...` on
-- a schema whose policies are all present and correct. Found 2026-08-22 while
-- building a fresh hosted project; the older project predates the change and
-- was never affected, which is why nothing caught it.
--
-- Grants are the coarse layer here and always were — RLS decides who sees which
-- row (docs/architecture.md). This restores the coarse layer explicitly rather
-- than inheriting it from a platform default that has already moved once.
--
-- Idempotent: on a database that already holds these grants — the older hosted
-- project, and the compose stack, whose image still sets the wide default —
-- every statement below is a no-op.

grant select, insert, update, delete on all tables in schema public
  to anon, authenticated, service_role;
grant usage, select on all sequences in schema public
  to anon, authenticated, service_role;

-- Re-apply 0012's lockdown, in the same transaction that widened everything.
-- The blanket grant above hands `secret_ciphertext` to every signed-in client
-- and routine_deliveries to everyone, and it does it silently — nothing errors,
-- the column is just readable. Splitting these two halves across migrations
-- would leave a window where that is the committed state.
revoke all on public.delivery_channels from anon, authenticated;
grant select (id, workspace_id, user_id, kind, label, created_at)
  on public.delivery_channels to authenticated;
grant update (label) on public.delivery_channels to authenticated;
grant delete on public.delivery_channels to authenticated;

revoke all on public.routine_deliveries from anon, authenticated;

-- Deliberately NOT restoring the wide ALTER DEFAULT PRIVILEGES that Supabase
-- removed. Re-arming it would make the next table added to this schema
-- world-readable by default, which is the trap this migration exists to clean
-- up after. From here on a migration that adds a table grants for it, in the
-- same file. Forgetting is loud — PostgREST returns 42501 — and a loud failure
-- is worth more than an inherited grant nobody re-reads.
