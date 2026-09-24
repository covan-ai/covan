# Integrations

Covan connects to other tools in two directions, and they are genuinely
different things.

**Sources** bring documents in. A connected Notion workspace or Drive folder is
re-read on a schedule and kept in step with a knowledge bundle, so a bundle
stays right after the month somebody filled it.

**Surfaces** send answers out. The Slack app lets anyone ask an agent from a
channel, with the same knowledge and the same permissions they would have in
Covan itself.

Every one of them is off until an operator registers an app with the provider
and sets its credentials. Nothing is hidden when they are missing: the
Integrations page lists the source and names the variables that would turn it
on.

---

## What a connected source actually does

It is a **copy**, not a search connector. Nothing queries Notion or Drive when
somebody asks a question. The document is imported into a bundle, chunked and
embedded exactly like an uploaded file, and everything downstream — retrieval,
citations, export, row level security — carries on without knowing where it came
from.

That has three consequences worth knowing before you connect anything:

- **A synced document is a real document.** It appears on the Knowledge tab, it
  can be moved between bundles, and it is in your export.
- **Access is the bundle's, not the source's.** If a Drive folder is visible to
  three people at Google and the bundle is attached to an agent the whole
  workspace can use, everybody can ask about it. Connect folders whose contents
  the workspace is allowed to read.
- **Deletions travel.** Each sync lists what the source holds now and removes
  documents whose file is gone. A policy withdrawn at the source stops grounding
  answers here, which is the half a "what changed since" feed cannot do.

### The schedule

A connection re-reads itself every six hours by default; hourly, daily and
weekly are the other choices. A sync imports at most five documents per run and
comes straight back for the rest, so a first sync of a large folder finishes
over a few runs rather than in one.

Runs are recorded. `skipped` means it looked and nothing had changed — it is the
healthy state, not a failure.

That interval is also the ceiling on how fresh anything downstream can be. A
[routine](routines.md#watching-a-connected-source) can watch a connection and
report what it added or changed, and because it reads what the sync has already
imported rather than going to the provider itself, running it more often than
the connection syncs will not find changes any sooner.

### Who it syncs as

A connection belongs to the workspace. Everybody can see it, and what it imports
lands in a shared bundle.

What belongs to a person is the **grant**: the OAuth access it carries. That
decides three things — which files are visible, whose monthly allowance the
embeddings are charged to, and who the provider thinks is reading. So a
connection has a _grant holder_ rather than an owner, and the two can come apart.

They come apart most obviously when somebody closes their Covan account. The
connection survives, unowned and paused, with the documents it already imported
still attached to it. Anyone in the workspace who can write may then reconnect
it in place — it does not need an admin, because a team without a present admin
would otherwise have no way to fix it at all.

### When it stops

A connection pauses itself and says why on the row. What the page offers you
depends on which of these it is, because the wrong offer is worse than none —
resuming a revoked grant fails on the first call and pauses it again.

- **The grant was revoked** — somebody removed the integration in Notion, or
  Covan's access in their Google account. Only **Reconnect** is offered.
- **Nobody holds the grant** — the person who set it up has closed their
  account. Also **Reconnect**, by anyone who can write.
- **The grant holder left the workspace.** A connection syncs with one person's
  access, and that access leaves with them.
- **It failed twenty times in a row** with a temporary error, which after
  backoff means the provider has been unreachable for days.
- **The source suddenly shows far less than it did** — see below.
- **The provider is no longer configured on this deployment.** Nothing about the
  connection is wrong, and nothing on this page will fix it: an operator has to
  set the client credentials again.
- **It came back from a workspace export**, which carries no OAuth token.

Resuming clears the reason and syncs immediately.

### Reconnecting

**Reconnect** replaces the grant on the connection that is already there. It
keeps the bundle, the chosen Drive folder, the schedule, and every document —
only the credential and the grant holder change.

It is offered on a working connection too, not just a broken one, because
"this is syncing as the wrong person" is a real thing to want to fix. Before it
existed the only route was to disconnect and connect again, which produced a
_second_ connection pointed at the same bundle, left the first sitting there
paused, and relied on the next sync adopting the orphaned documents back.

### When a reconnect would delete half the bundle

This is the one that needed care. A sync reconciles: it lists what the source
holds now and hides the documents that are no longer in that listing. Correct by
its own rules — and if Alice's grant could see 400 files and Bob's can see 120,
the next run is entirely right to conclude that 280 documents have gone.

So a run that would remove a large share of what it holds removes **nothing**
and pauses instead, saying how many and out of how many. You get two answers:

- **Remove them and resume** — yes, those files really are gone.
- **Reconnect** — with an account that can see them.

The threshold is a fifth of the live documents, with a floor of five, so a small
folder somebody tidied does not trip it. It is not only about reconnects: a
Drive folder that stops being shared, or a Notion integration narrowed by an
admin, looks exactly the same from here, and the answer to all of them is to ask
rather than to act.

### Disconnecting

You are asked what should happen to the documents it imported. The default is to
keep them: they stop being refreshed and become ordinary uploads. Disconnecting
a source is not a request to unlearn what it taught.

Choosing to remove them puts them in the trash rather than destroying them, with
the same thirty days as anything else you delete — and a document the _source_
removed goes the same way, so a Drive permission that changed for an afternoon
costs you nothing.

If you reconnect the same source later, the documents it already imported are
adopted rather than duplicated.

---

## Notion

Notion decides the scope, which makes this the simplest source to run. During
the grant, Notion shows its own page picker; the integration can afterwards see
exactly what was ticked there and nothing else. A page un-picked later stops
appearing and is removed on the next sync.

**What is imported.** Pages arrive as Markdown, because the shape is the
meaning: a heading tells the chunker where a section starts, and a list that
arrives as one run-on paragraph retrieves worse than the same list with its
bullets. Headings, lists, to-dos, quotes, callouts, toggles, code, equations and
tables all keep their shape, and **links keep their targets** — a page whose
value is thirty links to other things is thirty links here too.

**Database rows bring their properties.** Status, owner, dates, tags, a
one-line summary: in a Notion database that is usually the whole of the row, and
its page body is empty. They arrive as a short list above the body. Relations
and rollups are skipped — they are ids and nested aggregates, which no question
can match.

**Images and files contribute their captions, not their links.** A file stored
in Notion is served from a signed URL that expires about an hour later, so
writing one into a document that will be read for months produces a link that
worked once. Captions are text and last. A caption is worth writing.

Child pages are not inlined: they are separate pages in their own right, so
inlining them would index the same text twice.

**Limits.** 500 pages per connection, 300 blocks per page, two levels of nesting
inside a page, and 100 rows of any one table. These bound what one sync can
cost; a curated set of pages is well inside all four. Multi-column layouts do
not spend a level of nesting — they are layout, not depth.

### Setting it up

Notion has renamed integrations to **connections** and moved them, twice.
`notion.so/my-integrations` and `notion.so/profile/integrations` both redirect
to the current home.

1. Go to <https://app.notion.com/developers/connections>. (In the app it is
   Settings → Connections, which needs Developer mode and workspace ownership
   before it appears at all.)
2. **New connection**, and choose **OAuth** as the authentication method. The
   default, "Access token", is a static workspace-scoped token for one
   workspace — Covan has no way to accept one, and the connect button will
   never complete.
3. Under **OAuth configuration**, add the redirect URI
   `<your API URL>/connections/callback` — for example
   `https://api.example.com/connections/callback`, or
   `http://localhost:8787/connections/callback` for a local stack. It must match
   byte for byte; Notion compares it again when the code is exchanged.
4. Choose the installation scope. **This cannot be changed afterwards** — a
   connection meant for other people's workspaces needs _Any workspace_, and
   getting it wrong means deleting the connection and starting again.
5. Set `NOTION_CLIENT_ID` and `NOTION_CLIENT_SECRET` from the **Configuration**
   tab. The secret is shown once.

---

## Google Drive

Read this section before promising Drive to anyone.

**The scope is the problem.** Syncing a folder needs `drive.readonly`, which
Google classifies as **restricted**. An unverified OAuth client still works, for
up to about a hundred users, and every one of them sees a full-page "Google
hasn't verified this app" warning before they can continue. Going past that —
or wanting the warning gone — means Google's verification.

The narrow alternative, `drive.file`, only reaches files the user picked through
Google's own Picker widget, and cannot express "this folder, and whatever
appears in it later". A folder that syncs is the whole feature, so the narrow
scope does not do it. This is worth re-checking rather than believing: if Google
ever gives `drive.file` a folder that keeps granting, the entire section below
stops being necessary.

### What verification costs

Not a checkbox, and not a one-off either.

- A restricted scope needs a **CASA Tier 2** security assessment on top of
  Google's own review. The self-serve route through an approved lab is typically
  **$540–$1,000**; the older, manually driven assessment ran to five figures and
  still applies to some grandfathered cases.
- **Four to twelve weeks** from first submission to approval, which is long
  enough to be a roadmap item rather than a task.
- **Annually.** Access to a restricted scope has to be re-certified every twelve
  months from the assessor's letter, so this is a recurring cost and a recurring
  piece of work.

Before submitting you will need the consent screen filled in properly, the
domain verified in Search Console, a public demo video showing the OAuth flow
and what each scope is used for, and a written justification for why
`drive.file` does not do the job. The video is the usual reason for a rejection:
it has to show the scope being used, not just the app existing.

**If everyone who will use it is in one Google Workspace organisation, none of
this applies.** Set the audience to _Internal_ and there is no warning screen
and no verification — but only accounts in that organisation can grant access,
which makes it right for a self-hosted deployment inside one company and wrong
for a product sold to others.

**Connecting is two steps**: the grant, and then a folder. A Drive connection
stays paused between them, because a connection that defaulted to all of My
Drive would be a product that quietly embedded somebody's tax return.

**What is imported.** Google Docs (as Markdown), Sheets (as CSV — the first tab
only, which is all Drive's export offers), Slides (as plain text), and ordinary
text files: `.txt`, `.md`, `.csv`, `.tsv`, `.json`, `.xml`, `.html`.

**PDFs are skipped**, and it is deliberate. Covan extracts PDF text in the
browser at upload time, because pdf.js does not run on the server. There is no
browser in a scheduled sync, so an imported PDF would be a document that is
listed, named to the agent on every turn, and impossible to retrieve a sentence
of. Upload those by hand.

**Shortcuts are followed.** "Add shortcut to Drive" is how most people get a
document from a shared drive into the folder they actually work in, so a real
team folder is often mostly shortcuts. Each one is read as the file it points
at — the target's name, and the target's modified time, so editing the document
re-imports it. A shortcut to a subfolder is walked into like any other folder.
If the folder holds both a file and a shortcut to that same file, it is imported
once.

Files larger than 10 MB are skipped, the same ceiling the upload form applies.

**Limits.** One folder, two levels of subfolders, six listing requests and
twenty-five resolved shortcuts per sync — enough for a few hundred files in an
ordinary folder tree.

### Setting it up

Google renamed all of this. What used to be the "OAuth consent screen" is now
**Google Auth Platform**, split into _Branding_, _Audience_, _Data Access_ and
_Clients_, and OAuth clients are created under the last of those rather than
under APIs & Services → Credentials.

1. **Enable the Google Drive API.** APIs & Services → Library → _Google Drive
   API_ → Enable.
2. **Google Auth Platform → Branding.** App name, support email, home page,
   privacy policy and terms URLs, and the authorised domain — which has to be
   verified in Search Console before Google will accept it.
3. **Google Auth Platform → Audience.** User type _External_, then **publish the
   app to Production**.

   Do not leave it in _Testing_. A project in Testing with an external audience
   has its **refresh tokens revoked after seven days** for any scope beyond
   basic profile, and a Drive connection is nothing but a refresh token — so
   every connection would pause itself once a week with "the grant was revoked",
   which looks exactly like a customer having removed access. Testing also only
   admits the hundred test users you list by hand.

4. **Google Auth Platform → Data Access.** Add
   `https://www.googleapis.com/auth/drive.readonly`. Google will mark it as
   restricted and ask about verification; see above for what that costs.
5. **Google Auth Platform → Clients → Create client.** Type _Web application_,
   and add `<your API URL>/connections/callback` as an authorised redirect URI —
   for example `https://api.example.com/connections/callback`, or
   `http://localhost:8787/connections/callback` for a local stack. It must match
   byte for byte; Google checks it again when the code is exchanged.
6. **Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`** from the client you just
   created. The secret is shown once.

Until the app is verified, everyone connecting Drive lands on "Google hasn't
verified this app" and has to open **Advanced** and continue anyway. That is
survivable for people you have told in advance and is not something to put in
front of a buyer.

If a connection fails immediately with "Google did not return a refresh token",
somebody has granted this app before: remove Covan from
<https://myaccount.google.com/permissions> and connect again.

---

## Slack

Mention the app in a channel, or send it a direct message, and the agent answers
in the thread — with the same retrieval, the same citations and the same
allowance as a question asked in Covan.

**Whoever asks is answered as themselves.** A Slack message carries a Slack user
id and nothing else, so Covan matches it to a Covan account by email, once, and
remembers. Somebody whose Slack email does not belong to a member of this
workspace is told so rather than answered — the alternative, running every
question as whoever installed the app, would retrieve with that person's access
and log every question as theirs.

**Answers are written in Slack's own formatting.** The agent writes Markdown,
which Slack does not read — its `text` is _mrkdwn_, a different language — so
replies are translated on the way out: bold, italic, strikethrough, links,
headings and lists all arrive formatted rather than as visible asterisks and
brackets. Code blocks are passed through untouched, since both languages spell
them the same way.

**Each thread becomes a conversation in Covan.** A question asked in a channel
creates a shared conversation; a direct message creates a private one. Either
way it is an ordinary conversation afterwards — searchable, exportable, and
visible on the Chats screen.

Which agent answers is chosen on the Integrations page. It starts as the
workspace's oldest agent so the app works before anybody configures anything.

### Setting it up

1. Create an app at <https://api.slack.com/apps>.
2. **OAuth & Permissions** → redirect URL `<your API URL>/slack/callback`.
3. **Bot token scopes**: `app_mentions:read`, `chat:write`, `im:history`,
   `users:read`, `users:read.email`.
4. **Event Subscriptions** → request URL `<your API URL>/slack/events`, and
   subscribe to the bot events `app_mention` and `message.im`.
5. Set `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` and `SLACK_SIGNING_SECRET` — all
   three, or none. A client pair without the signing secret installs fine and
   then rejects every event it is sent, which looks like a Slack outage.
6. Install from Covan's Integrations page rather than from Slack, so the install
   is tied to your workspace. Only a workspace admin can do it.

`users:read.email` is not optional. Without it the app cannot tell who is
asking, and answers nobody.

### Removing it

Disconnecting in Covan deletes the installation and stops the app answering.
Removing the app from Slack itself is a separate action, in Slack — Covan does
not revoke on your behalf, because the two would then disagree whenever that
call failed.

---

## Running the scheduler

Syncing is background work. It shares one tick with routines, and a tick does
routines first — a busy routine run has already spent most of a Cloudflare Free
invocation's subrequest budget, so a sync started after it would die partway
through. On any realistic schedule most ticks are idle, so a connection waits for
the next quiet minute rather than for a free hour.

**Self-hosted (Docker or Node):** nothing to do. The API process ticks on an
interval and has a filesystem document store, so connections sync.

**Cloudflare:** a sync writes documents, so it needs the R2 bucket — which is
bound to the API Worker. If you run the scheduler as a separate Worker on a
second account (`wrangler.cron.toml`, which exists because the Free plan caps an
account at five cron triggers), that Worker cannot reach the bucket. It notices
and skips with one line in `wrangler tail` rather than failing every connection.

So on Cloudflare, connected sources sync only when the **API Worker** has a cron
trigger of its own. Routines are unaffected either way. If a connection never
syncs and its runs list is empty, that is the first thing to check.

---

---

## Services an agent can call

The two directions above are about documents. This one is not: a **service** is
a database or an API an agent reaches _while it is answering_, and it is the
one place in Covan where the agent goes and looks something up rather than
being handed something in advance.

Adding one is a form on the Integrations page. There is no per-service code
behind it and there is not meant to be: the worker has eight general tools, and
a service is a row telling one of them where to go.

| What you want                                                       | What it takes                                                   |
| ------------------------------------------------------------------- | --------------------------------------------------------------- |
| A hosted Supabase project                                           | An account token, and a tick beside the project                 |
| A Postgres (self-hosted Supabase, your own PostgREST, any Postgres) | One row, plus the function below installed on it                |
| HubSpot, Stripe, Linear, any REST API with a token                  | One row                                                         |
| Gmail, Slack, Notion, HubSpot — about 1500 apps, by signing in      | A search and a consent screen. See **Connected apps** below     |
| A service that speaks MCP and has no HTTP API                       | A one-off addition to the code — not built, and deliberately so |

### What the form asks for

- **Name.** What the agent calls it. It is shown the name and the id, so
  "Covan Supabase" and "HubSpot (prod)" are how it tells two apart.
- **Base address.** Every request stays inside it. The model names a _path_,
  never a URL, and a path that resolves outside the base — a full URL, a
  protocol-relative `//host`, a `..` that climbs out — is refused before
  anything is sent. Leaving the origin is not forbidden, it is impossible.
- **Methods you allow** (HTTP only). Your decision, not the agent's, and it
  cannot widen the list. The default is `GET` alone, which means nothing the
  agent does through that connection can change anything.
- **Credential headers.** One or more, encrypted together before they reach
  Postgres. They are never sent back to the browser: rotating a token is
  removing the connection and adding it again.
- **What it holds.** For an API this is the only thing the agent knows about
  it, so name the paths that matter. For a database it is optional — the agent
  reads the schema itself the first time it asks, and remembers.

### Connecting a Supabase account

The shortest road to a database, and the one that installs nothing in it.

On the Integrations page, under **Services an agent can call**, the Supabase
card takes an access token — Supabase makes them under Account settings →
Access tokens — checks it, and lists the projects it can see. Tick the ones
agents here may read. Each one becomes an ordinary connected service, and the
agent queries it with the same `query_database` tool it uses for everything
else.

**The token is account-wide.** It reaches every project in that Supabase
account, not only the ones you tick, which is why connecting an account is an
admin's to do — the same rule, for the same reason, as the workspace's own
OpenAI key. Choosing which projects to connect afterwards is an ordinary
write, because by then the decision that mattered has been made. The token is
encrypted before Postgres sees it, no client role may read the column back, and
the page shows four characters of it so two tokens can be told apart.

**Read-only is still Postgres's word, not ours.** Statements go to Supabase's
`/database/query/read-only` endpoint, which runs them as `supabase_read_only_user`
— a role holding `pg_read_all_data` and nothing else. A hidden `INSERT`, an
`UPDATE` inside a CTE, DDL: refused by the database, by its own rules.

**Name the schema on every table.** That endpoint refuses a reference that does
not, so `select * from public.orders` works and `select * from orders` does
not. Covan's schema summary is written that way, so an agent that read the
schema first — which it does — writes it that way too.

Two more things worth knowing. Disconnecting the account removes the projects
it opened, because without the token they cannot answer anything; removing one
project leaves the rest alone. And a Supabase account is not in your workspace
export, for the reason a credential never is — you connect it again, in the
install that is going to use it.

### Connecting a Postgres

Use this one for a Postgres that is not a hosted Supabase project, or for a
hosted one you would rather not hand an account token for. It asks the
opposite trade: a function installed in the database, and no account
credential.

Covan talks to a database over HTTPS, through PostgREST, because a Cloudflare
Worker cannot open a raw TCP socket and Covan has to keep running on both of
its runtimes (`docs/architecture.md`, "the two seams"). PostgREST will not
accept raw SQL, but it will call a function — so the function is the carrier.

Install this on the database you are connecting. It is **not** one of Covan's
migrations and never will be; it belongs to your database, and its name is
yours to choose:

```sql
create or replace function public.covan_query(p_sql text, p_limit int default 500)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_result jsonb;
begin
  -- The whole of the read-onlyness, and it does not depend on parsing the SQL:
  -- a hidden INSERT, an UPDATE inside a CTE, or any DDL is refused by Postgres
  -- at the transaction level.
  set local transaction read only;
  set local statement_timeout = '10s';
  -- The caller's SQL goes in a subquery of its own, and the cap is applied
  -- outside it. Appending `limit N` straight onto the end would be a syntax
  -- error the moment the query already has one — which an agent writing its
  -- own SQL does constantly.
  execute format(
    'select coalesce(jsonb_agg(t), ''[]''::jsonb) from (select * from (%s) q limit %s) t',
    p_sql, p_limit)
    into v_result;
  return v_result;
end;
$$;

-- Postgres grants EXECUTE on a new function to PUBLIC, and PostgREST exposes
-- `public` functions as RPC endpoints. Without this line the function is
-- callable by anybody holding the anon key.
revoke all on function public.covan_query(text, int) from public, anon;
grant execute on function public.covan_query(text, int) to service_role;
```

Then own it with a role that can only read. `security definer` means the
function runs as its owner, so the owner is the ceiling on what any query
through it can reach — a read-only role with rights on two schemas describes
and queries two schemas, and nothing else exists as far as the agent is
concerned.

Fill in the form with:

| Field              | Value                                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------------- |
| Kind               | Postgres behind PostgREST                                                                                       |
| Base address       | the PostgREST base — for hosted Supabase, the project URL with `/rest/v1` on the end                            |
| Read-only function | `covan_query`                                                                                                   |
| Credential headers | `Authorization: Bearer <key>` **and** `apikey: <key>` for Supabase behind Kong; one header for a bare PostgREST |

**The methods list means nothing for a database connection**, and the form does
not show it. A query is one POST whatever it does, so the method cannot be what
decides — the function is. Reading "POST" as "can write" is the one wrong
conclusion available here, which is why this paragraph exists.

### What the agent does with it

It writes its own SQL. There is no list of queries somebody prepared in
advance, because that list would need a new entry — which is to say a release —
for every new question. So the sequence is: read the schema once
(`describe_connection`, remembered afterwards), then write a query
(`query_database`), then answer.

One statement per call, and a `LIMIT` of its own is fine — the function above
wraps the query rather than appending to it, so the row cap and the agent's
own limit compose. `EXPLAIN` is the one read-shaped statement that cannot go
through this carrier, because it is not something you can select from; Covan
refuses it with a sentence rather than letting the database answer with a
syntax error.

Every call is written down. A reply that used a tool carries the steps under
it in the transcript, with what the agent asked for and how it went, and those
rows are in your export.

### Read-only, and where that comes from

For a database, whichever road it came in on: Postgres itself. A connected
Postgres runs the statement inside the function above, which opens with `set
local transaction read only`; a connected Supabase project runs it as
`supabase_read_only_user`. Covan also refuses anything that does not read like
a `SELECT` before it sends it, but that is a second line whose job is to give
the agent a readable reason — it is not what holds.

For an API: the methods you allowed. The default is `GET`.

**The first connection you open to a write method is the one that needs a
permission model**, and Covan has the schema for one and no rows in it — see
[a question row level security cannot be asked](security.md#a-question-row-level-security-cannot-be-asked).
Until then, treat a write-enabled connection as something the agent can do
anything with inside the methods and origin you gave it.

### Connected apps

The three roads above all end at a token you can paste. Most of the software a
team uses does not have one: Gmail, Slack, Notion, HubSpot and a few thousand
others want an OAuth consent screen, which needs a registered application at
each provider — which is a release per service, and the thing this whole design
exists to avoid.

So Covan buys that half. **Composio** keeps a registered application for about
1500 services and a machine-readable description of what each one can do, and
Covan uses both. What it does not use is their dispatch: the call is still made
here, under the same step budget, the same allowance and the same approval as
everything else.

Set `COMPOSIO_API_KEY` and a **Connected apps** card appears under _Services an
agent can call_. Search for the app, click it, sign in at the app itself, and
you come back to a connected service. There is no form: what a connection needs
is a consent screen, not a base URL.

**What an agent does with one.** Two tools, and it uses them in order.
`find_tool` searches the whole catalogue — every app, connected or not — for an
operation matching what it is trying to do, and answers with the operation's
name, the parameters it takes, and either the connection to run it with or a
note that the app is not connected here. `run_tool` then runs one. It cannot
guess: an operation it has not seen in a `find_tool` result is refused, and so
is one belonging to an app other than the connection it named.

**The asking.** The first time an agent acts on a connected app in a
conversation, you are shown what it proposes to do — the operation and every
argument, including the body of the message — and it does not happen unless you
say yes. That yes covers **that app for the rest of the turn**: checking three
threads and replying is one approval, not four. A different app asks again, and
so does the next conversation. On a scheduled run there is nobody to ask, so the
run records what it could not do and finishes.

**Always-allow** is per agent, per app, per operation, and an admin sets it.
That is the one thing that removes the asking, and it is deliberately narrow:
"this agent may file Linear issues without asking" is a decision somebody makes
once about one operation, not a switch over a whole account.

An admin sets it from the approval card itself — a third, quiet option beside
_Approve_ and _Not now_ — because that is the moment somebody knows what they
are agreeing to. Everything already granted is listed under the app on the
Integrations page, and **any writer can take one back**, not only an admin:
removing a permission is never the unsafe direction.

**What Covan stores, and what it does not.** Not the token. The OAuth grant
lives at Composio; what this database holds is an opaque reference to it,
readable by no client role. Removing the connection revokes the grant at
Composio before the row goes, so does closing the account.

**Three things to know before turning it on:**

- **It adds a subprocessor.** Data passing through an operation passes through
  Composio. See [Security](security.md) and, on the hosted product, the
  subprocessor list in the DPA.
- **The consent screen shows Composio's brand** unless the workspace supplies
  its own OAuth application for that service.
- **Calls cost money** — Composio bills per tool call — so they are metered
  against the same allowance a chat turn spends, at roughly one turn per call.
  A self-hosted deployment with no allowance configured is unmetered, as it is
  for everything else.

### What an agent cannot do with a service

- **It cannot reach anywhere you did not name.** Origin-locked, redirects
  refused, and the same SSRF guard every outbound request in Covan goes
  through — loopback, RFC1918, link-local and cloud metadata addresses are
  refused at call time, not only when you set the connection up.
- **It cannot choose a method you did not allow**, and it is told not to try
  another one.
- **It cannot send mail to an address** — through `send_email`, which takes one
  of _your_ delivery channels, so the worst an instruction hidden in fetched
  data can achieve there is a message to your own inbox. **A connected mail app
  is the exception, and it is a real one:** `run_tool` on Gmail can name any
  recipient, because naming the recipient is what the operation is for. What
  stands in for the ceiling is the approval — you are shown the address and the
  body before it goes. Connect a mailbox knowing that.
- **It cannot create a routine on its own.** It proposes one and you approve
  it; what gets created is an ordinary routine on the Routines screen, which
  you can edit, pause or delete like any other.

### Prompt injection, honestly

Text an agent fetches can contain instructions, and a model that reads them may
follow them. That was true before any of this — a hostile RSS feed could
already mislead a digest — and what has changed is the blast radius, so it is
worth saying what bounds it now: an origin you chose, methods you allowed,
read-only by default, delivery only to your own channels, and a person's yes in
front of anything that changes the world. On a scheduled run there is nobody to
ask, so anything needing approval is recorded and does not happen.

## Where the credentials live

Every token is encrypted with AES-GCM before it reaches Postgres, under
`ROUTINE_SECRET_KEY` — the same key that protects delivery channels. The column
holding it is not selectable by any client role, so a member cannot read their
own connection's token back out through the Data API, and a database dump on its
own is worthless.

A connected app is the exception, and in the direction you would want: there is
no token here at all. The OAuth grant is held by Composio and what this database
holds is an opaque reference to it — also selectable by no client role, because
one deployment-wide API key opens every workspace's connections, which makes
that reference the boundary between two tenants.

Tokens do not survive an export. A workspace restored from an archive has its
connections listed and paused, with the reason on each one: an OAuth grant
belongs to a particular app registration and cannot travel between installs.
Reconnect, and the documents already imported are adopted rather than
duplicated.

## What is not here

- **No search connectors.** A _source_ is imported, not queried: Covan answers
  from what was deliberately brought in rather than from everything an account
  can reach. A _service_ is the opposite by design and is scoped by the origin
  and methods you gave it rather than by what the credential could do.
- **No write access to a source.** Every OAuth scope is read-only. Nothing
  Covan does can change a Notion page or a Drive file. A _service_ connection
  can be opened to write methods, which is a different decision and a
  deliberate one — see above. The database has the schema for how a write would
  be permitted one day — see
  [a question row level security cannot be asked](security.md#a-question-row-level-security-cannot-be-asked) —
  and it is empty, which means every agent is refused every action. That is the
  same sentence as this bullet, written somewhere a program can check it.
- **No per-file permissions.** A bundle is the unit of access. If different
  people should see different documents, put them in different bundles.
