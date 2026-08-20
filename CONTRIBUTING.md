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
bun run test
cd worker && bun run typecheck && bun run test
```

Keep pull requests focused on one change. Explain what problem it solves, not
only what it does.

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
