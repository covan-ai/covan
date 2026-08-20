# Security Policy

## Reporting a vulnerability

Please do not open a public issue.

Email **mahmutefedara@gmail.com** with a description, reproduction steps, and the
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

## Self-hosted instances

If you run your own instance, you are the operator. Keep `OPENAI_API_KEY`,
`SUPABASE_SERVICE_ROLE_KEY` and `ROUTINE_SECRET_KEY` out of version control and
off the client.
