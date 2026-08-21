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

Three source kinds, and the difference between them is what counts as new.

| Source           | What a run does                                                      |
| ---------------- | -------------------------------------------------------------------- |
| RSS / Atom feed  | Fetches and parses it, and reports the entries it has not seen       |
| Web page         | Fetches it and hashes the body, and reports only when the hash moved |
| Scheduled prompt | Fetches nothing — it runs the instruction on the schedule            |

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

Nothing from the source is stored. The cursor holds fingerprints — seen keys, an
ETag, a content hash — so a feed your workspace watches is never mirrored into
the database.

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

Two truncations apply on the way in: a watched page contributes its first 20,000
characters, and each feed entry contributes 1,000 characters of its own summary
alongside its title and link.

The generated summary is stored on the run that sent it, so "what did it send me
last Tuesday?" has an answer inside the product rather than only in a mailbox
somebody may have cleared. This is the agent's own text, already delivered — not
a copy of the source.

## Delivery

A delivery channel is created in Settings, not on the routine, and routines pick
from the channels you already have. There are two kinds: a Slack incoming
webhook, which must be on `hooks.slack.com`, and an email address.

Slack delivery posts JSON to the webhook with the routine's name in bold above
the summary. Email goes through [Resend](https://resend.com), with the routine's
name as the subject and the summary as plain text.

A channel belongs to the person who created it rather than to the workspace, and
a routine may only point at a channel belonging to its own owner. That is
enforced by the insert and update policies on the table, not by the API. So
sharing a routine with the workspace shares what it does and what it sent, never
where it goes: a teammate looking at a shared routine sees "The owner's channel"
where the owner sees the label.

Deleting a channel that a routine still points at fails with a conflict, and the
interface names the reason rather than showing the database's version of it.

Email delivery needs `RESEND_API_KEY` and `RESEND_FROM` set on the deployment;
both are optional, and without them email delivery is unavailable. Pressing **Run
now** on an email routine in that state answers with a readable error instead of
running. A scheduled run has nobody to tell, so it fails and records whatever
Resend said.

### The secret you hand it

A webhook URL and an email address are both secrets, and both are encrypted with
AES-GCM before they reach Postgres, as `v1.<iv>.<ciphertext>` — the version
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
as it was recorded. The response body of a failing delivery is truncated to 200
characters first, so an upstream answering with an HTML error page cannot write
a megabyte into the database.

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
   happened: five, or twenty if that last failure was the source's fault rather
   than the routine's — a `429` or a `5xx`. The limits differ because backoff
   means twenty transient failures represent days of an unreachable source,
   while three rate-limited ticks in an afternoon represent nothing. Because
   only the latest failure picks the limit, a routine four hard failures deep
   that then gets rate-limited is judged against twenty rather than five, and
   survives that tick.
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
