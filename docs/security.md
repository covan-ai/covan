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

Row level security decides which _rows_ you reach; it cannot hide a column. So
several tables also carry column-level grants, and the ones worth knowing are
where the two differ: an OAuth token and a webhook secret are withheld from
every client including the person they belong to, and the columns an engine
writes to explain itself — why a connection paused, and the code the interface
branches on — are readable by the workspace and writable by nobody. That second
one was a real gap rather than a precaution: a member who can write could
otherwise rewrite the engine's explanation into a sentence the integrations page
prints on a colleague's screen.

## A question row level security cannot be asked

Every policy above gates on `auth.uid()`: may **this person** see or change
**this row**. That question has one answer and it lives in one place, which is
why an API key carries no scopes — see
[API and keys](api.md#what-a-key-can-do). A scope would re-answer a question
Postgres has already answered, and two systems answering the same question can
disagree.

There is a second question, and it is not the same one wearing a hat. *May this
**agent** perform this action at Notion?* There is no `auth.uid()` in that
sentence. The actor is an agent rather than a person, the hour may be three in
the morning with nobody signed in, the verb is not select, insert, update or
delete, and the object is not a row in this database at all. RLS is structurally
unable to be asked it, so answering it elsewhere cannot contradict anything.

Covan has the schema for that answer and, deliberately, nothing yet that uses
it. Three tables: a catalogue of what this build can do at each provider, a
table of grants keyed on **(agent, connection, capability)**, and a log of every
attempt including the refused ones.

The rule is one sentence: **no row means no.** There is no `never` to store —
the absence of a grant is what `never` is, and a check constraint keeps it from
becoming a second, storable way of saying the same thing. Two representations of
"no" can disagree; one cannot. A grant says either `ask`, which produces a
pending approval and stops, or `always`, which means the approval was given in
advance.

So the grants table being empty is not a feature waiting to be switched on. It
is an exact description of what Covan does with a connected _source_: agents
read, and that is the whole list. The catalogue ships empty too, which is
stronger — with nothing in it a grant cannot be created at all, because there is
nothing for it to point at. A capability becomes grantable in the same change
that ships the code performing it, never before.

### The one place an agent does act, and what it costs

A **connected app** — Gmail, Linear, HubSpot, about 1500 of them — is the
exception, and it has its own grants table rather than borrowing the one above.
The reason is the catalogue rule: no migration can enumerate fifteen hundred
applications' operations, so a grant there names an operation with nothing to
point at, which is precisely the thing the table above will not do.

Everything else is carried across unchanged: the key is **(agent, connection,
operation)**, the modes are `ask` and `always`, and only an admin may promote
one to `always`. What is deliberately different is the default. Where an absent
grant on a source means **never**, an absent grant on a connected app means
**ask** — because that connection does not exist until somebody searched for the
app and either signed in at it or went and fetched a key for it, and the absence
of a further grant on something somebody went to that trouble for should surface
a question rather than a dead end.

The asking is scoped to **one app for the rest of one turn**. That is a
deliberate trade and worth stating: a confirmation per call would mean four
clicks to answer "check my last three threads and reply to Ana", which trains
people to approve without reading — and an approval flow nobody reads is worse
than a coarser one they do. A different app asks again, and so does the next
conversation.

**What this widens.** `send_email` guarantees that the worst an injected
instruction achieves is a message you receive yourself, because the model names
one of your channels and never an address. A connected mailbox ends that
property: naming the recipient is what the operation is for. The approval is
what stands in its place — you are shown the address and the body before
anything is sent — and on an unattended run nothing happens at all.

**What is stored.** Not the credential, of either kind. An application is
connected either by signing in at it — which produces an OAuth grant — or by
supplying a key the application issues, typed on a page Composio hosts and
never passing through Covan at all. Both are held by Composio, which is a
subprocessor on the hosted product; what this database holds is an opaque
reference, readable by no client role. That last part is not decoration: one
deployment-wide API key opens every workspace's connections, so the reference IS
the boundary between two tenants, and it is withheld exactly as a credential is.

Composio does not hand either one back. Asked about a connection, it returns the
key redacted to its first few characters, so not even the deployment's own API
key can read what a member typed.

**Taking one back differs by kind, and the difference matters.** An OAuth grant
is revoked at the provider — its own connected-applications page — and that
works whatever Covan does. A supplied key is not revocable that way: it stays
valid until somebody **rotates or deletes it at the provider**, and until then
it remains at Composio for as long as the connection row exists. Pressing Remove
in Covan hands the connection back to Composio and deletes the row; it does not
and cannot invalidate a key the provider issued. Rotate it at the provider if
that is what you need.

**A browser is a second subprocessor, and what goes to it is different in
kind.** Set `BROWSER_USE_API_KEY` and an agent can hand a web task to
browser-use: what leaves here is the task sentence a person wrote and approved,
and what that provider sees is whatever the page it opens shows it. A credential
goes with it only if a person chose to save one for that agent and that site —
the paragraphs below say exactly how — and the model Covan runs for the
conversation never receives it. The task sentence never carries one: the
provider takes a credential in a field of its own, and that field is filled from
the saved row alone. What the provider's own browsing agent can see is a
different question, answered under what this does not cover.

A browser task can nonetheless act inside a site you are signed in to, because
you can sign in yourself. When a task stops at a login wall, you take over the
browser the task was using — it is shown in a panel beside the conversation —
sign in at the site, and press Done. What persists is a *profile* held at browser-use — cookies and
session state, never in Covan's database — and it belongs to one person rather
than to a workspace, because a login is a property of a person and not of a
room they are in. Covan stores an opaque reference to that profile and the list
of domains it holds, nothing else — a list longer than the places you signed in
to, because a page drops cookies for other companies as it loads. Whether the
saved sign-in still works on the second attempt is the site's decision rather
than ours: Covan pins the egress country, and a site that binds a session to a
single address will ask again (measured on LinkedIn). **Settings → Browser
sign-ins** names those
domains and forgets them on one click, and closing your account deletes the
profile at the provider as well — the first because stopping Covan from holding
a login should not cost somebody their account, the second because erasure has
to be complete. The key is the deployment's,
not a member's: nobody is asked to pay a third party to use the feature, and a
task is metered against the allowance they already have. Unset the variable and
the tool does not exist. The public list for covan.app is on the
[subprocessor page](https://covan.app/subprocessors).

**A login you save is the one password Covan keeps, and the line it holds is
"never given to Covan's model" rather than "never received".** A person can save
a username and password for a site, for one agent — from the card at a login
wall — so the agent's browser signs in by itself the next time. It is the one place Covan holds a password somebody typed for another
site, which is why it is a dialog that says so and not a side effect of
anything. Covan receives it, then. What the design guarantees is where it goes
from there.

**What is stored.** Each half, the username and the password, is encrypted
separately with AES-GCM under the Worker's key (`ROUTINE_SECRET_KEY`, in the
envelope `secret-box.ts` writes — the same one delivery-channel secrets and
connection tokens use) before it reaches Postgres. There is no plaintext
username column to grant by mistake: the username is encrypted because it is
often the more personal half, and a shared login's row is readable by a team.
Both ciphertext columns are granted to no client role, and no client role can
write the table at all — saving means encrypting, which only the Worker does,
through the service role, after the route has asked through the caller's own
client whether they may use the agent. Each half is refused above 2,048 bytes.

**Who can read it: nobody, through the API.** The one function that decrypts a
saved login is the one that builds a run, and a login that will not decrypt —
the key changed — is a run without it, which meets the login wall.
The list route answers a label, a site, a scope and when it was last used.
Every one of these routes refuses an API key outright: a login planted by a
key would keep signing in as somebody after the key was revoked, and the list
is a map of where somebody's passwords are kept.

**Who may save what, and who sees it.** A personal login — used only when its
saver is the person the agent is working for, and seen by nobody else — can be
saved by anyone who can use the agent, viewers included, because it is theirs.
A login "for everyone using this agent" is a shared thing and follows the rule
above: workspace admins and members may save one, viewers may not. **Anyone
who uses the agent can then have it sign in and act as that account on that
site.** The list shows them a shared login's label, its site, its scope and when
it was last used — never the username, which is why a label that contains the
username, or the password, is refused — so they can read which account the agent will sign in as
before it does. But the list is not the whole of what they
can see: whoever runs a task with it can watch the browser, so they can see
what the browser types and whatever the account shows once it is signed in.
Save a login for everyone only if everyone using the agent may act as that
account. A site gets one shared login per agent; a second member's save is
refused and says to ask an admin, or whoever saved the first, to remove it. The
list does not name the saver, though the table records them by id.

**Where it goes.** To one provider, over TLS, for one run. There are two ways a
run is given one, and in both the Worker looks the login up and the client never
sends a value.

- **The agent starts a task.** When it calls `browse` and names the site the task
  needs to sign in to, the Worker looks for a saved login for that site on that
  agent that this person may use — their own first, else the agent's shared one
  — and, when there is none for the site itself, for the nearest parent it was
  saved under: a login saved for `linkedin.com` serves `accounts.linkedin.com`,
  never the other way round, and is still typed only on `linkedin.com` and its
  subdomains. It sends the provider two *secret bindings*, one per half, with
  the run. When a login is saved for the site, the card the person approves names
  it (*"signs in as linkedin.com (saved login: …)"*).
- **The person saves at a login wall.** The dialog shows the site the login is
  for, prefilled from the wall and editable, and says the login will only ever
  be typed on that site and its subdomains: the wall's host is what the run
  reported, which a page can steer, so the site saved is the one the person
  confirmed. *Save and continue* then
  hands the browser back with that site and the id of the login just saved — not
  its values: the save was the one request that carried them. The Worker
  resolves that login for the caller (the id is honoured only for their own
  personal login or a shared one whose saver is still a member, and otherwise the
  ordinary choice applies) and sends the bindings with the one free retry. That
  retry is not behind an approval card: pressing the button is the person's yes.

Either way the conversation's model is never given a value; the task text the
provider's agent receives names the two aliases, and only that. Both runs record
which saved login they carried (`browser_tasks.credential_id`), the free retry
included. The
provider types the value into the focused field itself, and only into a field
whose frame is on the binding's `allowedDomains`. That list is the saved row's
own site and nothing else, on both paths — never a host from the task sentence
or from a page, because a domain the model chose is a domain a page could have
talked it into. The run request is sent with its body redacted, so a provider
error cannot echo the values into a log or a step's result. Bindings are
run-scoped at the provider: a follow-up run carries them again or does not have
them, and a scheduled run, which has no conversation and nobody to approve,
cannot start a browser task at all.

**Which login a run carried is written down.** The run's record names the saved
login it was given (`browser_tasks.credential_id`, granted to no client role),
so "the saved login didn't get past the sign-in" is said only of a run that carried one. A
login merely saved was never tried when the model named no site, and telling a
person to re-enter a correct password sends them round the same wall again.

**How it leaves.** **Forget**, in settings, deletes the row; the saver can always
do it, and a workspace admin can for a shared login — never for somebody's
personal one, which an admin cannot see either. Closing an account deletes the
logins it saved, shared ones included, through the same cascade that removes the
rest of an account; an agent or a workspace removed for good takes its logins
with it. Leaving a
workspace deletes nothing, on purpose — somebody re-invited should not have to
type a password again — and instead a shared login stops being used the moment
its saver is no longer a member, until the saver or an admin removes it. A run
already started was handed its bindings when it was created; Forget stops the
next one. **Forgetting does not change the password at the site.** If a login
should stop working everywhere, change it there.

**A shared login is never signed in inside anybody's own browser profile.** A
run that carries one runs in a browser with no profile: the run that opens the
conversation's browser names none, and a follow-up in a browser that was opened
with your profile asks the provider for a fresh browser without it, in the same
session. So the sign-in a shared login performs is saved into nobody's cookie
jar, and Forget — or its saver leaving the workspace — really does stop the
agent signing in as that account. A personal login is different on purpose: it
signs in inside your own profile, as a sign-in by hand does, so after Forget the
site may stay signed in inside your own browser profile until its cookies
expire. There is no per-site removal: to sign out completely, forget your
browser sign-ins in **Settings → Browser sign-ins**, which signs you out of
every site.

**What this does not cover.** Say it plainly, because for some readers it is
the end of the evaluation.

- **A page that reads its own form fields.** Once the provider has typed a value
  it is on the page, and its documentation says as much: it is *"accessible to
  the page and to an agent with browser/CDP access"*. The `allowedDomains` rule
  decides where a value may be typed, not what a page that receives it then does.
  A host covers its subdomains, and a login is saved for the site's bare host (a
  leading `www.` is dropped), so one saved for a broad host is typed on any of
  its subdomains. For a host whose subdomains belong to different people — a
  shared hosting suffix — that is somebody else's page, and Covan does not keep a
  list of such suffixes, so don't save a login for one.
- **browser-use's own browsing agent.** Covan's model never receives the value;
  the model driving the browser at the provider is another matter. Asking it for
  an alias keeps the value out of the task text, but the provider is explicit
  that aliases *"do not guarantee that the agent cannot see the value: once
  typed, it is accessible to the page and to an agent with browser/CDP access"*.
  Treat what that agent can reach as reachable by a login typed into it.
- **Anything with CDP access to the live browser.** Whoever can drive the browser
  can read what is on its pages. That is the provider's caveat as much as ours,
  and it is why the live view's address is protected as above.
- **The provider itself.** browser-use receives the values in order to type
  them, over TLS, for the run. What it does with them is its own; trusting it
  with a login is the same decision as trusting it with the pages.
- **A saver who stays a member but loses the right.** Whether a shared login is
  still used is decided by membership, not by role: a saver demoted to viewer
  still has theirs bound until it is forgotten.
- **What colleagues see of a shared login in use.** The list shows them only
  its name, but a shared login is there for them to use: anyone who uses the
  agent can have it sign in and act as the account, and can see what the
  browser types and what the account shows in the panel beside their own
  conversation while it does — whatever the site puts on screen, the username
  and the account's own pages included. Covan does not mask a page.
- **Whoever operates this deployment.** The operator holds the service-role key
  and `ROUTINE_SECRET_KEY`, and with both can decrypt every saved login. The
  encryption keeps a login out of a leaked database dump or a misgranted column;
  it does not keep it from the people who run the server. On covan.app that is
  us; on a self-hosted install it is whoever administers it.

**What a hostile page can do with it.** A page can contain text addressed to the
agent reading it, and nobody has solved that. A saved login narrows what such
text can achieve rather than removing it: the value is typed only on the site
the row was saved for, so a page that talks the agent into "sign in at
somewhere-else.example" gets nothing typed there; the model chooses only which
saved site a task needs, and the card names that site and that login before
anything runs; the task is one sentence a person wrote and approved; and a login
wall earns one free retry per task, so nothing can loop. What it does not
narrow is where the browser goes — the provider is explicit that a binding's
domains are *"not a browser-wide navigation or network allowlist"*.

**Two-factor is not solved by this.** The provider's inline bindings carry no
one-time codes, so a site that asks for one, or for an SMS code or a passkey,
still stops at a login wall and needs the person. The save dialog says so.

**The panel hands somebody a live browser, and its address is the whole of the
access.** Whoever holds the live view's URL can see that browser, and the
provider's own instruction for it is *"Treat the URL as a credential"*; Covan
does. It is returned in the response body of a request made by the browser's
owner and nowhere else: not stored in a row, not written to a log, not put in a
message or an error string, and the response says `no-store` so nothing caches
it. It is minted fresh each time the owner's tab asks, which is how a reloaded
tab gets its browser back without the address ever being kept. An API key is
refused those routes: a live view is access that would outlive the key.

**View-only is a restriction of the page, not of the provider** — in the
provider's words, *"View-only embeds are a UI restriction, not a server-enforced
permission."* While the agent drives, the panel is `inert`, and that is a courtesy
to the person watching, not a lock, which is why the address is protected as
above rather than by the frame. The line Covan *does* enforce is that two sets of
hands never share one browser: **Take over cancels the agent's run first**, and
the browser is handed over only once the provider says the run has ended, so a
person is never typing into a field the agent is mid-way through.

**It is the owner's alone.** `browser_sessions` has one policy, the same shape as
the browser tasks': the row is the owner's, and only while they are still a
member of the workspace. A colleague in a shared conversation sees the answers,
which are ordinary messages, and nothing of the browser; asking for its routes
gets the same 404 as asking for something that does not exist. The provider's
identifiers for a session, a browser, a run and a profile are granted to no
client role at all, for the reason `connected_account_id` has: one deployment key
makes each of them the address of something running, possibly signed in as
somebody. A browser somebody took over and never handed back is stopped by a
sweep about ten minutes after their tab stops asking for it (the open tab is the
proof somebody is still there), and one nobody is using about ten minutes after
its last task, because stopping it is what saves their sign-in into their own
profile and ends the billing. Both are floors: the sweep runs every five
minutes. Forgetting the sign-ins refuses while one of these browsers is in use,
and otherwise stops the idle ones and forgets their sessions, so no later task
carries the forgotten cookies.

Every human action in this is still an ordinary policy, because every one of
them is a person changing a row: members see grants, anyone who can write may
create one or take one away, and only an admin may promote a **destructive**
capability to `always` — a standing permission to do something that cannot be
undone is a decision about the workspace rather than about one piece of work.
Lowering or revoking that same grant needs no admin, because taking a permission
away is never the unsafe direction.

The one thing without a policy in front of it is the process that reads these
rows at 3am, which has no caller to have a policy about. It goes through a
single `security definer` function whose EXECUTE grant is the boundary, the same
arrangement the sync scheduler uses. And because that function runs as the
service role — which bypasses row level security entirely — the guarantee that a
grant cannot join an agent in one workspace to a connection in another is a
foreign key rather than a predicate. A policy is no boundary at all against a
caller that does not consult policies.

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
database on its own does not yield them. Saved website logins use the same key
and the same envelope.

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

Your Covan password is never stored. Authentication is Supabase Auth, and what
the database holds is a hash. The one other password in this database is a login
somebody chose to save for a website — encrypted, not hashed, because it has to
be typed again; see [the one place an agent does act](#the-one-place-an-agent-does-act-and-what-it-costs).

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
   secrets and every stored webhook becomes undecryptable noise — and every
   saved website login with it, which the agent then meets as a login wall.
6. **Decide where the model calls go.** Completions and embeddings can each be
   pointed at any OpenAI-compatible endpoint, independently — which is the whole
   answer for anyone who cannot send document text to the United States. See
   [Self-hosting](self-hosting.md).

[Taking it with you](export.md) is the other half of this page: the security
property that matters most in the long run is being able to leave with
everything, and that is a feature rather than a promise.
