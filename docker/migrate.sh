#!/bin/sh
# Apply supabase/migrations/*.sql in filename order, exactly once each.
#
# Why a ledger and not a plain `for f in *.sql; do psql -f "$f"; done`:
# the migrations are NOT idempotent. 0001_init.sql opens with
# `create table public.profiles (...)` — no `if not exists` — so a second run
# of the naive loop aborts on the first file and leaves the stack broken. The
# ledger in covan_meta.migrations makes `docker compose up` safe to run any
# number of times, and makes adding a migration later a no-op for everything
# already applied.
#
# The ledger lives in its own schema, not `public`: PGRST_DB_SCHEMAS exposes
# `public` through PostgREST, and the list of applied migrations is not
# something the Data API should serve.
set -eu

export PGPASSWORD="$POSTGRES_PASSWORD"
PSQL="psql -v ON_ERROR_STOP=1 -h ${POSTGRES_HOST} -p ${POSTGRES_PORT} -U postgres -d ${POSTGRES_DB}"

$PSQL -q -c 'create schema if not exists covan_meta;'
$PSQL -q -c 'create table if not exists covan_meta.migrations (
  filename   text primary key,
  applied_at timestamptz not null default now()
);'

applied=0
skipped=0
for f in /migrations/*.sql; do
  name=$(basename "$f")
  if [ -n "$($PSQL -tAc "select 1 from covan_meta.migrations where filename = '$name'")" ]; then
    echo "skip     $name (already applied)"
    skipped=$((skipped + 1))
    continue
  fi

  echo "applying $name"
  # The migration and its ledger row go in one transaction (-1), so a failure
  # halfway through leaves neither behind. None of the migrations contain
  # explicit BEGIN/COMMIT or a statement that cannot run inside a transaction
  # (no CREATE INDEX CONCURRENTLY, no ALTER TYPE ... ADD VALUE).
  {
    cat "$f"
    printf "\ninsert into covan_meta.migrations (filename) values ('%s');\n" "$name"
  } > /tmp/covan-migration.sql
  $PSQL -q -1 -f /tmp/covan-migration.sql
  applied=$((applied + 1))
done

echo "migrations complete: $applied applied, $skipped already present"
