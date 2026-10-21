# Quickstart

Covan is an agent a team trains together and talks to separately: everyone adds
to what it knows, and everyone gets their own conversation with it. This is the
path from an empty account on the hosted service at <https://covan.app>
to an answer that names the file it came from.

If you would rather run the whole thing on your own machine, start at
[Self-hosting](self-hosting.md) instead. Everything below is the same once you
are signed in, except the credits described at the end, which a self-hosted
install does not have.

## Create an account

The sign-up form asks for a name, an email address, a password of at least eight
characters, and the same password again. Sign-up talks straight to Supabase
Auth; the Covan API is not in that path at all.

What happens next depends on whether the deployment confirms email addresses. If
sign-up returns a session, you are in the app immediately. If it does not, you
are shown a "Check your email" screen naming the address it went to, and the
confirmation link has to be clicked before you can sign in.

Clicking it brings you back to `/confirmed`, which says so and hands you a way
into the app. That page is the whole point of the link having a destination of
its own: sent to the site's front door instead — which is what Supabase does
when nothing tells it otherwise — a confirmed account and an expired link look
exactly alike, because both of them look like the home page.

Either way, a database trigger gives the new account a profile and a workspace of
its own, named after you — `Alex Rivera's Workspace`. Everything you make from
here on belongs to that workspace.

## The first run

Every new account is sent to `/welcome`, and is sent back there from anywhere
else it tries to go until the first run is finished.

It opens with three questions — what you do, what you will use Covan for, and
how big the team is — followed on the hosted service by a fourth, how you heard
about us, which is the only one you can skip. Each answer is written on its own
as you tap it rather than batched at the end, and an unanswered question beats
any step named in the URL. Between them, that is what makes the flow resumable:
close the tab on question two and you come back to question two.

Then three or four setup screens.

**Name the workspace.** The field is pre-filled with the name the signup trigger
guessed. Leaving it alone is a valid answer and writes nothing.

**Make the first agent.** Name, icon and persona are pre-filled from one of six
templates, chosen by what you answered to "what will you use Covan for". The
persona is the system prompt every conversation with this agent starts from, so
it is worth reading before you continue; **Generate persona** will rewrite it
from the agent's name, and asks for confirmation first because the field already
has something in it. Nothing here is permanent — the agent's Settings tab
carries the same fields, plus the model and the choice between normal and
brainstorm mode — and "I'll do this later" skips the screen entirely.

**Give it something to read.** Shown only if you actually made an agent on the
screen before, because this is where the files are attached to it. Drop one or
more documents in and they go into a bundle named after the agent, attached to
it, ready to be retrieved from. Skipping is a real answer and the next section
covers the same ground at leisure — but an agent with nothing to read answers
out of the model's general knowledge, which is the one thing Covan is not for,
so the first run asks once.

**Invite the team.** Shown only if you said the team is more than one person.
Three rows, none of them required, everyone invited as a member. The addresses
go one at a time, so one that fails does not discard the others. If the
deployment has no mail configured — `RESEND_API_KEY` is optional — the
confirmation says so rather than claiming an email was sent: the invitation is a
row either way, and it is waiting the moment that person signs in with the
address you typed.

If somebody invited you before you signed up, the first run ends differently:
you are shown the invitation to accept instead of being asked to name a
workspace and build an agent, because the workspace you are joining already has
both.

## Give it something to read

The first run offered this once, and everything below is what that screen was a
short version of. An agent has four tabs — Chat, Knowledge, Routines and
Settings. Open **Knowledge**.

Documents are not attached to an agent directly. They go into a **bundle**, a
named group of documents, and the bundle attaches to the agent. That indirection
is the point: one bundle can back several agents at once, and detaching it from
one of them is instant and destroys nothing. So the order is create a bundle,
open it, drop files into it, then flip the switch that attaches it to this agent.
An unattached bundle is invisible to the agent — though not to you: every bundle
in the workspace, attached or not, is on the **Knowledge** page in the sidebar,
which opens any file in any of them and says which agents read each one. Filing
works the way a file explorer does: drag a row onto a bundle, or tick several
and move them together.

That is the deliberate route. The quick one is the conversation: drop a file onto
the chat pane, paste it, or use the paperclip, and it goes into a bundle of the
agent's own — created on the first file and attached straight away, so you can
ask about it in the next message. It is a normal bundle, so anything below about
bundles applies to it too. [Knowledge bundles](knowledge.md#uploading) has the
longer version.

If you do not have anything to drop in yet, the agent's Knowledge tab carries six
starter documents — company overview, product notes, FAQ, how we work, glossary,
meeting notes. Each downloads as a page of headings with a prompt under each,
which you fill in and upload back. [What a document should look
like](knowledge.md#what-a-document-should-look-like) is the reasoning behind
their shape, and applies just as well to a file you write yourself.

Accepted file types are exactly these, up to 100 MB each:

| Extension                                                   | Read by                                                                         |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `.docx`, `.pptx`, `.xlsx`, `.odt`                           | The server: headings, lists, tables, slides and their notes, every sheet as CSV |
| `.doc`, `.ppt`, `.xls` (Office 97-2003)                     | The server: the text, footnotes, slides and their notes, every sheet as CSV     |
| `.md`, `.markdown`, `.txt`, `.csv`, `.tsv`, `.json`, `.xml` | The server, as text — UTF-8, UTF-16 or Windows-1254                             |
| `.html`, `.htm`, `.rtf`                                     | The server, with the markup taken out                                           |
| `.pdf`                                                      | Your browser, before the upload leaves it                                       |

An extension that is not on it is refused with `unsupported file type` before
anything is stored. Images inside a document are not read, and neither is a
scanned PDF with no text layer.

The Office 97-2003 readers get the words out, not the formatting: a `.doc`
comes through as paragraphs with no headings marked, its tables as rows of
tab-separated cells, and a field (a hyperlink, a page number) as what it
shows. Headers, footers and comments are left out. A `.doc` that is really an
RTF file, a web page or a renamed `.docx` — Word will save any of them under
that name — is read as what it is, and so is an `.xls` that is an HTML table.
A file with a password to open it is refused with that reason; remove the
password and upload it again. Word 6 and Word 95 documents, and Excel
workbooks older than Excel 95, are not read: save them as `.docx` or `.xlsx`
first.

A file is indexed after it uploads, not during: the Knowledge tab shows it as
**Queued**, then **Indexing** with a percentage, then **Indexed**. A document
longer than about two million characters is indexed up to that point and shown
as **Partly indexed**.

The PDF row is the one worth understanding, because it is not what the shape of
the system suggests. The server does not parse PDFs at all: its text extractor
returns an empty string for them, because pdf.js does not run reliably on the
Cloudflare Workers runtime. Instead the browser extracts the text as you pick
the file and posts it alongside the upload. The consequence is user-visible: a
PDF with no text layer — a scan, or a page of screenshots — has nothing to
extract, and an upload with no readable text in it is refused rather than stored.
Put it through OCR elsewhere and upload the text.

Indexing happens at upload and is best-effort. If chunking or embedding fails,
the document still exists; it is listed as **Not indexed**, and the refresh
control beside it re-embeds it. On the hosted service, an upload made when the
workspace is out of credits is refused outright rather than stored unindexed —
a document the agent cannot retrieve from looks uploaded and behaves as though
it were never there.

## Ask it something

Open **Chat** and start a session. A session is one conversation, and a new one
is private to you until you share it deliberately. That is the shape of the
whole product: the knowledge is shared, the conversations are not. A brainstorm
session is the exception — it is created shared, because it exists to be worked
on together.

Behind each turn: your message is embedded, and the chunks of the attached
bundles are searched for the six nearest matches with a cosine similarity of at
least 0.25. Anything below that floor is dropped rather than used, because the
nearest passage to an off-topic question is still not a relevant one, and
injecting it into the prompt would present it as evidence. An agent then answers
from its persona alone only if it has nothing to fall back on — no bundle
attached, or nothing in what is attached that yielded any text. One that does
have documents takes the escape hatch below instead.

There is one deliberate escape hatch. If nothing clears the floor but the agent
does have documents, the reply is grounded on their stored text directly, newest
first. That is for "summarise the file" questions, which are close to nothing in
particular and would otherwise get an agent claiming it cannot read a file it
plainly has.

Whatever grounded the reply is listed under **Sources** beneath it, by document
name. Those names are written onto the message when it is saved, so they survive
a reload rather than being recomputed.

Retrieval is best-effort from end to end. If the embedding call or the search
fails, the turn falls back to a persona-only answer instead of failing.

## What it costs, on the hosted service

Every workspace starts with 2,000 free credits, once, and spends them from one
pool that every member shares. Credits are the only unit the app shows: the
balance in the corner, the per-reply price beside each model, Settings → Usage,
all in credits. Everything an agent does is charged in them — the model, the
embeddings behind search and uploads, dictation, a connected-app call, and a
browser task's model, browser time and proxy traffic — at the rate the
[terms](https://covan.app/terms) set. There is no monthly reset: the balance
goes down when your agents work and up when credits are added. An ordinary
reply is a few credits to a few dozen, depending on the model.

Nobody budgets in credits until they have seen what a reply costs, so once
your workspace has sent about ten replies the app converts: under the composer
you get the balance and roughly how many replies it is worth, and once it runs
low that becomes a banner above it. The conversion uses what your workspace's
replies have averaged so far, which is why the figure can move after a long
grounded conversation.

When the balance reaches zero, replies, routines and connected-app calls stop
until credits are added. There is no checkout yet: Settings → Usage has a form
that reaches us, and we add credits by hand.

You never bring a provider key on the hosted service. Covan is the only model
provider there, and every call is paid for from the workspace's credits.

A self-hosted install has no credits at all, because it brings its own provider
keys and whatever it spends is between it and the provider.

## Where to go next

- [Core concepts](concepts.md) — the same words used precisely: what a workspace,
  a bundle, a session and a routine each are, and how they nest.
- [Knowledge bundles](knowledge.md) — the same upload and retrieval path in
  depth: where to draw a bundle's boundary, and how to read an answer that cites
  nothing.
- [Routines](routines.md) — the same agent, on a schedule: point one at a feed
  or a page, say what to do with it, and get the result by email, by Slack, or
  as a signed webhook into whatever you already run — while nobody is watching.
- [Your team](team.md) — invite people, understand what each role can do, and
  connect Slack, email or a webhook so a routine has somewhere to deliver.
- [Retrieval, in detail](architecture.md#retrieval) — chunking, the similarity
  floor, and how the prompt is assembled so the cacheable part stays cacheable.
- [Authorization](architecture.md#authorization-is-postgres) — why one person's
  session is invisible to another, and why that is a row level security policy
  rather than a check in a route.
- [Self-hosting](self-hosting.md) — the same product, on your own machine, with
  one command.
