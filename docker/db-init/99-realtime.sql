-- Realtime keeps its own tables (tenants, extensions, migration ledger) in
-- `_realtime` and connects with `search_path = _realtime`. The schema has to
-- exist before it first connects, or it crash-loops on boot.
--
-- Adapted from supabase/supabase@master:docker/volumes/db/realtime.sql. Two
-- changes: the owner is spelled out rather than read from $POSTGRES_USER, and
-- this runs from init-scripts/ rather than migrations/ — the supabase/postgres
-- entrypoint only walks migrations/ after every init-script has succeeded, so a
-- file placed there is skipped entirely if anything earlier fails.
create schema if not exists _realtime;
alter schema _realtime owner to postgres;
