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

## Starting from a template

The box above is a good second step and a poor first one: it asks you to have
imagined the routine already. So the first step also offers three to pick
instead, and **picking one makes no model call.** A template is the same set of
fields a draft produces, written down in advance, so choosing it does exactly
what accepting a draft does — it fills step 2 and leaves you looking at the
same editable form, with nothing fetched and nothing billed on the way.

- **Somebody's first week** — one note each morning for a week, from what the
  team has written down. Needs one document on this agent.
- **What nobody wrote down** — weekly, the topics your team asked about that no
  document covered. Needs you to be an admin, needs the coverage report switched
  on for the workspace, and is unavailable only for a workspace of exactly two —
  it works alone and it works again from three people up. See
  [The coverage report](#the-coverage-report).
- **Weekly digest of a feed** — point it at a feed or a page; once a week, what
  changed. Needs nothing, and arrives with the URL blank, because that is the
  one field a template cannot know.

"One document on this agent" means this agent's, not the workspace's. The
routines screen is scoped to one agent and the series reads that agent's
knowledge, so documents hung off a different agent do not make this one ready.

A template you cannot use yet is still shown, with the reason where its
description would be, and is not clickable. Hiding it would mean nobody learns
the feature exists, and "an admin has to turn this on in Settings" is a useful
sentence to read. Only the first unmet reason is given: somebody who is not an
admin does not also need telling that the report is off.

**A workspace with no delivery channel is no longer sent to Settings and back.**
When there are none, "Deliver to" is an address field pre-filled with your own
address, and the channel is created from it in the same request that creates the
routine. If the routine is then refused — an unreadable schedule, a URL the
guard will not have — the channel is deleted again, so correcting the field and
pressing Create a second time does not leave a stack of encrypted addresses
nothing points at.

"Somebody's first week" is the one template that ends: after seven delivered
mornings it stops itself, and a routine that has stopped that way reads
**Finished** rather than _Paused_. The instruction carries seven subjects — six
of them the six knowledge templates the product already suggests, and a seventh
for anything the first six missed — and the engine tells the model which morning
it is on, and says plainly when it is the last. That position is the only thing
that varies between the seven runs: there is no memory and no second model call.
The mechanism, and what happens when a morning does not arrive, is
[A routine that ends](#a-routine-that-ends).

## What it can read

Five source kinds. For the three that watch something outside, the difference
between them is what counts as new; the other two have nothing to diff and run
every time.

| Source           | What a run does                                                          |
| ---------------- | ------------------------------------------------------------------------ |
| RSS / Atom feed  | Fetches and parses it, and reports the entries it has not seen           |
| Web page         | Fetches it and hashes the body, and reports only when the hash moved     |
| Connected source | Fetches nothing — it reports the documents a connection has synced since |
| Scheduled prompt | Fetches nothing — it runs the instruction on the schedule                |
| Workspace report | Fetches nothing — it reads the workspace's own answers                   |

The last of those is long enough to be its own section:
[The coverage report](#the-coverage-report).

For the two that fetch, the request carries `If-None-Match` when a previous run
stored an ETag. A `304` ends the run immediately: no parse, no model call, and a
`skipped` row in the history. Most ticks on a healthy feed take that exit. The
fetch reads at most 2 MB, times out after ten seconds, follows at most three
redirects, and identifies itself as `covan-routines/1.0`.

**The first run of a feed or page watcher sends nothing on purpose.** With no
cursor there is nothing to compare against, so the run records what is already
there — the entry keys, or the page's hash — and stops. Without that rule the
first tick would post the whole backlog of a feed into somebody's Slack. The
create dialog says so under the form. A scheduled prompt and a workspace report
are the exceptions: having nothing to diff, they run the first time and every
time.

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

A scheduled run is capped at **eight tool calls**. That is this limit talking,
not a judgement about what a routine deserves. Chat was raised to sixteen when
connected apps arrived, because finding an operation costs a step before running
one costs another, and put back the same day: the API Worker had the same
fifty-subrequest cap as the tick, and sixteen steps does not fit under it
either. A run that reaches the cap says what it did not finish rather than
stopping silently.

The two numbers used to agree by coincidence and no longer do. A conversation on
a deployment that has set `WORKER_PLAN=paid` is budgeted 24 tool calls and may
take up to two further rounds past that, because Workers Paid allows one
invocation ten thousand subrequests rather than fifty. **A scheduled run does
not follow it**, and the reason is the arithmetic on this page: a chat turn is
one invocation, where a tick multiplies by the batch size. Raising this one
means redoing the sum above first.

If chat is ever raised again, this stays at eight until the arithmetic above is
redone — a routine shares its fifty with the rest of the batch, and chat does
not.

So for routines that use tools, on Workers Free, either:

- run the scheduler on the **Node/Docker** stack, where there is no subrequest
  limit (see [self-hosting](self-hosting.md)); or
- move to **Workers Paid**, where the limit is 10,000 and CPU time becomes the
  binding constraint instead.

Left as it is, a tick that runs out of subrequests fails the routines it was
part way through, which is recorded as a run failure and eventually pauses
them. That is a bad way to find out, which is why it is written here.

## The coverage report

One source kind reads nothing outside the workspace. A **workspace report**
answers the question an admin cannot answer any other way — _what does the team
keep asking that nobody has written down?_ — and because the raw material is
what colleagues typed in private rooms, most of this section is about what the
report refuses to tell you.

It is off until an admin turns it on, per workspace, in Settings beside the
coverage figures. The column defaults to false, so **no existing workspace
starts producing one because of a deploy**, and both database reads behind the
report refuse while the switch is off rather than trusting the application to
have checked. Turning the switch on does not by itself send anything: it lifts
the requirement that stops the template being picked, and somebody still has to
create the routine.

### What it reads

`messages.grounding` has recorded how every reply arrived since it was added:
a passage that cleared the similarity floor, the whole document as a fallback,
or nothing at all. The middle one is what this reports. A reply that fell back
to whole documents is usually still a decent answer, and it means no passage in
anything the team wrote was close to what was asked — the question somebody
keeps asking that nobody has written down.

The question is the last user message before that reply in the same session. A
run reads the last **seven days**, and at most **150** of those questions,
newest first — which at 120 characters each is a prompt the size the engine
already pays for elsewhere. Questions of one character are dropped as stray
keystrokes, a reply that was regenerated is not counted twice, and a session
somebody deleted is not read at all: a deletion that left the text of a question
reachable here would be cosmetic.

That seven days is fixed, not derived from the routine's own schedule. The
template runs weekly, so the window and the cadence agree today — but an owner
who edits the schedule to run daily gets a daily email of the same rolling
seven-day window, not a one-day slice of it.

### What it never contains

No name and no question text ever reaches an admin. That is four separate
narrowings, and it is worth seeing them in order:

1. **The database truncates.** The read returns at most **120 characters** of
   each question, cut in SQL, so the full text never crosses the database
   boundary at all. It returns no user id either — each asker arrives as an
   opaque integer, salted per call, which exists so the engine can count
   distinct people and carries nothing else.
2. **Only the engine sees even that.** Both database reads are granted to the
   service role alone — not to an admin's own session — so there is no screen
   and no API route anywhere that returns a question, and the 120-character
   rows live inside one run of the routine and are stored nowhere.
3. **The model sees de-duplicated question text and answers with labels.** Its
   job is to group the questions into at most eight topics and name each one.
4. **The delivered report contains labels and counts, and sentences built from
   those counts** — how many answers found nothing in the window, each topic
   with how many questions and how many people were behind it, and how many
   questions did not group into a topic at all.

A label is checked against every question the model saw, before and after
truncation, and a label that reproduces one is **withheld while the topic is
still reported**: the row goes out unnamed, with its counts, and the report says
in its own words that a name was withheld and nothing was dropped. Keeping the
topic and losing the name is deliberate — a dropped row is indistinguishable
from a quiet week, and an admin who cannot tell those apart stops trusting the
report.

**The honest limit of that check is containment, not meaning.** It refuses a
label that quotes a question; it cannot refuse a label that paraphrases one. So
a topic name that happens to be a close rewording of something somebody typed
can in principle be reported. What bounds the damage is the floor below it: in
any workspace of three or more, nothing is reported at all unless three
different people asked about it, so a phrase that survives is one three
colleagues raised independently rather than one person's sentence handed back.
It is a real residual risk, and it is the
reason there is no second model call to write the report up — a model asked to
embellish a label that has already passed the check is the one way a paraphrase
could get worse rather than better.

### The floor, and the workspace that cannot use this

How many different people a topic needs before it may be reported is derived
from the size of the workspace, not configured:

| People in the workspace | Floor                               |
| ----------------------- | ----------------------------------- |
| 1                       | 1 — there is nobody to protect from |
| 2                       | the report cannot run at all        |
| 3 or more               | 3                                   |

**A two-person workspace cannot use this feature, and no setting will change
that.** With two people, any topic the report names tells one of them something
about the other; there is no number that fixes it. So the template says so once,
at the point of picking it, rather than letting somebody set up a routine that
delivers an empty report every week forever. A workspace of one is the opposite
case and is allowed: the only person who could read the report is the only
person who asked.

The floor is not configurable in any form, because a privacy floor an admin can
set is a privacy floor an admin can set to one.

### Opting out, and why nobody can see who did

Any member can exclude their own questions, from Settings, and the control is
there whether or not the report has been switched on: a switch that only
appeared once an admin turned the report on would be asking somebody to have
decided before they knew the feature existed. The same switch is also the only
way back in — the notice is shown once and dismissed, so Settings is where a
decision gets revisited.

Two things about it are worth stating plainly.

**It is retroactive.** The exclusion is applied when the report is read, not
stamped on each answer as it was written, so opting out today removes everything
you have ever asked from every future report, not only what you ask next.

**Nobody can see who opted out — including an admin.** The table's read policy
is self-only, so the question "who excluded themselves?" has no answer anywhere
in the product, for anybody. That is the feature, not an oversight: an admin who
could list the opt-outs would learn which individuals chose to hide something,
which is a sharper signal about a person than anything the report itself
carries, and one nobody agreed to by declining to agree to something else.

The first time an admin turns the report on, everybody in the workspace is told
once, in place, with both choices in front of them — exclude me, or keep me in.
It is a notice rather than a tenth transactional email: an email about a report
that may never clear its floor is noise.

One sharp edge, because it is easier to read here than to discover: **a
workspace archive carries the switch but not the opt-outs.**
`workspaces.gap_report_enabled` is exported; `coverage_opt_outs` deliberately is
not, because a table whose read policy is self-only would either be a back door
in an archive an admin downloads or would always export empty. So a workspace
restored from an archive comes back with the report on and nobody excluded, and
whoever restores it has to ask again rather than assume anybody's choice came
back with it.

### One model call, and a report that is printed

A coverage run makes **exactly one** model call, for the cluster labels.
Everything else — the counts, the ordering, the sentences — is the
application's, and the same input renders the same text every week, with no
date, no rounding and no hedging word anywhere in it. The agent's own persona
and model are not used: there is no agent behind this, and a coverage report
arriving in the voice of a Support Agent persona is not what anybody wanted.

That split is a decision rather than an optimisation. Handing the surviving
topics to a model to write up buys three problems: it can put an invented number
next to a real label, and a report of counts that might be wrong is worse than
no report; it can embellish a label that has already passed the containment
check; and a weekly report that reads differently every week is harder to read
than one that does not.

A quiet week is cheap on purpose. If the whole window has fewer distinct askers
than the floor, no grouping of it could produce a reportable topic, so the run
skips without a model call at all — and so does a window where every answer
found something. The one case that pays and reports nothing is a window whose
questions came back grouped and no group cleared the floor: the call was made,
so it is billed, and the run is recorded as a skip rather than as an email
saying "here is nothing".

### What stops it

Three things are re-asked on every run, because the engine holds a service-role
client and the policies that guarded the routine's creation cannot see a run:
the switch is still on, the owner is still an admin of the workspace, and the
workspace still has enough people in it. Each of them **pauses** the routine
with the reason, and tells the owner through the channel it already delivers to.
None of the three fixes itself on the next tick, and a routine that silently
skips forever is the failure this feature's pause machinery exists to avoid.

Three more things are refused in the database rather than in the API, because
the browser holds an anon key and `POST /rest/v1/routines` reaches Postgres
whatever the API accepts:

- **Only an admin can create one** — a clause in the insert and update policies
  on `routines`, not a role check in a handler.
- **It cannot file.** A routine that reads its own workspace may not point at a
  knowledge bundle. A coverage report filed as a document would be a document
  about what the team does not know, which every agent in the workspace would
  then retrieve and quote back at somebody in chat as if it were knowledge.
  This is the same policy clause, which means it is a guard on who can _set_
  the column rather than a backstop at run time: the engine files with the
  service role, so a bundle that somehow got onto the row is a document that
  gets written.
- **It cannot be shared.** A routine of this kind must stay private. A shared
  routine lets every member read its run history, including the delivered
  summary — which is the exact population the design keeps the report away
  from. This one is a CHECK constraint rather than a policy clause, so unlike
  the two above it binds the engine as well.

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

### A routine that ends

Most routines are standing orders and run until somebody stops them. A routine
can instead be given a number of runs, decided once when it is created and not
editable afterwards — "Somebody's first week" is the only thing that sets it
today, to seven. When the count is reached the routine sets its own status to
`completed` and stops being due, which needed nothing from the engine: the claim
query and the index behind it already select only active routines.

**Only a delivered run counts**, and that is the whole reason the counter is not
simply "times this ran":

- **A failed run does not spend a morning.** A week of a dead Slack webhook
  would otherwise complete a seven-morning series that sent nothing at all, and
  leave the routine reading _Finished_ having never once been read. Those
  failures back off and eventually pause it instead, which is the outcome
  somebody can act on.
- **A skipped run does not spend one either** — there was nothing new, or the
  agent judged none of it relevant.

**Run now** counts like any other delivery, because it delivers one. Pressing it
on a seven-morning series finishes the series a calendar day early, with all
seven notes sent and in order.

A finished routine is a third state and not a quiet pause, everywhere it is
shown: the badge reads **Finished**, "Next run" reads Finished, and no
Pause/Resume button is rendered at all. Both halves of that matter. "Resume" on
a finished series reads as an invitation to restart it, and resuming would start
morning eight of a seven-morning week; and the reason a routine paused is kept
for what the engine writes there after repeated failures, rather than widened to
also mean "your first week is over". Running the series again for the next new
starter is a new routine from the same template.

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
entries, and on the first run of a feed or page watcher. A coverage run has
three of its own — see
[One model call, and a report that is printed](#one-model-call-and-a-report-that-is-printed).

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
