## What problem does this solve?

<!--
  The problem, not the diff — the diff is below. If it fixes an issue, link it.
-->

## Checks

CI runs all of these on this pull request, and needs no secret to do it, so they
pass the same way on a fork. Running them first only saves you a round trip.

```bash
bun run lint && bun run typecheck && bun run check:rls && bun run test
cd worker && bun run typecheck && bun run test
```

- [ ] The commands above pass

## If you touched the database

- [ ] The change is a **new** migration in `supabase/migrations/`, not an edit to
      an applied one
- [ ] Every new table has `enable row level security` and a policy, and
      `bun run test:rls` passes against a real database
      ([how](../CONTRIBUTING.md#database-tests))

## If you touched `serviceClient()` or the service-role key

`worker/src/service-client.static.test.ts` pins who is allowed to reach past row
level security. If your change trips it:

- [ ] The new allowlist entry has the reason written next to it, and that reason
      is a place the database genuinely could not be the one deciding

## If you touched UI

- [ ] It follows [`DESIGN.md`](../DESIGN.md), which is the binding visual
      contract, not a suggestion

---

By opening this pull request you agree to the contributor license agreement in
[`CONTRIBUTING.md`](../CONTRIBUTING.md#contributor-license-agreement).
