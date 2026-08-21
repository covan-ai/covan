#!/bin/sh
# Apply the project's *.sql migrations in order, exactly once each.
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
#
# MIGRATION_DIRS is a space-separated list, applied left to right, and missing
# directories are skipped. That is what lets one script serve every path this
# schema is applied through — the compose stack, CI, and a production database —
# and lets a deployment carry schema of its own without forking the file.
# Defaults are the container mount points:
#
#   /migrations        supabase/migrations/  the schema, always present
#   /migrations-cloud  a deployment's own additions, mounted only where they exist
#
# Against a database that is not the compose one, point it at the working copy:
#
#   POSTGRES_HOST=db.<ref>.supabase.co POSTGRES_PORT=5432 POSTGRES_DB=postgres \
#   POSTGRES_PASSWORD=... MIGRATION_DIRS="supabase/migrations supabase/cloud" \
#   sh docker/migrate.sh
set -eu

export PGPASSWORD="$POSTGRES_PASSWORD"
PSQL="psql -v ON_ERROR_STOP=1 -h ${POSTGRES_HOST} -p ${POSTGRES_PORT} -U postgres -d ${POSTGRES_DB}"

DIRS=${MIGRATION_DIRS:-"/migrations /migrations-cloud"}

# Gather first, apply second, so an ordering or naming problem is reported
# before anything has been written to the database.
seen=""
files=""
for dir in $DIRS; do
  [ -d "$dir" ] || continue
  for f in "$dir"/*.sql; do
    [ -e "$f" ] || continue
    name=$(basename "$f")
    # The ledger keys on the filename alone, and changing that would make every
    # already-applied migration look new. So the constraint is that filenames
    # stay unique across directories — which the hosted files already respect by
    # being numbered separately. Enforced rather than assumed: a collision would
    # otherwise silently skip the second file.
    case " $seen " in
    *" $name "*)
      echo "ERROR: $name appears in more than one migration directory." >&2
      echo "Filenames must be unique across $DIRS — the ledger cannot tell them apart." >&2
      exit 1
      ;;
    esac
    seen="$seen $name"
    files="$files $f"
  done
done

if [ -z "$files" ]; then
  echo "ERROR: no .sql files found in any of: $DIRS" >&2
  exit 1
fi

$PSQL -q -c 'create schema if not exists covan_meta;'
$PSQL -q -c 'create table if not exists covan_meta.migrations (
  filename   text primary key,
  applied_at timestamptz not null default now()
);'

applied=0
skipped=0
for f in $files; do
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
