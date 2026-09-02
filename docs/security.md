# Security

Two people arrive at this page. One is deciding whether to put their team's
documents into covan.app. The other is about to run Covan on their own machines
and wants to know what they are taking responsibility for.

Most of what follows is the same answer for both, because it is a property of
the software rather than of who is hosting it. Where the two diverge it says so.

The short version: **authorization lives in Postgres, not in the API.** Almost
every other decision here follows from that one.

## Where authorization lives

A request arrives with the caller's token. The API does not unpack it, decide
what that person may see, and write a filter — it hands the token to Postgres
and asks for the rows. Row level security policies on every table decide what
comes back, and they gate on `auth.uid()`, which is the authenticated user as
the _database_ understands them.

The consequence worth understanding is what it does to mistakes. A route that
forgets to scope a query by workspace is an ordinary bug in most systems and a
data leak in all of them. Here it is only the first of those: the query returns
nothing extra, because the filter that mattered was never in the route.

[Architecture](architecture.md#authorization-is-postgres) has the long form,
including where the two seams are and why they are where they are.

## Three guards, deliberately overlapping

Tenancy is the one thing that must not break quietly, so it is checked three
different ways and no two of them share a failure mode.

- **Every table is covered.** A dependency-free script walks the migrations
  before anything is installed and fails if a `create table` in `public` is not
  followed by `enable row level security`. It takes about a second and it
  catches the mistake that would otherwise be invisible: a new table that nobody
  remembered to protect.
- **The policies are tested against a real database.** Not read, not
  regex-matched — a Postgres, GoTrue and PostgREST stack comes up in CI,
  migrations are applied, real users sign up and get real tokens, and the tests
  try to reach each other's rows. A `using (...)` predicate is a program, and
  the only honest way to test a program is to run it.
- **The key that bypasses all of it is pinned to a list.** A static test names
  the files allowed to call for a service-role client, and fails the build if any
  other file does. The list is meant to shrink over time, never to grow
  casually.

## The service-role key

One credential bypasses row level security entirely, and it exists because a few
operations legitimately cross users: minting a short-lived token for an API key,
the routine engine waking up when nobody is signed in, cleaning up storage when
an account is closed.

It lives only in the API's runtime. It is never sent to a browser, never
embedded in the client bundle, and every file that touches it is on the
allowlist above. **If you are self-hosting, this is the one secret whose leak is
unrecoverable** — anybody holding it can read every row of every workspace.

## Who can do what

Three roles, and they answer two different questions.

| Role | Their own things | The workspace's things |
| ------ | ----------------- | ----------------------- |
| Admin | Read and write | Read and write, plus invite, remove and change roles |
| Member | Read and write | Read and write |
| Viewer | Read and write | Read only |

The rule underneath it: **shared things need a member, your own things need only
membership.** A viewer still has their own sessions, their own messages, their
own ideas and their own routines, and can chat with every agent in the
workspace — what they cannot do is change something everybody else depends on.

That distinction is one database function, named by all thirteen write policies
on the five shared tables, rather than thirteen copies of the same predicate.
Copies are how one of them ends up different.

## What a conversation is

A session is private to the person who opened it. Not private by convention or
by a check in the API — private because the policy says so, which is why a
colleague cannot read it by guessing a URL.

Sharing one makes it readable by the workspace, and that is the only way it
becomes readable. There is no administrator view of everybody's chats.

Access follows membership. When somebody leaves a workspace, or is removed from
it, their sessions in that workspace stop being reachable — from the list, from
a bookmarked id, from an open tab, from a request made straight to the database.
Nothing is destroyed, and re-inviting them brings all of it back.

That behaviour is newer than the product and it was a deliberate decision rather
than a bug fix. [What removal leaves behind](team.md#what-removal-leaves-behind)
covers the whole of it, including the two things that survive on purpose.

## API keys

A key is not a second permission system. It looks the key up, mints a
sixty-second token for the person who owns it, and makes the request as them —
so every policy that applies to you applies to your script, and a viewer's key
can read and not write because a viewer can read and not write.

Three things a key cannot do, each by explicit refusal: create another key,
revoke a key, or close the account. All three exist so that a leaked key cannot
entrench itself, cannot lock you out of revoking it, and cannot destroy the
account and the evidence in one call.

A key belongs to a person, not to a workspace. When their access ends, their
keys stop working at the same moment. [The API](api.md) has the rest.

## Secrets, and what happens when they are wrong

An operator holds four things that matter: the Supabase service-role key, the
OpenAI key, the key that encrypts delivery-channel secrets, and the database
password.

Delivery-channel secrets — a Slack webhook URL, for instance — are encrypted
with AES-GCM before they are stored, using a key held only by the API. The
database on its own does not yield them.

The Node build refuses to start rather than run in a state that looks fine and
is not:

- Any required variable missing, and it says all of them at once rather than one
  per restart.
- The published example values still in place while the app is served anywhere
  other than localhost. Those values are in a public repository and they _work_,
  which is the dangerous part — a demo key that verifies is worse than one that
  does not.
- An encryption key that is not base64 of 16, 24 or 32 bytes, checked at boot
  instead of at the moment somebody first saves a webhook.

The Worker build takes its configuration from the platform and runs none of
these checks, because a deployment cannot start failing on a secret it has held
all along.

## In transit and at rest

TLS everywhere, in and out. Uploaded files and the database are encrypted at
rest by whoever provides them — which is your choice when you self-host, and is
[named for covan.app on the subprocessor page](https://covan.app/subprocessors).

Passwords are never stored. Authentication is Supabase Auth, and what the
database holds is a hash.

## Rate limits and the ceiling above them

Every endpoint that spends money — a completion, a transcription — is rate
limited per account rather than per address, because after authentication there
is an account, and a per-address limit punishes a shared office for one person's
runaway loop.

Above the per-minute limit sits the monthly allowance, and the two are not
substitutes: an allowance bounds the bill, a rate limit bounds how fast it is
reached. A self-hosted install ships no allowance at all, which is correct — it
is your OpenAI key and your ceiling to set.

## What Covan does not have

Stated here rather than left to be discovered, because for some readers one of
these is the end of the evaluation.

- **No single sign-on.** No SAML, no OIDC, no SCIM provisioning. Accounts are
  email and password.
- **No audit log.** There is no per-action trail an administrator can export.
- **No certification.** covan.app has no SOC 2 and no ISO 27001, and no external
  party has audited any of the above. What is offered instead is that the code
  is published and the claims on this page can be checked rather than believed.
- **No two-factor authentication** on Covan accounts today.

## Reporting a vulnerability

Privately, to the address in the repository's
[security policy](https://github.com/covan-ai/covan/security/policy), never as a
public issue. You get an acknowledgement within seventy-two hours.

Findings that let one workspace read or write another workspace's data are the
highest severity there is and are treated that way. Nothing bad happens to
anybody who reports in good faith.

## If you run it yourself

You are the operator, which means the parts above about "who is responsible" all
resolve to you. The short list:

1. **Keep the service-role key off the client.** It belongs in the API's
   environment and nowhere else. Nothing named `VITE_` is a secret — those are
   compiled into the bundle every visitor downloads.
2. **Regenerate every example value** before the stack is reachable from
   anything but your own machine. The boot check catches this, and it is better
   not to rely on it.
3. **Set `ALLOWED_ORIGIN` to your own origin.** It is what stops another site
   from making authenticated requests on a visitor's behalf.
4. **Back up the database, and restore one.** A dump nobody has restored is a
   file, not a backup. covan.app's own job restores every nightly dump into a
   throwaway Postgres and compares row counts before keeping it — worth copying.
5. **Keep the encryption key.** Lose the one that encrypts delivery-channel
   secrets and every stored webhook becomes undecryptable noise.
6. **Decide where the model calls go.** Completions and embeddings can each be
   pointed at any OpenAI-compatible endpoint, independently — which is the whole
   answer for anyone who cannot send document text to the United States. See
   [Self-hosting](self-hosting.md).

[Taking it with you](export.md) is the other half of this page: the security
property that matters most in the long run is being able to leave with
everything, and that is a feature rather than a promise.
