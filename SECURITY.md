# Security Policy

## Reporting a vulnerability

Please do not open a public issue.

Email **efe@covan.app** with a description, reproduction steps, and the
impact you believe it has. You should get an acknowledgement within 72 hours.

## Scope

Covan stores every tenant's data in Postgres and relies on Supabase Row Level
Security for isolation: the API holds a request-scoped client carrying the
caller's bearer token, so `auth.uid()` resolves to the authenticated user.

Findings that let one workspace read or write another workspace's data are the
highest severity and will be treated as such.

The service-role key bypasses RLS entirely. It is used only by the worker for
operations that legitimately cross users, and it must never be exposed to a
browser. Any path that leaks it is critical.

## Already known

This section used to describe a real weakness: the owner branch of the select
policy on `chat_sessions` tested `user_id = auth.uid()` with no membership
condition beside it, so a person removed from a workspace kept their own
transcripts from it and could read one back by id.

**That is closed.** `0031_access_follows_membership.sql` rewrote eleven policies
across `chat_sessions`, `messages` and `ideas` so membership is checked
unconditionally and ownership only decides which member sees the row. A
conversation in a workspace somebody has left is now refused however they come
at it — the list, a bookmarked id, an open tab, or a request straight to
PostgREST. `tests/rls/membership.test.ts` asserts it in both directions.

One thing on the same shape deliberately remains, so you can save yourself the
write-up: `routines_select_visible` keeps the plain owner branch. A departed
member can still read their own routine rows. That is the point — the executor
re-checks membership before every run and pauses the routine with a recorded
reason, and that reason is the only explanation its owner will ever get. The row
holds their own instruction; `routine_runs` records counts and status, never
content.

[What removal leaves behind](docs/team.md#what-removal-leaves-behind) covers the
rest of what outlives a membership, and [Security](docs/security.md) is the
whole model in one page. Reports are welcome for anything that reaches something
which was _not_ already the reporter's.

## Self-hosted instances

If you run your own instance, you are the operator. Keep `OPENAI_API_KEY`,
`SUPABASE_SERVICE_ROLE_KEY` and `ROUTINE_SECRET_KEY` out of version control and
off the client.
