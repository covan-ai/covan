# Quickstart

Covan is an agent a team trains together and talks to separately: everyone adds
to what it knows, and everyone gets their own conversation with it. This is the
path from an empty account on the hosted service at <https://covan.app>
to an answer that names the file it came from.

If you would rather run the whole thing on your own machine, start at
[Self-hosting](self-hosting.md) instead. Everything below is the same once you
are signed in, except the monthly allowance described at the end, which a
self-hosted install does not have.

## Create an account

The sign-up form asks for a name, an email address, a password of at least eight
characters, and the same password again. Sign-up talks straight to Supabase
Auth; the Covan API is not in that path at all.

What happens next depends on whether the deployment confirms email addresses. If
sign-up returns a session, you are in the app immediately. If it does not, you
are shown a "Check your email" screen, and the confirmation link has to be
clicked before you can sign in.

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

Then two or three setup screens.

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

**Invite the team.** Shown only if you said the team is more than one person.
Three rows, none of them required, everyone invited as a member. The addresses
go one at a time, so one that fails does not discard the others.

If somebody invited you before you signed up, the first run ends differently:
you are shown the invitation to accept instead of being asked to name a
workspace and build an agent, because the workspace you are joining already has
both.

## Give it something to read

An agent has four tabs — Chat, Knowledge, Routines and Settings. Open
**Knowledge**.

Documents are not attached to an agent directly. They go into a **bundle**, a
named group of documents, and the bundle attaches to the agent. That indirection
is the point: one bundle can back several agents at once, and detaching it from
one of them is instant and destroys nothing. So the order is create a bundle,
select it, drop files into it, then flip the switch that attaches it to this
agent. An unattached bundle is invisible to the agent.

Accepted file types are exactly these, up to 10 MB each:

| Extension               | Read by                                   |
| ----------------------- | ----------------------------------------- |
| `.md`, `.markdown`      | The server, decoded as UTF-8 text         |
| `.txt`, `.csv`, `.json` | The server, decoded as UTF-8 text         |
| `.pdf`                  | Your browser, before the upload leaves it |

There is no DOCX on that list, which is the assumption most people arrive with.
An extension that is not on it is refused with `unsupported file type` before
anything is stored. The list is short because there is no format-specific parser
on the server at all: everything other than a PDF is decoded as UTF-8 text and
indexed as it comes out.

The PDF row is the one worth understanding, because it is not what the shape of
the system suggests. The server does not parse PDFs at all: its text extractor
returns an empty string for them, because pdf.js does not run reliably on the
Cloudflare Workers runtime. Instead the browser extracts the text as you pick
the file and posts it alongside the upload. The consequence is user-visible: a
PDF with no text layer — a scan, or a page of screenshots — uploads fine and
downloads fine, but there is nothing to extract and therefore nothing to index,
and the agent cannot retrieve from it.

Indexing happens at upload and is best-effort. If chunking or embedding fails,
the document still exists; it is listed as **Not indexed**, and the refresh
control beside it re-embeds it. On the hosted service, an upload made when the
month's allowance is already spent is refused outright rather than stored
unindexed — a document the agent cannot retrieve from looks uploaded and behaves
as though it were never there.

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

Each reply is metered against a monthly token allowance, counted per user, and
the counter resets at the start of the next UTC month. Nobody budgets in tokens,
so the app converts it: under the composer you get roughly how many replies are
left, and once you are close to the end that becomes a banner above it, with the
date the allowance comes back. The conversion uses what your own replies have
averaged so far, which is why the figure can move after a long grounded
conversation — before you have sent anything there is no average to use, and it
assumes a middling one.

A self-hosted install has no allowance and no counter, because it brings its own
OpenAI key and whatever it spends is between it and OpenAI.

## Where to go next

- [Core concepts](concepts.md) — the same words used precisely: what a workspace,
  a bundle, a session and a routine each are, and how they nest.
- [Knowledge bundles](knowledge.md) — the same upload and retrieval path in
  depth: where to draw a bundle's boundary, and how to read an answer that cites
  nothing.
- [Routines](routines.md) — the same agent, on a schedule: point one at a feed
  or a page, say what to do with it, and get the result by email or Slack
  while nobody is watching.
- [Your team](team.md) — invite people, understand what each role can do, and
  connect Slack or email so a routine has somewhere to deliver.
- [Retrieval, in detail](architecture.md#retrieval) — chunking, the similarity
  floor, and how the prompt is assembled so the cacheable part stays cacheable.
- [Authorization](architecture.md#authorization-is-postgres) — why one person's
  session is invisible to another, and why that is a row level security policy
  rather than a check in a route.
- [Self-hosting](self-hosting.md) — the same product, on your own machine, with
  one command.
