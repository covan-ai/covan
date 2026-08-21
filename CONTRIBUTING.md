# Contributing to Covan

Thanks for considering a contribution.

## Development setup

Covan has two halves: a TanStack Start frontend at the repo root and a Hono API
in `worker/`. There are two ways to get a working instance; pick one.

### Docker (fastest, no accounts needed)

```bash
cp .env.docker.example .env
# open .env and set OPENAI_API_KEY, then:
docker compose up
```

This builds both apps and the whole Supabase stack (Postgres, auth, REST,
realtime) in containers. Open <http://localhost:3000> when it settles.

### Local dev (needs a Supabase project)

Run the frontend with `bun run dev` and the API with `wrangler dev`, both
pointed at a real Supabase project instead of the Docker stack:

```bash
bun install
cd worker && bun install && cd ..

cp .env.example .env                              # frontend VITE_* vars
cp worker/.dev.vars.example worker/.dev.vars       # API secrets for `wrangler dev`
```

Fill in both files with your Supabase project's URL and keys.

See [`docs/self-hosting.md`](docs/self-hosting.md) for what each variable does
and for the production deployment path.

## Before opening a pull request

```bash
bun run lint
bun run typecheck
bun run check:rls
bun run test
cd worker && bun run typecheck && bun run test
```

Every one of these also runs on your pull request in GitHub Actions
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)), along with the
database tests below. Nothing in CI needs a secret, so the checks run the same
way on a fork as they do here.

Keep pull requests focused on one change. Explain what problem it solves, not
only what it does.

## Database tests

Tenant isolation in Covan is enforced by Postgres Row Level Security, not by
application code — a route hands the caller's token to Supabase and the policies
in `supabase/migrations` decide what comes back. No amount of TypeScript checks
that, so `tests/rls/` drives a real database with real users and real tokens.

**If you add or change a migration, run these.** In particular, a new table
without `enable row level security` will fail `tests/rls/structure.test.ts` — by
design. `bun run check:rls` catches the same thing in a second and without a
database, which is why CI runs it first; the suite is what proves the policies
you wrote actually behave.

They need a database, so they are not part of `bun run test`. With the Docker
stack from above running, point the suite at it — this is the same path CI
takes:

```bash
set -a && . ./.env && set +a
SUPABASE_TEST_URL="http://localhost:${KONG_HTTP_PORT:-8000}" \
SUPABASE_TEST_ANON_KEY="$ANON_KEY" \
SUPABASE_TEST_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
SUPABASE_TEST_DB_URL="postgresql://postgres:${POSTGRES_PASSWORD}@localhost:${POSTGRES_PORT:-54322}/postgres" \
bun run test:rls
```

If you would rather use the Supabase CLI, `supabase start` works too and needs
no variables at all — the suite reads `supabase status` when they are unset.
Note that the CLI and `docker compose` both want port 54322, so only one of them
can be running.

```bash
supabase start
bun run test:rls
```

The suite creates its own users, and deletes them and everything they own when
it finishes.

### The bypass is pinned

All of the above proves the policies do their job. It cannot notice a route that
stops asking them to. `serviceClient()` skips RLS entirely — that is what it is
for — so a handler that switches to it keeps working and stops being scoped to
the caller, silently.

`worker/src/service-client.static.test.ts` therefore pins the files allowed to
reach it, and separately the files allowed to name the service-role key, since
naming the key is enough to build your own client. Adding a call site is fine;
adding one silently is not. If your change trips it, the fix is an entry **with
the reason written next to it** — the list is meant to shrink over time, and
every entry should be a place the database genuinely could not be the one
deciding.

## Contributor License Agreement

Covan is licensed under AGPL-3.0. By submitting a contribution you confirm that
you have the right to submit it, and you grant the project maintainer:

- a perpetual, worldwide, non-exclusive, royalty-free, irrevocable **copyright**
  license to use, reproduce, modify, publish, sublicense and distribute your
  contribution as part of Covan, under AGPL-3.0 or under any other license; and
- a perpetual, worldwide, non-exclusive, royalty-free, irrevocable **patent**
  license, under any patent claims you own or control that your contribution
  necessarily infringes, to make, use, sell, offer to sell, import and otherwise
  transfer Covan.

These rights are transferable, so they survive the project moving to a company
or other legal entity.

This lets the project change its license later — for example to something more
permissive — without tracking down every past contributor. If you cannot agree
to this, say so in the pull request and we will discuss it.

## Security

Do not open a public issue for a vulnerability. See
[`SECURITY.md`](SECURITY.md).
