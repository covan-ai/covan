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

### When it stops

A connection pauses itself and says why on the row:

- **The grant was revoked** — somebody removed the integration in Notion, or
  Covan's access in their Google account. Reconnect it.
- **The owner left the workspace.** A connection syncs with one person's access,
  and that access leaves with them.
- **It failed twenty times in a row** with a temporary error, which after
  backoff means the provider has been unreachable for days.

Resuming clears the reason and syncs immediately.

### Disconnecting

You are asked what should happen to the documents it imported. The default is to
keep them: they stop being refreshed and become ordinary uploads. Disconnecting
a source is not a request to unlearn what it taught.

Choosing to remove them puts them in the trash rather than destroying them, with
the same thirty days as anything else you delete — and a document the *source*
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
   connection meant for other people's workspaces needs *Any workspace*, and
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
this applies.** Set the audience to *Internal* and there is no warning screen
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
**Google Auth Platform**, split into *Branding*, *Audience*, *Data Access* and
*Clients*, and OAuth clients are created under the last of those rather than
under APIs & Services → Credentials.

1. **Enable the Google Drive API.** APIs & Services → Library → *Google Drive
   API* → Enable.
2. **Google Auth Platform → Branding.** App name, support email, home page,
   privacy policy and terms URLs, and the authorised domain — which has to be
   verified in Search Console before Google will accept it.
3. **Google Auth Platform → Audience.** User type *External*, then **publish the
   app to Production**.

   Do not leave it in *Testing*. A project in Testing with an external audience
   has its **refresh tokens revoked after seven days** for any scope beyond
   basic profile, and a Drive connection is nothing but a refresh token — so
   every connection would pause itself once a week with "the grant was revoked",
   which looks exactly like a customer having removed access. Testing also only
   admits the hundred test users you list by hand.
4. **Google Auth Platform → Data Access.** Add
   `https://www.googleapis.com/auth/drive.readonly`. Google will mark it as
   restricted and ask about verification; see above for what that costs.
5. **Google Auth Platform → Clients → Create client.** Type *Web application*,
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
which Slack does not read — its `text` is *mrkdwn*, a different language — so
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

## Where the credentials live

Every token is encrypted with AES-GCM before it reaches Postgres, under
`ROUTINE_SECRET_KEY` — the same key that protects delivery channels. The column
holding it is not selectable by any client role, so a member cannot read their
own connection's token back out through the Data API, and a database dump on its
own is worthless.

Tokens do not survive an export. A workspace restored from an archive has its
connections listed and paused, with the reason on each one: an OAuth grant
belongs to a particular app registration and cannot travel between installs.
Reconnect, and the documents already imported are adopted rather than
duplicated.

## What is not here

- **No search connectors.** Covan answers from what was deliberately imported,
  not from everything an account can reach.
- **No write access.** Every scope is read-only. Nothing Covan does can change a
  Notion page or a Drive file.
- **No per-file permissions.** A bundle is the unit of access. If different
  people should see different documents, put them in different bundles.
