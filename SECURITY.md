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

One thing in the policies looks like a finding and is a documented limitation,
so you can save yourself the write-up: the owner branch of the select policy on
`chat_sessions` tests `user_id = auth.uid()` with no membership condition beside
it. A person removed from a workspace therefore keeps their own sessions from
it — the list stops showing them, but somebody holding a session id can still
read the transcript back. They cannot get new answers; the reply path loads the
agent first and that read is membership-gated.

[What removal leaves behind](docs/team.md#what-removal-leaves-behind) covers
this and the rest of what outlives a membership. It is a product decision that
has not been made yet, not an oversight — reports are still welcome if you find
a consequence of it we have not written down, and especially if you find a way
to reach anything that was _not_ already theirs.

## Self-hosted instances

If you run your own instance, you are the operator. Keep `OPENAI_API_KEY`,
`SUPABASE_SERVICE_ROLE_KEY` and `ROUTINE_SECRET_KEY` out of version control and
off the client.
