-- =========================================================================
-- Workspace defaults
--
-- One setting so far: which model new agents start on. Every agent still
-- chooses its own — this only decides where the picker begins, so a team that
-- wants cheap-and-fast by default stops having to change it every time.
--
-- Null means "no preference": the interface falls back to its own default, and
-- an existing workspace that has never set one behaves exactly as before.
--
-- Deliberately not an enum. The set of usable models changes faster than the
-- schema should, and the API validates against the list it actually supports
-- (worker/src/lib/models.ts) before writing. A stale value cannot break a
-- conversation either: resolveModel() falls back to the default for anything it
-- does not recognise.
-- =========================================================================

alter table public.workspaces add column if not exists default_model text;

-- No policy changes. `workspaces_update_admin` already governs this table, so
-- the same people who can rename a workspace can set its default, and nobody
-- else can.
