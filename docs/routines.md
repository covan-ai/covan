# Routines

A routine is the one part of Covan that acts with nobody present. It wakes on a
schedule, reads a source, asks an agent to do something with what it found, and
sends the result to Slack or to an email address.
[Core concepts](concepts.md#routine) defines the noun and says who can see one;
this page is about the behaviour, because work that runs unattended is judged on
different questions: what it can reach, what it does when it fails, and what
happens to the webhook URL you hand it.

The engine's internals are in [Routines](architecture.md#routines). This page
overlaps it deliberately wherever the mechanism changes what you would do.

## Setting one up

The dialog opens on a text box rather than a form. What you type there goes to
the model once, and comes back as a definition — a name, a source kind and URL,
a cron expression, an instruction, and which kind of channel to use. Nothing is
saved at that point: the second step is the same definition as editable fields,
and you confirm it before anything is written. "Set it up myself" skips the
model entirely.

The draft never proposes a connected source, and cannot: it would have to name a
connection by id, and the model has no way to know one. Pick that kind on the
second step, where the connections your workspace has are a list you choose
from.

The draft is validated against the same guards the engine runs on — the cron
parser and the URL guard — so a routine the engine could never execute is
refused while you are still looking at it. If the model cannot read the request
at all, the dialog does not trap you retrying prose; it says so and moves you to
the form.

That one call is the only time a model reasons about the routine's _shape_.
Everything the engine does afterwards is deterministic: the model summarises,
and it never decides what to fetch or when to run. This is why "why did my
routine behave differently today?" is not a question anyone has to answer.

## What it can read

Four source kinds, and the difference between them is what counts as new.

| Source           | What a run does                                                          |
| ---------------- | ------------------------------------------------------------------------ |
| RSS / Atom feed  | Fetches and parses it, and reports the entries it has not seen           |
| Web page         | Fetches it and hashes the body, and reports only when the hash moved     |
| Connected source | Fetches nothing — it reports the documents a connection has synced since |
| Scheduled prompt | Fetches nothing — it runs the instruction on the schedule                |

For the two that fetch, the request carries `If-None-Match` when a previous run
stored an ETag. A `304` ends the run immediately: no parse, no model call, and a
`skipped` row in the history. Most ticks on a healthy feed take that exit. The
fetch reads at most 2 MB, times out after ten seconds, follows at most three
redirects, and identifies itself as `covan-routines/1.0`.

**The first run of a feed or page watcher sends nothing on purpose.** With no
cursor there is nothing to compare against, so the run records what is already
there — the entry keys, or the page's hash — and stops. Without that rule the
first tick would post the whole backlog of a feed into somebody's Slack. The
create dialog says so under the form, and a scheduled prompt is the exception:
having nothing to diff, it runs the first time and every time.

New feed entries are recognised by identity, not by date: an Atom `<id>`, an RSS
`<guid>`, and the link when a feed offers neither. Feeds are not reliably
ordered and entries get edited and republished, so a date-based cursor would
both miss things and repeat them.

One consequence is worth knowing before you point a routine at a busy feed. A
run delivers at most ten new entries, but it marks _everything it saw_ as seen,
including the entries the cap declined. So a feed that produces forty new posts
between two runs reports ten, and the other thirty are never delivered rather
than arriving piecemeal later. Poll a busy source often enough that a run rarely
finds more than ten.

When that happens the run says so, in both places you might look. The delivered
message ends with a line naming how many entries were left out, and the run's
row in the history reads "10 new items · 30 skipped". Neither is decoration: a
message reporting ten of forty looks exactly like a message reporting all ten
there were, and the number is not recoverable afterwards — by the time anyone
asks, the seen window has moved past them.

Nothing from the source is stored. The cursor holds fingerprints — seen keys, an
ETag, a content hash — so a feed your workspace watches is never mirrored into
the database. A connected source is the exception that proves it: those
documents are in the database already, put there by the sync, and the routine
reads them rather than copying anything.

### Watching a connected source

A [connection](integrations.md) already re-reads a Notion workspace or a Drive
folder on a schedule and files what it finds in a bundle. A routine of this kind
watches that bundle and reports the documents added or changed since its last
run — so "tell me what changed in the handbook" is a routine, not a thing you
have to remember to check.

It fetches nothing itself. The reconciler has already done the reading, the
version comparison and the removals, and a routine that went to Notion directly
would be a second place deciding what "changed" means, with its own answer to
get subtly differently wrong. So this reads `documents`, and identity is the
document _and its version_: a page edited at the source arrives under a key the
cursor has not seen and is reported again, while a page nobody has touched is
not.

**The routine cannot see a change sooner than the sync does.** A connection
syncs every `sync_interval_minutes` — six hours by default — so an hourly
routine on a six-hourly connection is an hourly routine that finds something
roughly every six hours. The create dialog says this against the connection you
picked, in its own interval rather than as a general claim about six hours.

Two more things follow from reading the bundle rather than the provider. A
document the sync withdrew is not reported, because it has already stopped
grounding answers everywhere else and announcing it as new here would contradict
that — which also means a routine reports additions and edits but never
removals. And a run reads at most 200 documents, newest sync first; a connection
whose sync changes more than that between two routine runs loses the oldest of
them, reported the same way as a feed's overflow.

The source is picked from the connections your workspace already has, and the
setup dialog offers this kind only when there is at least one. A routine may
only name a connection in its own workspace, enforced by the insert and update
policies on the table rather than by the API — the scheduled executor holds a
service-role client, so without that guard a crafted write could have pointed a
routine here at another workspace's Notion and had the engine mail its contents
out.

### What the URL guard refuses

Both the setup path and the execution path call the same guard, so a URL that
would be rejected at run time cannot be accepted at setup, which is the worse
place to find out. It refuses loopback, RFC1918, link-local and IPv4-mapped-IPv6
addresses, any `workers.dev` host, and the deployment's own hosts — the entries
in `ALLOWED_ORIGIN`, plus `WORKER_HOST` once a custom domain fronts the Worker —
so a routine cannot be pointed back at Covan itself.

Redirects are followed manually rather than by the fetch layer, and every hop is
checked again, because with automatic following a single `302` bypasses all of
the above.

The guard is explicit about its limit: it cannot resolve DNS, so a hostname that
resolves to a private address still passes.

## What it does with what it finds

One model call per run, not one per item. It is cheaper, and it means the
routine sends one message instead of eight. The call uses the agent's own
persona and its own model, with one line added saying it is running a scheduled
routine for the team — a routine is the same colleague, reporting rather than
answering. Your instruction is the user message, with the new entries or the
watched page's text beneath it.

That call also decides whether to send at all — see
[Nothing relevant](#nothing-relevant).

The agent also gets what it knows. Before the call, the run retrieves against
the agent's documents exactly as a chat turn does, and the excerpts ride in
their own system message ahead of your instruction. Without that the claim above
was only half true: the same agent could quote the handbook when somebody asked
it a question and had forgotten it by the time it wrote the Monday digest, so a
routine watching a competitor could report what happened and never what it meant
for this company.

A routine has no question, which is what makes the query different from a chat
turn's. It is built from your instruction _and_ what this particular run found —
the entry titles, or the first 500 characters of a watched page. The instruction
alone would return the same passages every run whatever came in; the arrivals
alone would lose the reason the routine exists.

Retrieval happens after the run has established it has something to report, so
a tick that will send nothing does not pay to embed a query — which on a healthy
feed is most ticks. It is best-effort: an agent with no documents, a retrieval
that finds nothing above the similarity floor and a retrieval that fails all
produce the same thing, which is the prompt as it was before this existed. The
embedding tokens are charged to the routine's owner with the completion's, in
one write.

Two truncations apply on the way in: a watched page contributes its first 20,000
characters, and each feed entry contributes 1,000 characters of its own summary
alongside its title and link.

The generated summary is stored on the run that sent it, so "what did it send me
last Tuesday?" has an answer inside the product rather than only in a mailbox
somebody may have cleared. This is the agent's own text, already delivered — not
a copy of the source.

### When the agent can go and look

Everything above describes a run that is handed its material and writes about
it. A workspace with a **connected service** (see
[Integrations](integrations.md#services-an-agent-can-call)) changes that: the
run goes through the same agent loop a chat turn does, so the agent can query
the database or call the API itself while it works.

The important part of that sentence is _the same loop_. There are not two ways
a job runs. A thing you set up in a conversation and then scheduled behaves the
same way at 3am as it did when you watched it, because it is the same code —
and the alternative, two execution paths, produces the one bug nobody can
debug.

What it changes for you:

- **The routine holds the clock, not the data.** Its source stays `none`.
  Nothing is fetched before the model is called; the agent fetches, using the
  tools, having read your instruction. Which is why adding a second service
  later changes nothing about the routine.
- **Write the instruction to be read cold.** The run has your instruction and
  the agent's documents, and none of the conversation the job came out of. Name
  the service and say what to report.
- **Nothing that needs approval happens.** A tool that would ask a person —
  sending to a channel, creating another routine — is recorded as wanted and
  not done, and the delivered message says so at the bottom. A tick has nobody
  to ask and nowhere to wait.
- **The decision to stay quiet costs one extra call.** A run that may decline
  (see [Nothing relevant](#nothing-relevant)) asks the question as a separate
  short turn afterwards, because a request that demands JSON _and_ offers tools
  puts the model in two minds and gets neither.

A workspace with no connected service runs exactly as it always did: one call,
no loop, nothing extra to pay for. The tick asks once, for the whole batch,
whether any of the workspaces it claimed has a service connected — so knowing
the answer costs one database read per tick rather than one per routine.

### It may not fit on Cloudflare Free

This is a real limit and worth checking before you rely on it. A tick on
Workers Free gets **50 subrequests**, and the batch size is sized against
that: two for the tick itself — the claim, and the one read above — and up to
twelve per routine, so three routines comes to 38. An agent turn spends more
than twelve on its own, because each tool call is at least one request and the
model is called again after each.

So for routines that use tools, on Workers Free, either:

- run the scheduler on the **Node/Docker** stack, where there is no subrequest
  limit (see [self-hosting](self-hosting.md)); or
- move to **Workers Paid**, where the limit is 10,000 and CPU time becomes the
  binding constraint instead.

Left as it is, a tick that runs out of subrequests fails the routines it was
part way through, which is recorded as a run failure and eventually pauses
them. That is a bad way to find out, which is why it is written here.

## Delivery

A delivery channel is created in Settings, not on the routine, and routines pick
from the channels you already have. There are three kinds: a Slack incoming
webhook, which must be on `hooks.slack.com`; an email address; and a **webhook**,
which is a signed POST to any endpoint you run.

Slack delivery posts JSON to the webhook with the routine's name in bold above
the summary. Email goes through [Resend](https://resend.com), with the routine's
name as the subject and the summary as plain text. The webhook kind is
documented in full below — it is the one a program rather than a person reads.

Every kind has a **Send test** button on its row in Settings. It sends one
message through the channel immediately and reports what the receiver said,
including the receiver's own error text when it refuses. "Did I paste that URL
correctly" had no answer before it except waiting for a routine to run.

A channel belongs to the person who created it rather than to the workspace, and
a routine may only point at a channel belonging to its own owner. That is
enforced by the insert and update policies on the table, not by the API. So
sharing a routine with the workspace shares what it does and what it sent, never
where it goes: a teammate looking at a shared routine sees "The owner's channel"
where the owner sees the label.

Deleting a channel that a routine still points at fails with a conflict, and the
interface names the reason rather than showing the database's version of it.

Because the channel is the person's, it outlives the workspace it was added
from. The row records which workspace you were in when you created it, and
nothing reads that afterwards — so when a workspace is deleted, channels added
from it are kept and that record is simply cleared. Before `0019` they were
deleted along with it, which meant a routine in one workspace could make a
different workspace permanently undeletable: the workspace's own admins could
neither see the routine holding it open nor do anything about it. Deleting the
_person_ still takes their channels with them.

Email delivery needs `RESEND_API_KEY` and `RESEND_FROM` set on the deployment;
both are optional, and without them email delivery is unavailable. Pressing **Run
now** on an email routine in that state answers with a readable error instead of
running. A scheduled run has nobody to tell, so it fails and records whatever
Resend said.

### The webhook kind

A webhook channel POSTs one JSON body per delivery to a URL you choose. Nothing
about it is specific to a vendor: the point is that a routine's output becomes
an input somewhere else — a deploy, a ticket, a queue, a row in your own
database — without Covan having to ship a connector per destination.

The URL gets the same guard as every other outbound fetch in this codebase, and
gets it twice: once when the channel is saved and again immediately before each
delivery. A hostname that resolved to a public address in March can resolve to
`169.254.169.254` in September, and the check that catches that is the one at
delivery time. Private addresses, non-HTTP schemes, and this deployment's own
hosts are all refused.

**The payload.** `version` is the contract; it is bumped only for a change a
receiver has to notice.

```json
{
  "version": 1,
  "event": "routine.delivered",
  "deliveryId": "6f1e…",
  "sentAt": "2026-09-20T09:00:00.000Z",
  "routine": { "id": "…", "name": "Weekly digest", "agentId": "…" },
  "run": { "itemsNew": 3, "itemsOverflow": 0, "triggeredBy": "schedule" },
  "subject": "Weekly digest",
  "body": "…the summary the agent wrote…"
}
```

`event` is what to switch on, and there are four: `routine.delivered` is a
result; `routine.paused` and `routine.quota_exhausted` are the engine's own
notices, which go through the routine's channel the same way they go to a
person; `routine.test` is the Send test button. A `routine.test` carries no
`routine` and no `run`, because no routine sent it.

There is no `run.id`, deliberately. The POST happens before the run row is
written, so at that moment there is no id to send, and inventing one that the
row later disagrees with would be worse than leaving it out. What a receiver
needs for deduplication is `deliveryId`, which is unique per POST — including
per retry of a POST that failed after you had already processed it.

**The headers.**

| Header              | Value                                                  |
| ------------------- | ------------------------------------------------------ |
| `X-Covan-Event`     | the same string as `event` in the body                 |
| `X-Covan-Delivery`  | the same string as `deliveryId` — your idempotency key |
| `X-Covan-Timestamp` | seconds since the epoch, as a decimal string           |
| `X-Covan-Signature` | `v1=<hex>`                                             |

**The signature.** HMAC-SHA256 over `v1:<timestamp>:<raw body>`, keyed by the
signing secret, hex-encoded. This is byte-for-byte Slack's scheme with a
different version string, which is the point: any snippet that verifies a Slack
request works here with two names changed. Verify over the **raw** bytes you
received — re-serialising the parsed JSON produces a different string and a
signature that will never match. Compare in constant time, and reject a
timestamp that is too old, or one captured request replays forever.

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(rawBody, headers, signingSecret) {
  const timestamp = headers["x-covan-timestamp"];
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const expected = `v1=${createHmac("sha256", signingSecret)
    .update(`v1:${timestamp}:${rawBody}`, "utf8")
    .digest("hex")}`;
  const got = headers["x-covan-signature"] ?? "";
  return expected.length === got.length && timingSafeEqual(Buffer.from(expected), Buffer.from(got));
}
```

**What we do with your answer.** Any 2xx is a delivery. Every 3xx is refused
rather than followed: a POST is not idempotent, so a redirect either replays a
signed body at a host the signature does not name or drops the body and sends a
GET, and neither is a delivery — re-point the channel instead. A 4xx is treated
as a statement about the channel and counts toward the pause threshold. A 429 or
a 5xx is treated as a statement about your afternoon and counts toward a much
higher one; see [When a run fails](#when-a-run-fails). Your response body is read to at most 64 KB
and the first 200 characters of it are kept on the run, so your error text is
what somebody sees on the routine's page. You have ten seconds to answer.

**The signing secret** is shown once, when the channel is created. It is stored
encrypted rather than hashed — signing needs the secret back, not a digest of it
— but no endpoint reads it out again, so a screenshot of the settings page is
not a copy of it. Lost it, or want to retire it? **Rotate** mints a new one and
shows it once; the destination URL is unchanged and the old secret stops working
immediately, so update your receiver in the same sitting.

### The secret you hand it

A webhook URL and an email address are both secrets, and all three kinds are
encrypted with AES-GCM before they reach Postgres, as `v1.<iv>.<ciphertext>` — the version
prefix is what makes a later key rotation readable rather than a wave of decrypt
failures. The key is `ROUTINE_SECRET_KEY`, held as a deployment secret and never
in the database. Encrypting is also why creating a channel is a server-side
write: `INSERT` on `delivery_channels` is granted to nobody but the service role,
because the secret has to be encrypted before the row exists.

The secret does not come back out. Row level security is row-level and cannot
hide a column, so `delivery_channels` has the blanket `authenticated` grant
revoked and every column except the ciphertext handed back. What the interface
shows is a mask computed once at creation — a webhook reduced to its host and its
last four characters, an address to a letter or two of its local part and the
domain.

A `webhook` channel stores two things rather than one, as a single JSON object
inside that same ciphertext: `{"v":1,"url":…,"signingSecret":…}`. They share the
column so `secret_ciphertext` stays the one column on the table that carries a
secret, which is what makes the column grant the whole answer to what a client
may read. The signing secret is minted per channel rather than derived from
`ROUTINE_SECRET_KEY`: that key also opens every other channel and every OAuth
token behind a connection, so a receiver's leaked copy of a derived secret would
force all of them to be rotated at once. One channel's secret rotates alone.

## Being poked instead

A routine normally runs on its cron. One with **no source of its own** can also
be given a URL that starts it:

```
POST https://api.example.com/routine-hooks/covan_whk_<token>
```

Paste it into GitHub's webhook box, a Stripe endpoint, a Zapier step, a CI job,
or a `curl` in somebody's deploy script. Whatever is POSTed becomes the material
the agent reads, in place of a feed or a page. The URL shape is the feature —
it has to be one string, because most of the things that will be calling it
cannot be taught to set a header. For the ones that can,
`X-Covan-Ingest-Token` is accepted and wins over the path, so the credential
need not end up in an access log.

**Only a routine with no source.** "The routine watches an RSS feed and
somebody poked it — does it re-fetch?" has no good answer: if it does, a busy
sender charges the owner for a feed read per request and moves a cursor on a
schedule nobody chose; if it does not, the same routine behaves differently
depending on what started it. So the pairing is refused by a check constraint
at creation rather than resolved at 3am. A routine's source can never change
after it is made (`0027`), so this is settled once, when you create it — an
existing feed-watching routine cannot acquire a webhook, and the honest answer
is to make a new one.

A routine can run on **both**: a digest every morning that can also be poked
after a deploy.

### The token

32 random bytes, `covan_whk_` prefixed, shown exactly once when you make it.
The database keeps a SHA-256, so nobody — including the operator — can show it
again; if it is lost, replace it, which invalidates the old one immediately.

The prefix is deliberately not `covan_sk_`: an API key is a way to _become_ a
person, and this is permission to fire one row. The two should not be
confusable by a secret scanner, by `authMiddleware`, or by whoever finds one.

Its hash lives in a table of its own rather than as a column on `routines`,
and that is security rather than filing. `routines` grants `authenticated` a
table-level select **and** update with no column list, and a shared routine is
visible to the whole workspace — so a hash stored there would be readable by
every colleague, and writable by anyone who owns any routine. The second is the
serious one: writing your own routine's hash to equal a colleague's would
redirect their sender's payload to a routine with your instruction and your
delivery channel. `routine_triggers.token_hash` is granted to no client role at
all, the table is unique on it, and `tests/rls/routine-triggers.test.ts` holds
both.

**Who can see it:** the routine's owner, and nobody else — narrower than the
routine's own visibility on purpose. Sharing a routine shares what it does and
what it sent, not the ability to fire it.

### What you get back

| Status | Means                                                                                                                                                                                |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `202`  | Accepted. The run happens after the response; the body carries the `eventId` it was filed under.                                                                                     |
| `401`  | The token is missing, malformed, unknown, or belongs to a routine that has been deleted — one answer for all of them, so the endpoint cannot be used to discover which tokens exist. |
| `409`  | The token is good, but the routine is paused or no longer accepts webhook triggers. You are told which, because you hold the token and can act on it.                                |
| `413`  | The body is over 64 KB. The stream is cancelled rather than read and measured.                                                                                                       |
| `429`  | Too many pokes for this routine this minute. `Retry-After` says how long.                                                                                                            |

`202` rather than waiting: a run reads documents, calls a model and delivers,
which takes tens of seconds, and every webhook sender worth using times out
long before that and retries — which is how one poke becomes four.

The limit is counted **per routine**, not per address. An address is the wrong
key in both directions: one sender behind one address is what a webhook is, and
several routines sharing that address would be counted as one caller, while
many senders behind one NAT would be too. The routine is the thing being
protected, because it is the row that spends its owner's allowance.

### Sending the same thing twice

Give us your own id for the event and a repeat costs nothing. Read from
`X-Covan-Event-Id`, then `Idempotency-Key`, then `X-GitHub-Delivery`, in that
order. The id becomes the run's delivery claim, so a second delivery of one
event collides on the same unique constraint that stops a retried scheduled run
from double-sending — and because the claim is taken before the model is
called, the repeat costs no tokens.

A repeat is recorded as a **skipped run you can see** on the routine's page,
not a silent 200. A webhook that quietly did nothing is indistinguishable from
one that is broken.

With no id from the sender, there is nothing to deduplicate on and nothing
pretends otherwise: the run happens. Hashing the body instead would be worse
than useless — two genuine "the deploy finished" events are byte-identical and
would silently become one.

### What happens to the payload

It is given to the agent and **stored nowhere**. `0013`'s rule — a watched
source is never mirrored into this database — holds for a payload that arrived
by POST as much as for one that was fetched, and a test holds it. What is kept
is the summary the agent wrote, on the run, exactly as for every other kind.
The only thing an incoming request writes is a clock reading: `last_used_at`,
so the interface can answer "is this actually wired up".

### What it cannot do, and what it can

The run happens as the routine's owner — not by impersonation but by
construction. The engine never resolves a caller: every id it uses comes off
the routine row, and it re-checks the owner's workspace membership before doing
anything. The owner's allowance is charged exactly as for a scheduled run.

No session is minted for the owner, deliberately. It would not work — the four
tables the engine writes have no policy for `authenticated` at all — and it
would turn a leaked button into a leaked identity.

**Prompt injection is not solved here, and this document will not pretend it
is.** The payload is text chosen by whoever holds the token, and it goes into
the user message with the instruction rather than into a system one, which
helps and does not fix. A payload that talks the model into ignoring its
instruction will succeed. What makes that survivable is the blast radius rather
than the prompt.

**In a workspace with no connected service**, that radius is what it always
was: the agent has no tools, reads nothing it was not already given, and can
deliver only to a channel belonging to the routine's own owner. The worst
outcome is a misleading summary in the owner's own inbox — the same thing a
hostile RSS feed could already produce.

**With a connected service it is wider, and the sentence above stops being
true.** The agent can query a database or call an API that somebody in the
workspace deliberately connected. What bounds it then: the origin is one a
person chose, the methods are ones a person allowed, nothing writes by
default, mail goes only to the owner's own channels, and anything needing
approval is recorded rather than done. Worth reading before you point a public
webhook at an agent that can reach your production database.

Treat the token as the security boundary, because it is the one.

## Keeping what it sends

A routine delivers and then forgets. Turn on **Keep a copy** on the routine's
page and it also files each delivered summary into a knowledge bundle, as an
ordinary document — chunked, embedded, retrievable in chat, exportable,
deletable, exactly like something somebody uploaded.

This is the difference between a routine that mails you and a routine that
accumulates. Fifty-two weekly competitor digests in a bundle are a year of
history the agent can be asked a question of, and "what did they ship in Q2?" is
a question no Slack channel answers.

It is off by default, and that is about intent rather than cost — see the end of
this section for what it costs, which is single figures.

### One document per run

Each delivering run writes one document, named after the routine and the day:

```
Competitor digest — 2026-09-20.md
```

Inside, the text opens with that same line as a heading and then carries exactly
what was delivered — including the sentence about entries the per-run cap
dropped, if there was one. A digest that was missing thirty entries is still
missing them a year later, and a tidier filed copy would be the more
complete-looking of the two.

Two alternatives were considered and dropped. Appending to one growing document
re-cuts every chunk boundary on each append, so the whole history is re-embedded
every time and the cost grows with the square of the number of runs. Replacing
the document each run — the way a connected source does — is wrong for a
different reason: a connection _reconciles_, answering "what is there now",
while a routine has a cursor and answers "what changed since". Week 12's summary
is not made wrong by week 13. It is history, which is the whole point.

Two runs on one day produce two documents with the same name. That is what
happened, and the timestamps tell them apart.

### How many it keeps

**Keep the last** bounds it: 52 by default, which is about a year on the
dominant schedule. When a run files the 53rd, the oldest is removed — and
"removed" means what it means everywhere else in Covan, so it is recoverable
until the purge window passes. It does not appear in **Recently deleted**,
because nobody deleted it; it aged out.

### Who may file

Filing is a **write** into the workspace's knowledge, so it needs
`can_write_in_workspace` — the same permission as uploading a file. Delivering
is only reading.

The two come apart when somebody is demoted. A viewer's routine keeps
delivering, because their mail is theirs, and stops filing, because the bundle
is the workspace's. The engine re-reads the owner's role on every run rather
than trusting what was true when the routine was set up, and the run history
says so when it happens.

This one check is genuinely load-bearing. The engine holds a service-role client
and row level security does not constrain it, so nothing else in the system
would notice.

### Where it does not work, and how you find out

The scheduled worker can be deployed without document storage — on Cloudflare
that is the normal case, because an R2 bucket cannot be shared across accounts
and `wrangler.cron.toml.example` says so. Such a worker can deliver routines and
cannot write documents.

When that happens, **the run still succeeds**. It delivers, it is recorded as
`Sent`, and a line under it reads:

```
not filed: this deployment's scheduled worker has no document storage bound
```

The alternative was worse in a way worth naming. An unguarded write would throw,
the run would be recorded as a failure, the schedule would back off
geometrically, and after five of them a routine that was delivering perfectly
would be **paused** — for the sake of an optional extra. Every way filing can
fail is therefore a sentence in the run history rather than a failure: a missing
bundle, a demoted owner, an embedding provider having a bad afternoon. The
sentence is only ever there when something went wrong, so seeing one means
something.

### The loop

A filed document is a real document, so it can be read back. There are two ways
that matters and they are closed differently.

**A routine watching a connection never sees what a routine wrote.** The
connection source filters on provenance, so filed documents are invisible to it
whatever bundle they are in. Without that, two routines pointed at one bundle
would manufacture each other's input forever, paying for a model call each time.
This is a structural rule rather than a coincidence: before the provenance
column existed it was held shut only by the fact that a filed document happens
to have no connection.

**A routine can read its own earlier output**, when its agent has the output
bundle attached. That is often exactly what you want — a digest that knows what
it said last week — so it is not prevented, and the card says plainly when the
arrangement is in place. It does not compound: each run still summarises fresh
material. Excluding one routine's own output while leaving chat and every other
routine able to read it is a narrower change than it sounds and is not in this
release.

### What it costs

The embeddings are charged with the run that bought them, in the same number on
the same row — there is no second meter. A 3,000-character summary is about two
chunks, roughly 800 embedding tokens, which the usage counter weights down to
single figures against one chat turn.

### What it looks like afterwards

In the agent's **Knowledge** tab, a filed document sits in the list like any
other, with one extra phrase on the line under its name:

```
14 KB · Written by Competitor digest
```

No chip, no colour, no new column. Where a document came from is derived from
what it points at, and a document nobody has to explain — one somebody uploaded
— says nothing at all. If a colleague's routine filed it and that routine is
private, the line reads `Written by a routine`: the document is yours to read
and the routine is not yours to see.

One honest gap: a document written by **Save as document** from a chat session
still looks exactly like an upload, because nothing records that either.

## Scheduling

A schedule is a five-field cron expression plus an IANA timezone, and the
interface never asks anyone to write one. The picker offers every N minutes,
every N hours, and every day at a time. An expression it cannot represent
exactly — the draft parser can emit `0 9 * * 1-5`, and older routines carry
whatever they were created with — is shown as prose with a **Change** button
rather than silently rounded to the nearest shape it does understand.

The picker will not accept an interval finer than five minutes. That floor lives
in the interface rather than in the API, which checks only that the expression
and the timezone are both ones the parser can resolve.

### What wakes it up

A routine's frequency is not the trigger. `routines.next_run_at` holds when each
one is next due, and the engine only ever asks the database "is anything due?"
So "every 15 minutes", "hourly" and "Mondays at 09:00" all run off one
heartbeat, and adding routines adds no schedules anywhere.

What supplies that heartbeat is the one place the two runtimes genuinely differ,
and they are not the same mechanism:

- **On Cloudflare** it is a cron trigger firing `*/5 * * * *`, on a Worker that
  has no HTTP handler at all (`worker/src/cron.ts`). It is a second Worker
  because the Workers Free plan caps an account at five cron triggers and the
  account running the hosted API is at that cap; the API Worker still exports a
  `scheduled` handler, so a deployment with a spare slot can put the trigger
  there instead. Running both at once is safe, which is what makes the split
  cheap.
- **On a self-hosted install** there is no cron and no second process. The Node
  entry point that serves the API also starts a `setInterval`, at
  `ROUTINE_TICK_MS` milliseconds — 60000 by default. On `SIGTERM` the interval
  is cleared before the listener closes, so no new tick starts while the server
  is shutting down. A tick already in flight is not waited for: the process
  exits a few seconds later either way, and anything that tick had claimed is
  reclaimed when its lease expires.

`ROUTINE_TICK_MS` and the cron trigger are two different things with two
different default periods, and neither is a setting for how often a routine
runs. The five-minute floor in the picker is written against the Cloudflare
trigger; a Docker install ticking every minute is not offered anything finer.
The variables are in [Self-hosting](self-hosting.md).

### Claiming

Ticks are allowed to overlap, and the engine may run in two places at once, so
the interesting question is why a routine is never run twice.

Handing out work is a single statement. `claim_due_routines` takes the active
routines whose `next_run_at` has passed, locks them `for update skip locked`, and
stamps `claimed_at` on the rows it took. A second tick arriving mid-flight does
not queue behind the first and does not collide with it: it steps over every
locked row and takes the next ones. The function is `SECURITY DEFINER` with
`EXECUTE` revoked from `PUBLIC` and granted only to the service role, so it is
not reachable through the Data API.

`claimed_at` is a lease rather than a flag. A routine claimed more than fifteen
minutes ago is treated as abandoned — the process that claimed it died mid-run —
and becomes claimable again. Nothing is lost when a worker is killed; the run is
only late.

A tick takes at most four routines. That number is worked backwards from the
Workers Free plan's limit of 50 subrequests per invocation against the worst case
for a single routine, and a backlog a tick cannot drain is left for the next one
rather than run until the invocation is killed.

The claim is not the only defence, because it cannot cover **Run now**, which
deliberately skips it — the point of that button is to run a routine that is not
due, so there is nothing to claim. What covers both is that the executor reserves
one key per item in `routine_deliveries` _before_ it sends, under a unique
constraint. Whoever gets there second reserves nothing and therefore delivers
nothing. Claim-then-send is the deliberate order: send-then-record duplicates the
message whenever the recording fails, and a duplicate is the error people
actually notice.

## When a run fails

Every run writes a row either way, and the routine's page shows the last fifty:
what it sent, or why it did not. A failed row is red and carries the error text
as it was recorded. A failing delivery's response body is read to at most 64 KB
and then truncated to 200 characters, so a receiver answering with an HTML error
page — or with an endless stream — cannot write a megabyte into the database or
spend the engine's memory getting there.

What happens around that row, in order:

1. **Reserved keys are handed back, unless the message went out.** A run that
   failed before delivering releases its claims so the next run retries those
   items. Once the message is out the claims stay, so a failure in the
   bookkeeping that follows cannot lead to the summary being sent a second time.
2. **The next run is backed off.** The first failure waits for the routine's
   natural next run; each further consecutive failure doubles the wait, capped at
   six hours past the natural next run so that a failing daily routine cannot
   drift days into the future. Nothing retries inside a tick, and no _scheduled_
   run happens sooner than that — **Run now** and resuming both ignore it.
3. **Consecutive failures eventually pause it.** The counter is compared against
   one of two limits, and which one is decided by the failure that just
   happened: five, or twenty if that last failure was somebody else's fault
   rather than the routine's — a `429` or a `5xx`, whether it came from the
   source being read or from the channel being delivered to. The limits differ
   because backoff means twenty transient failures represent days of something
   being unreachable, while three rate-limited ticks in an afternoon represent
   nothing. Because only the latest failure picks the limit, a routine four hard
   failures deep that then gets rate-limited is judged against twenty rather
   than five, and survives that tick.

   Delivery was not always counted this way: until the webhook kind was added,
   every delivery failure counted the same and five of them paused the routine,
   so a Slack outage could take a working routine offline until somebody noticed
   and resumed it by hand. A wrong URL or a revoked secret still pauses at five,
   which is the case where retrying changes nothing.

4. **A pause is announced**, through the channel the routine already delivers to,
   unless the owner has turned that notice off in Settings. It is best-effort:
   the pause is already recorded and visible, and a dead delivery channel is
   itself a plausible reason for the pause, so a notice that cannot be sent does
   not become a second failure.

The status on the routine's page reads "Paused — " followed by the reason,
because a routine that dies quietly while the interface still says "Active" is
the failure that would destroy trust in the feature. Resuming clears the reason
and the failure count and schedules the next run immediately, which is why a
routine the engine paused recovers with one click once the cause is fixed.

### Runs that send nothing

`skipped` is not a failure and is shown rather than hidden, because it is the
answer to "why didn't it send me anything?". A run is skipped when the source
answered `304` or hashed to the same page as last time, when a feed had no new
entries, and on the first run of a feed or page watcher.

### Nothing relevant

There is a second answer to that question, and it is the one you will see most
on a broad source: the run had real new entries, and the agent decided none of
them were what your instruction asked for.

Before this existed, every run with new entries delivered. Point a routine at a
general news feed and ask for competitor news, and most runs are six unrelated
posts plus a paragraph explaining that none of them are about competitors —
hourly, in a channel people read, until they stop reading it. The routine goes
on working and stops being useful, and nothing anywhere records that.

So the model is asked two things rather than one: whether the material contains
anything the instruction asked for, and the report. When the answer to the first
is no, nothing is delivered and the run is recorded as
`Nothing relevant · 6 reviewed`. **The count is the point.** A routine that
filters and a routine that is broken both look like silence from outside, and
that row is where you can see it is still reading.

Three things follow.

**It costs what it costs.** The model call that produced the judgement is the
call you pay for, so a filtered run is billed like any other. What it saves is
attention, not tokens.

**A rejected entry is not offered again.** The cursor advances and the delivery
claims stay, so an entry that has been judged is done with — otherwise a busy
feed would spend a model call per run re-reaching the same answer.

**A scheduled prompt is never asked.** With no source, there is nothing for its
output to be irrelevant _to_: the instruction is the whole job. Asking anyway
would let one `false` silence "remind the team to post standup" permanently.

The decision comes back as a field of its own rather than as something to read
out of the summary text, and **every way of failing to read it delivers**:
unreadable JSON, a missing decision, or a decision that is not a plain `false`
all send the message. That asymmetry is deliberate. A routine that sends
something it should have withheld is the noise there was before, noticed at
once; a routine that goes quiet because of a bug is indistinguishable from a
quiet week, for as long as it takes somebody to get suspicious.

Two more are worth naming. If the owner is no longer a member of the workspace,
the run stops before anything else happens and the routine pauses, and unlike a
pause from repeated failures its owner is not told — membership is re-checked on
every run precisely because the engine holds a service-role client that row
level security does not constrain, and an ex-member's routine would otherwise
keep piping a workspace agent's output to their personal Slack. And on
the hosted service, a run whose owner has spent their monthly token allowance is
skipped before anything is fetched, leaving the cursor unadvanced so that
whatever it would have reported is still waiting when the allowance resets. Its
owner is told once, not once per tick. A self-hosted install has no allowance and
never takes that path.

## For the operator: one key, two deployments

The API encrypts a delivery secret when the channel is created. The engine
decrypts it when a routine fires. When the engine is a separate Worker, those are
two deployments with two independent secret stores, and **`ROUTINE_SECRET_KEY`
must be byte-identical in both**. AES-GCM is authenticated, so the wrong key does
not decrypt to nonsense — it throws, and every stored Slack webhook and email
address is undecryptable.

Nothing detects the mismatch at startup. The Node entry point checks that the
variable is present and non-empty, and that is all either runtime checks; the key
is not exercised until something encrypts or decrypts with it. So the first
symptom is a routine failing at the delivery step, five of those in a row pausing
it, and the pause notice — which goes through the same channel, with the same
wrong key — failing to send as well. Set it once, from one source, and copy it.

The key must also decode to 16, 24 or 32 bytes, which is an AES-GCM requirement
rather than a Covan one. A wrong length fails when a delivery channel is saved,
not at boot.

## Where to go next

- [Core concepts](concepts.md#routine) — what a routine is against the schema:
  what it hangs off, who can see it, and how sharing works.
- [Routines, in detail](architecture.md#routines) — the claim query itself, the
  executor's ordering, and why the batch size is the number it is.
- [Self-hosting](self-hosting.md) — `ROUTINE_SECRET_KEY`, `ROUTINE_TICK_MS`, the
  Resend variables, and deploying the engine as its own Worker.
