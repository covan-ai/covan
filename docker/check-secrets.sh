#!/bin/sh
# Refuse to bring the stack up while it is configured to face a network and
# still holds the credentials this public repository ships.
#
# worker/src/lib/env.ts's loadEnv already does this for covan-api: at boot, if
# ALLOWED_ORIGIN is not localhost-only, it refuses to start on a handful of
# published defaults. But JWT_SECRET and POSTGRES_PASSWORD are consumed by
# Kong, GoTrue, PostgREST and Postgres — none of which run loadEnv, so that
# guard never sees them. This script is the equivalent check for the rest of
# the stack, wired in docker-compose.yml as a `secrets-check` service that
# `db` depends on with `condition: service_completed_successfully`. Every
# other service descends from `db` (auth, rest, realtime directly; kong from
# auth+rest; migrate from db+auth; covan-api from migrate+kong; covan-web from
# covan-api), so failing here blocks the entire stack, not just one container.
#
# Keep this in sync with env.ts's servesLocalhostOnly() and
# PUBLISHED_DEFAULTS — same semantics, same literals, so an operator only has
# to satisfy one set of rules to clear both checks.
#
# Deliberately NOT duplicated here: ROUTINE_SECRET_KEY's base64-length check.
# covan-api already fails on that at boot, and re-deriving byte lengths from
# base64 in POSIX sh would just be a worse copy of a check that already
# exists. This script only covers the values that never reach loadEnv at all.
#
# POSIX sh, not bash: this runs in postgres:17.6-alpine, which has no bash.
set -eu

# A stack whose frontend is on localhost is a laptop, not a deployment — the
# same carve-out env.ts's servesLocalhostOnly() makes. It splits on commas,
# trims each entry, drops empties, and requires *every* remaining entry to
# match ^https?://(localhost|127\.0\.0\.1)(:\d+)?/?$ — so one public origin
# alongside a local one still fails the check. Mirrored here entry by entry
# rather than with one combined regex, so that semantics is easy to see.
localhost_only() {
  origin_list=$1
  old_ifs=$IFS
  IFS=','
  # Splitting on IFS can also glob-expand entries containing *, ?, [ — turn
  # that off for the duration of the split.
  set -f
  # shellcheck disable=SC2086
  set -- $origin_list
  set +f
  IFS=$old_ifs
  for entry in "$@"; do
    trimmed=$(printf '%s' "$entry" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
    [ -z "$trimmed" ] && continue
    if ! printf '%s' "$trimmed" | grep -Eq '^https?://(localhost|127\.0\.0\.1)(:[0-9]+)?/?$'; then
      return 1
    fi
  done
  return 0
}

if localhost_only "${ALLOWED_ORIGIN:-}"; then
  echo "check-secrets: ALLOWED_ORIGIN is localhost-only — this is a laptop, skipping."
  exit 0
fi

# The exact literals .env.docker.example ships, character for character. A
# near match here (a trailing newline, a re-wrapped JWT) means this guard
# silently never fires, so these must be copy-pasted from that file, not
# retyped.
offenders=""
add_offender() {
  if [ -z "$offenders" ]; then
    offenders=$1
  else
    offenders="$offenders, $1"
  fi
}

[ "${JWT_SECRET:-}" = "your-super-secret-jwt-token-with-at-least-32-characters-long" ] &&
  add_offender JWT_SECRET
[ "${POSTGRES_PASSWORD:-}" = "covan-local-dev-password" ] &&
  add_offender POSTGRES_PASSWORD
[ "${SECRET_KEY_BASE:-}" = "UpNVntn3cDxHJpq99YMc1T1AQgQpc8kfYTuRgBiYa15BLrx8etQoXz3gZv1/u2oq" ] &&
  add_offender SECRET_KEY_BASE
[ "${ANON_KEY:-}" = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyAgCiAgICAicm9sZSI6ICJhbm9uIiwKICAgICJpc3MiOiAic3VwYWJhc2UtZGVtbyIsCiAgICAiaWF0IjogMTY0MTc2OTIwMCwKICAgICJleHAiOiAxNzk5NTM1NjAwCn0.dc_X5iR_VP_qT0zsiyj_I_OZ2T9FtRU2BBNWN8Bu4GE" ] &&
  add_offender ANON_KEY
[ "${SERVICE_ROLE_KEY:-}" = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyAgCiAgICAicm9sZSI6ICJzZXJ2aWNlX3JvbGUiLAogICAgImlzcyI6ICJzdXBhYmFzZS1kZW1vIiwKICAgICJpYXQiOiAxNjQxNzY5MjAwLAogICAgImV4cCI6IDE3OTk1MzU2MDAKfQ.DaYlNEoUrrEn2Ig7tqibS-PHK5vgusbcbo7X36XVt4Q" ] &&
  add_offender SERVICE_ROLE_KEY
[ "${ROUTINE_SECRET_KEY:-}" = "Y292YW4tbG9jYWwtZGV2LXJvdXRpbmUta2V5LTAwMDE=" ] &&
  add_offender ROUTINE_SECRET_KEY

if [ -n "$offenders" ]; then
  echo "check-secrets: refusing to start: $offenders still hold the values" >&2
  echo ".env.docker.example ships. That file is in a public repository, so" >&2
  echo "these are not secrets — see docs/self-hosting.md. Regenerate them," >&2
  echo "or set ALLOWED_ORIGIN to a localhost URL if this really is a local" >&2
  echo "stack." >&2
  exit 1
fi

echo "check-secrets: ALLOWED_ORIGIN is not localhost-only, and no published defaults remain — continuing."
