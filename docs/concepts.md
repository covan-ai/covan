# Core concepts

Covan is a shared agent for a team: everyone adds to what it knows, and everyone
gets their own conversation with it. Eight nouns carry that idea, and the rest of
the documentation is written in terms of them. This page defines each one and
says how it nests inside the next.

The definitions come from the schema rather than from the screens. A table and
its foreign keys are what an object _is_; a screen is one view of it, and the two
can drift. Everything below can be read back off the numbered files in
`supabase/migrations/`, which are also where the answer to "who can see this?"
lives — see [Authorization](architecture.md#authorization-is-postgres).

## The shape, in one table

| Object           | Table               | Hangs off              | Visible to                                |
| ---------------- | ------------------- | ---------------------- | ----------------------------------------- |
| Workspace        | `workspaces`        | —                      | its members                               |
| Member           | `workspace_members` | a workspace and a user | fellow members of that workspace          |
| Agent            | `agents`            | `workspace_id`         | everyone in the workspace                 |
| Knowledge bundle | `knowledge_bundles` | `workspace_id`         | everyone in the workspace                 |
| Document         | `documents`         | `bundle_id`            | everyone in the workspace                 |
| Session          | `chat_sessions`     | `agent_id`, `user_id`  | its owner, plus the workspace once shared |
| Message          | `messages`          | `session_id`           | whoever can see the parent session        |
| Routine          | `routines`          | `agent_id`, `user_id`  | its owner, plus the workspace once shared |

A persona is not in that list because it is not an object: it is a column on the
agent. Neither is a bundle's attachment to an agent, which is a row in a join
table rather than a foreign key on either side.

Read the table as a rule of thumb and the rest of this page as the detail. The
line it draws is the one the product is built around: **what the agent knows is
shared, and the conversations people have with it are not.**

## Workspace

A workspace is the tenancy boundary. Agents and bundles hang off it directly,
documents hang off a bundle, and sessions and routines hang off an agent, so
everything in the product traces back to exactly one workspace. Every one of
those foreign keys cascades on delete, which is why nothing is left stranded when
something above it goes.

Every account gets one without asking. A trigger on `auth.users` creates a
profile, a workspace named after the person — `Alex Rivera's Workspace` — and an
admin membership for them, in the same transaction as the signup. A person can
end up in several workspaces by being invited to one or by creating another, and
`profiles.active_workspace_id` records which one they are currently in. When that
column is null, or names a workspace they have since left, the API falls back to
their oldest membership and quietly writes that back.

A workspace carries one setting of its own so far: `default_model`, which decides
only where the model picker starts for new agents. Every agent still chooses its
own.

## Member

A membership is a row in `workspace_members`: a workspace, a user, and a role
of `admin`, `member` or `viewer`. The pair is the primary key, so a person is
in a workspace once or not at all. There is no general insert policy on that
table — rows appear only through the signup trigger, through
`accept_invitation()` when somebody takes up an invitation addressed to their
email, and through `create_workspace()`. All three are `SECURITY DEFINER`
functions, which is what lets a person who is not yet a member join one.

The role draws two lines, not one. An admin administers the workspace itself —
renames it, sets its default model, and invites, revokes, promotes, demotes and
removes people. Separately, `can_write_in_workspace()` decides who may change
what the workspace SHARES: admins and members may create, edit and delete
agents, bundles and documents; a viewer may not. Nobody's role gates their own
sessions, messages, ideas or routines, which is why a viewer can still use every
agent. A trigger refuses to remove or demote a workspace's last admin no matter
who asks, so a workspace cannot be left with nobody able to manage it. See
[Team](team.md) for the whole table.

What invite, revoke, promote and remove look like as screens in the product —
including what happens to someone's work when they leave — is in
[Your team](team.md).

## Agent

An agent is the thing the team trains and talks to: a name, an emoji, a persona,
a model and a mode, on a row that belongs to a workspace. It is shared by
construction — there is no owner column that grants anything, so every member of
the workspace sees the same agent and can edit it.

The model is one of four OpenAI ids (`gpt-4o`, `gpt-4o-mini`, `gpt-4.1`,
`gpt-4.1-mini`); anything the API does not recognise resolves to `gpt-4o`, which
is what keeps an agent created against an older list working. The mode is
`normal` or `brainstorm`, and brainstorm layers a facilitation instruction block
on top of the persona rather than replacing it.

## Persona

The persona is the system prompt every conversation with an agent starts from. It
is a column on the agent, which is why changing it changes every session at once,
including sessions that are already underway. An agent with no persona falls back
to a single sentence: "You are a helpful AI assistant for a team workspace."

What actually reaches the model is a prefix assembled in a fixed order — the
persona, then the brainstorm instructions if the mode calls for them, then a
manifest naming the documents the agent has. Passages retrieved for the current
question are deliberately not merged into it; they are sent as a separate system
message further down. That keeps the prefix byte-identical from one turn to the
next, which is the condition OpenAI's automatic prompt caching needs in order to
discount it. See [retrieval](architecture.md#retrieval) for how the rest of the
prompt is built.

## Knowledge bundle

A bundle is a named group of documents. It belongs to the workspace, not to an
agent, and it reaches agents through `agent_bundles` — a join table keyed on the
pair, so the relationship is many-to-many in both directions. One bundle can back
several agents, and one agent can draw on several bundles.

That indirection is the point rather than an accident of the schema. Attaching
and detaching are each a single row, so a bundle can be handed to a second agent
without copying anything and taken back without destroying anything. It also
decides what retrieval can reach: `match_chunks` restricts itself to chunks whose
bundle is attached to the agent being asked, so a bundle nobody has attached is
unreachable by every agent in the workspace, however much is in it. It is still
listed for every member — it is retrieval that cannot see it, not the workspace.

## Document

A document is one file in one bundle. `bundle_id` is `not null`, so there is no
such thing as a document outside a bundle; deleting the bundle takes its
documents with it. The row holds the name, the size, the key the bytes are stored
under in the document store, and an excerpt of the extracted text — the first
8000 characters — kept alongside for the fallback described in
[retrieval](architecture.md#retrieval).

The searchable form is separate. At upload the text is split into chunks of up to
1000 characters with roughly 150 characters of overlap, and each chunk is
embedded with `text-embedding-3-small` and stored as a `vector(1536)` in
`document_chunks`. That step is best-effort: if chunking or embedding fails the
document still exists, and it stays unindexed until somebody re-embeds it. The
accepted file types and the reason PDFs are handled in the browser are in the
[Quickstart](quickstart.md).

## Session

A session is one conversation, with one agent, owned by one person. The row
carries `agent_id`, `user_id` and `workspace_id`; messages hang off it by
`session_id`, and a message written by a person records who wrote it. A session
also has a kind — `chat` or `brainstorm` — and a brainstorm session gains an idea
board: `ideas` rows scoped to that session, which anyone who can see the session
can add to, move and remove.

### Private and shared

Visibility is `private` or `shared`, and a new session is private. The one
exception is a brainstorm session, which is created shared, because a
brainstorm exists to be worked on together.

Sharing widens reads and nothing else. The select policy admits the owner, plus
any member of the workspace once visibility is `shared`; insert, update and
delete stay owner-only. So a colleague reading your shared session cannot rename
it, un-share it or delete it. They can write in it: a member who can see a
session may add a message, provided the message is stamped with their own user id
as `sender_id`. The agent's own replies are written by the server, which is the
only actor holding a client that can write them without being attributed to a
person.

## Private is a policy, not a check

One person's private session is invisible to another because Postgres refuses to
return the row, not because a route in the API remembered to compare two ids.

The mechanism is row level security. For every ordinary request the API builds a
Supabase client from the _anon_ key with the caller's own access token attached,
so `auth.uid()` inside the database resolves to that caller and every policy in
`supabase/migrations/` applies to every query the route makes. The policy that
does the work here is `chat_sessions_select_owner_or_shared`:

```sql
create policy "chat_sessions_select_owner_or_shared"
  on public.chat_sessions for select
  using (
    public.is_workspace_member(workspace_id)
    and (user_id = auth.uid() or visibility = 'shared')
  );
```

Read it in that order, because the order is the rule: membership first and
unconditionally, then ownership to decide which member. Being the person who
opened a session is not on its own a reason to be shown it — the answers in it
came from the workspace's knowledge, so access to it ends when membership does.
Until `0031` the first branch stood alone and it did not.

Messages do not repeat that rule and neither do idea cards; both defer to
`session_is_visible`, which holds the expression above once, so a message is
readable exactly when its session is.

What this guarantees is narrow and worth stating exactly: a `select` carrying
another person's token returns no row for a private session that is not theirs,
and the update and delete policies on the same table are owner-only in their own
right, so nothing can be written to it either. The guarantee holds whether or not
the route filtered. `DELETE /sessions/:id` contains no ownership check
whatsoever — it deletes by id and reports success — and the policy is the only
reason that aiming it at somebody else's session changes nothing.

What it does not guarantee is worth being equally exact about. Row level security
is row-level: it cannot hide a _column_, and where a column has to stay invisible
the schema uses column grants instead — `delivery_channels` hands `authenticated`
every column except the encrypted secret. And the service role bypasses policies
entirely. Three places in the shared codebase reach for it, each because a
request-scoped client cannot do the job: writing the agent's replies, encrypting
a delivery secret on the way in, and running routines from a cron tick that has
no caller and therefore no `auth.uid()`. The hosted service adds a fourth for its
token meter, whose counter is readable by the person it belongs to and writable
by nobody, because a user who could write their own counter could reset it. The
three are listed and justified in
[Authorization](architecture.md#authorization-is-postgres), and a test pins every
call site so a new one cannot appear quietly. Private therefore
means private from other accounts on the same deployment. It is not a claim about
whoever administers the database.

## Routine

A routine is a standing order attached to an agent: a source (an RSS feed, a web
page, or nothing at all), an instruction in plain language, a cron expression
with a timezone, and a delivery channel — a Slack webhook or an email address.
The engine wakes up, asks the database which routines are due, runs them and
delivers the result.

A routine belongs to a workspace and an agent, but it is owned by the person who
made it, and it follows the same visibility rule as a session: private by
default, shared to the workspace when the owner says so, and modifiable only by
the owner either way. Its delivery channel is stricter still — a routine may only
point at a channel belonging to its own creator, enforced in the insert and
update policies rather than left to the API, because the foreign key alone is
checked by the system and the system does not consult RLS.

Each run records what it did, including the summary it sent, so "what did it send
me last Tuesday?" has an answer inside the product. The engine deliberately
stores no source content beyond fingerprints: a feed a workspace watches is never
mirrored into the database. The scheduling side — claiming, retries, and why a
routine pauses itself — is in [Routines](architecture.md#routines).

## Where to go next

- [Quickstart](quickstart.md) — the same objects in the order you meet them, from
  an empty account to an answer with its sources attached.
- [Architecture](architecture.md) — how a request gets from a browser to a row,
  and the two seams that let one codebase run on two runtimes.
- [Self-hosting](self-hosting.md) — all of the above on your own machine, with
  one command.
