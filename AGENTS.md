# Working in this repository

Guidance for coding agents and for humans who want the short version.

## Shape

- Repo root — TanStack Start frontend (React 19, Vite, Tailwind v4, shadcn/ui).
  Routes are file-based in `src/routes/`; `_authed.*` requires a session.
- `worker/` — Hono API. Runs on Cloudflare Workers in production and on Node
  in the Docker stack. One source, two entry points.
- `supabase/migrations/` — numbered SQL, applied in order. Never edit an
  applied migration; add a new one.

## Rules that matter

- **`DESIGN.md` is binding.** It is the visual contract for all new UI. Read it
  before touching a component.
- **Authorization lives in Postgres.** RLS policies are the security boundary,
  not the API layer. A route that reaches for the service-role client to "make
  it work" is almost always a bug.
- **Both runtimes must keep working.** Anything Cloudflare-specific goes behind
  the interfaces in `worker/src/lib/docstore/` and `worker/src/lib/defer.ts`.
  Do not reach for `env.DOCS` or `c.executionCtx` in a route.
- **Never commit** real `wrangler.toml`, `.env`, `.dev.vars`, account IDs, or
  keys.
- **No real person's data in the repository.** Not in code comments, tests,
  fixtures, eval cases or commit messages: no customer or workspace names, email
  addresses, message text, subjects, document contents or ids copied from a
  production row. Production evidence goes in as numbers and shapes ("30
  messages asked for, the headers of one returned") or as invented stand-ins
  (`ada@acme.test`). Eval cases built from a pilot's real data live in the
  private hosted repository, never in `worker/eval/`.

## Commands

```bash
bun run dev            # frontend
bun run test           # frontend tests
bun run lint

cd worker
bun run dev            # wrangler dev
bun run test
bun run typecheck
bun run dry            # wrangler deploy --dry-run
```
