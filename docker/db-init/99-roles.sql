-- Give the Supabase service roles the password the services log in with.
--
-- Adapted from supabase/supabase@master:docker/volumes/db/roles.sql, which is
-- a flat list of `ALTER USER ... WITH PASSWORD`. That form does not survive
-- contact with a trimmed stack: it names supabase_functions_admin, a role
-- created by the Database Webhooks init script this stack does not run, and the
-- resulting `role "supabase_functions_admin" does not exist` aborts the image's
-- whole init pipeline (migrate.sh runs `set -eu` with ON_ERROR_STOP=1). The
-- observed damage was silent — Postgres started and reported healthy with the
-- image's own migrations never applied, so `_realtime`, `graphql`, `pgsodium`
-- and `vault` were all missing and Realtime could not start.
--
-- \gexec builds one ALTER per role that actually exists, so a role the image
-- ships today and drops tomorrow is skipped instead of taking the stack down.
\set pgpass `echo "$POSTGRES_PASSWORD"`

select format('alter role %I with password %L', rolname, :'pgpass')
from pg_roles
where rolname in (
  'authenticator',
  'pgbouncer',
  'supabase_auth_admin',
  'supabase_storage_admin',
  'supabase_replication_admin',
  'supabase_read_only_user',
  'supabase_functions_admin'
)
\gexec
