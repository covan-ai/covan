# Your team

A workspace is the boundary everything hangs off: the agents, what they know, and
the people who can reach them. This page is about the people — how somebody
joins, what a role does and does not govern, what changes when a conversation is
shared, where a routine's output goes, and what is actually removed when a person
or a whole workspace is deleted.

[Core concepts](concepts.md#member) defines a membership against the schema. This
page assumes that and goes after the consequences. All of it is read off the
policies in `supabase/migrations/` rather than off the screens, because those are
what decide who can do what — see
[Authorization](architecture.md#authorization-is-postgres) — and in more than one
place, noted where it comes up, a screen says something the database does not.

## Inviting somebody

An invitation is a row in `invitations`: a workspace, an email address, a role,
who sent it, and a status of `pending`, `accepted` or `revoked`. Only an admin
can create one. The insert policy asks two things — that the caller is an admin
of that workspace, and that `invited_by` is the caller — so a member cannot
invite anybody, and nobody can post an invitation with somebody else's name on
it. The address is lowercased before it is stored.

**The email is a courtesy, and the row is the invitation.** After the row is
written, the API emails the invitee through the same Resend account routine
deliveries use — naming who invited them, which workspace, and which address to
sign in with. It deliberately carries no link that accepts anything: acceptance
is matched against the address, so a token in a URL would be a second and weaker
key to the same door.

If that email fails, or if the deployment has no `RESEND_API_KEY` and
`RESEND_FROM` — a supported configuration, not a broken one — the invitation
still stands, and the response says `emailed: false`. Both surfaces that invite
then say the person is invited and ask you to tell them, rather than claiming a
message went out. They used to say "Invite sent" unconditionally, in a product
that had never sent one.

Both, now, because the fix landed in only one of them at first. The dialog on
this page learned to read `emailed`; the three rows in the first run did not,
and went on reporting "3 invitations sent" to people running an install with no
mail at all. The sentence is now decided in one place for both of them.

**"Tell them" comes with the words.** When nothing was emailed, the notice
carries a *Copy invite text* action, and every waiting invitation on this page
has a *Copy invite* button of its own — the durable version, for whenever the
notice is long gone. What you get is a short message naming your Covan's address
and the one address that will work:

> You've been invited to Covan — a shared AI agent our team trains together.
> Sign up at `https://covan.app/sign-up` with `ali@example.com` and the
> invitation will be waiting.

The URL is the front door, not a key. It carries no token and does not pre-fill
the address, for the reason above and one more: a link that fills the field in
gets forwarded in place of the address, and then somebody signs up as themselves
and cannot see why nothing is waiting. Naming the address in prose keeps it
visibly the thing that matters. Self-hosted installs get their own origin in
that sentence, so it reads `http://localhost:3000/sign-up` where that is true.

The button is offered whether or not the email went out, because this list
cannot tell: `emailed` is only ever known about the invitation you have just
created, nothing stores it, and a second nudge is a normal thing to send anyway.
For the same reason a waiting invitation says when it was sent rather than
claiming an email reached anyone.

### What the invitee sees

When that person signs in with the address the invitation names, two places offer
it. A banner sits above the app with the workspace's name and the role, and a
new account meets the same invitation as a step in the welcome flow instead —
somebody who was invited already has a workspace waiting, so walking them through
furnishing another one they are about to abandon would be the wrong order.

Accepting runs `accept_invitation()`, a `SECURITY DEFINER` function, because the
person accepting is by definition not yet a member and no policy would let them
insert their own membership row. It compares the invitation's address with the
one in their token, case-insensitively, and refuses if they differ. That is the
whole authentication of an invitation: it is bound to an address, not to a link
or a token, so signing up with a different address — a personal Gmail where the
invitation went to a work domain — produces an account that cannot see it.

On success it inserts the membership with the role the invitation carried,
stamps the invitation `accepted` with the time and the person, and switches their
active workspace to the one they just joined. They keep the personal workspace
their signup created; a person can be in as many workspaces as they are invited
to, and `profiles.active_workspace_id` records which one they are looking at.

### Pending, revoked, re-invited

A unique index allows one _pending_ invitation per workspace and address.
Inviting the same address twice answers with a conflict rather than a second row.
Accepted and revoked rows are excluded from that index, which is what makes
re-inviting somebody later possible.

Revoking is a hard delete, and only an admin can do it. An accepted invitation is
not deleted — it stays as the record of who joined, when, and who let them in.

## What a role actually governs

The role column takes three values. The first admin is made by the signup
trigger, which gives every new account a workspace and an admin membership in
it; `create_workspace()` does the same for any workspace somebody makes later.

| Role     | Runs the workspace | Changes shared things | Uses the agents |
| -------- | ------------------ | --------------------- | --------------- |
| `admin`  | yes                | yes                   | yes             |
| `member` | no                 | yes                   | yes             |
| `viewer` | no                 | no                    | yes             |

**Admin** governs two things and no more:

- **The workspace row.** Its name, its slug and its default model. One policy,
  `workspaces_update_admin`, covers all three, which is why the same people who
  can rename a workspace can set where its model picker starts.
- **The people in it.** Creating and revoking invitations, changing a role, and
  removing a member — the invitation policies plus
  `workspace_members_update_admin` and `workspace_members_delete_admin`.

**Everything a workspace shares** — `agents`, `knowledge_bundles`, `documents`,
`agent_bundles` and `document_chunks` — asks `can_write_in_workspace()`, which
is a membership check plus `role <> 'viewer'`. So a member can create an agent,
rewrite another agent's persona, change its model, upload to any bundle, detach
a bundle, and delete any agent, bundle or document in the workspace, with no
approval anywhere in the path. That is deliberate — the product's claim is that
a team trains one agent together — but it is worth knowing how large it is: the
cascades mean deleting an agent takes every session anybody ever had with it,
every message in those sessions and every routine pointed at it, and deleting a
bundle takes its documents and their embeddings. None of it is recoverable from
inside the product. A `viewer` is refused all of it.

**Everything that is yours** asks only whether you are a member: your own
sessions, messages, brainstorm ideas, routines, delivery channels, favourites
and notification preferences are keyed to your user id, and no role gates them.
That is why a viewer can chat with every agent in the workspace and share a
session with it, and why a viewer is a usable seat rather than a login with
nothing behind it.

Until `0021` there was no third role and no policy on a shared table looked at
`role` at all, while the Team screen rendered `member` as the role that could
not change things. On the only question people ask of a role — can this person
destroy our work — the screen was wrong. It says the true thing now, and the
chip's colour answers "can this person change things" rather than naming one
role, which is what DESIGN.md §7.8 asked for all along.

### The last admin

A trigger refuses to remove or demote a workspace's last admin, whoever asks and
however they ask. It is the only thing that does: no route checks first, so what
reaches the interface is the trigger's own refusal, mapped to a 400. A workspace
therefore cannot be left with nobody able to administer it. The same
trigger has one exception, and it is deliberate: when the membership row is
disappearing because the _workspace_ is being deleted, the workspace it is
protecting no longer exists by the time the trigger runs, and it stands aside.

## Sharing a conversation

A session is private to the person who started it, and sharing is a switch on
that session with two positions. A brainstorm session is the exception: it is
created shared, because a brainstorm exists to be worked on together.

Sharing widens reads and nothing else. The select policy admits the owner, plus
any member of the workspace once visibility is `shared`; insert, update and
delete on the session stay owner-only. So a colleague reading your shared session
cannot rename it, un-share it or delete it, and the private sessions of everybody
else stay invisible whatever their role — there is no admin override, because no
policy on `chat_sessions` mentions `role`.

What a colleague _can_ do is write in it. The message insert policy admits anyone
who can see the session, provided the row carries their own user id as
`sender_id`, so every human message in a shared session names the person who
wrote it. Their reply drives the agent as yours would; a small `SECURITY DEFINER`
function exists solely so a non-owner's message can still bump the session's
`updated_at`, which the owner-only update policy would otherwise refuse.

What a colleague cannot do is **Edit**. `messages_update_owner` is keyed to the
parent session's owner rather than to whoever wrote the message, so in a shared
session only the owner may edit — including on their own messages, if the
session is somebody else's. The chat used to offer the control anyway, because
it decided to draw it from the message's role rather than from who owns the
session, and it answered 404 wherever it was not the owner's. It now asks the
second question. Editing is also more than it looks: it discards every reply
after the edited turn and re-runs the agent, which is not something to offer
over somebody else's conversation even if a policy allowed it.

The policy also requires `role = 'user'` on anything a client writes
(`0018_message_authorship.sql`), so a member cannot put words into a shared
session that render as the agent's. That matters because PostgREST is reachable
directly with the anon key that ships in the browser bundle, so it is the
policy and not `POST /messages` that has to hold the line: the API was already
accepting only `role: "user"`, and the API was never the thing an attacker
would use.

### Brainstorm boards

A brainstorm session gains an idea board: `ideas` rows scoped to that session.
All four policies on the table defer to the parent session's visibility, so
anyone who can read the session can add, edit, move and delete cards on it —
including cards somebody else wrote. Only the attribution is pinned: the insert
policy requires `created_by` to be the caller, so a card cannot be filed under
another person's name.

### Usage figures are yours alone

The usage breakdown on Settings counts your conversations and nobody else's.
`workspace_usage` still lists every agent in the workspace — at zero for ones
you have not used — but the tokens against each are yours.

That took a correction. The function runs as the caller, and `0006` relied on
that alone: sessions were private per user, so the select policy did the
scoping and the query never said whose rows it wanted. Then `0008` added shared
sessions, the policy widened underneath it, and the totals silently began
including colleagues' conversations — while the screen went on saying "Yours
alone". Brainstorms are created shared, so a team that brainstorms was affected
by default. `0022` moved the scoping into the join, where a later policy change
cannot move it.

`0025` had to drop and recreate the function rather than replace it — it added
two columns, and Postgres will not let `create or replace` change a return type
— so the `s.user_id = auth.uid()` join condition was carried across deliberately
rather than by inheritance. The two new sums are inside that same scoped join,
and the grants the drop removed are restored in the same file.

There is still no workspace-wide view: nobody sees what a colleague spends.

The figures also now account for prompt caching. Most of what Covan sends the
model on any given turn is the same bytes as last turn — the persona, the
document manifest, the conversation so far — so `chat.ts` assembles the prompt
with that stable part first and the retrieved knowledge after it, and OpenAI
serves the repeat at a reduced rate. The share that came from the cache is
recorded per reply and priced accordingly, which makes the estimate lower and
truer than it was, and makes a change that quietly breaks the arrangement
visible instead of merely expensive.

## Where the work gets delivered

A delivery channel is a Slack incoming webhook or an email address, created on
Settings, that [routines](routines.md) post their results to. What belongs on
this page is who it belongs to: **a channel is yours, not the workspace's.** The
select policy on `delivery_channels` returns only rows whose `user_id` is the
caller, so a colleague cannot see, use or delete a channel you added, and cannot
see that it exists. Sharing a routine with the workspace shares what it does and
what it sent, never where it goes.

The secret itself never comes back out. Row level security is row-level and
cannot hide a column, so the table's blanket grant to `authenticated` is revoked
and every column except the ciphertext handed back; what the interface shows is a
mask computed once when the channel was created. Creating one is the one write
that needs the service role, because the secret has to be encrypted before the
row exists. [Delivery](routines.md#delivery) covers the sending, and
[the secret you hand it](routines.md#the-secret-you-hand-it) covers the
encryption.

One detail belongs to the person rather than the routine: a channel is filed
under whichever workspace was active when it was created, and it stays there. A
routine may point at any channel belonging to its own owner, so a channel created
in one workspace can back a routine in another. Keeping a channel in the
workspace whose routines use it is the arrangement the schema expects.

Which notices the engine sends you — a routine pausing itself, a run skipped for
a spent allowance — is also yours alone, a row in `notification_preferences` with
your user id as its primary key. A missing row means everything is on, which is
why turning a notice off is an update rather than a delete.

## Removing a member

Only an admin can remove somebody: the delete policy on `workspace_members` is
admin-only, and the last-admin trigger still refuses if that person is the only
admin left. Removal deletes exactly one row — the membership — and everything
that follows from that is the policies re-evaluating.

### Leaving

Anybody can leave a workspace on their own. `workspace_members_delete_self`
(`0020`) permits exactly one row — yours — and `DELETE /workspace/members/me`
resolves the caller from the session, so the route cannot be pointed at anybody
else. On the Team screen it is on your own row.

Two things refuse it, both of them said in the dialog before the button is
pressed rather than after:

- **You are the only admin.** `trg_prevent_last_admin` refuses to leave a
  surviving workspace without one, whoever asks and however they ask. Hand the
  role over first. That was left open as a product question when `0016` made
  workspaces deletable; the answer is to block, rather than to promote somebody
  who never agreed to it or to delete a workspace other people are still using.
- **It is your only workspace.** Refused by the route, not the database, because
  it is not a rule about the workspace — it is about having somewhere to be
  afterwards. Everyone starts as the sole admin of their own, so reaching this
  means having handed that one over.

Leaving takes away exactly what removal takes away, described below; the
difference is only who asked.

### What removal takes away

Access, immediately and everywhere it was gated on membership: agents, bundles,
documents, chunks, and every shared session and shared routine in that workspace
stop being readable. Every one of those policies asks the same question — bundles,
documents, chunks and attachments through the `is_workspace_member` helper,
`agents` through an equivalent `exists` written out in full — and the answer has
just changed. Their active workspace falls back to their oldest remaining
membership the next time the API resolves it.

Their name and avatar may also stop resolving for the people left behind. The
profiles policy shows a profile to anyone who shares _any_ workspace with it, so
this only bites when the workspace they were removed from was the last one they
had in common: then their past messages in a shared session keep their text and
quietly lose their attribution line. Share another workspace with them and
nothing changes.

### What removal leaves behind

More than the word "remove" suggests:

- **What they made stays, with their name on it.** Agents, bundles and idea cards
  are workspace-owned, and their `created_by` is attribution rather than
  ownership, so removing a membership does not touch it. A document has no such
  column at all — the table never recorded who uploaded a file.
- **Their shared sessions stay readable to the workspace.** The shared branch of
  the select policy tests the _reader's_ membership, not the owner's, so a
  conversation somebody shared before they left goes on being visible to everyone
  who is still there.
- **Their own sessions still exist, and stop being readable.** `chat_sessions`
  keys off `auth.users` and carries no membership foreign key, so nothing about
  it cascades and the rows survive removal untouched. Reaching them is another
  matter: since `0031` every policy on `chat_sessions`, `messages` and `ideas`
  requires membership of the workspace before it asks who owns the row, so a
  conversation in a workspace somebody has left is refused however they come at
  it — the workspace-scoped list, a bookmarked session id, an open tab, or a
  PATCH straight to PostgREST. The questions in it were theirs; the answers were
  grounded in the workspace's knowledge bundles, and leaving the transcript
  readable would leave a readable copy of what those documents said. Nothing is
  destroyed, and re-inviting them brings all of it back.
- **Their routines stop at the next tick, not at the moment of removal.** The
  engine holds a service-role client that row level security does not constrain,
  so it re-checks the owner's membership before every single run and pauses the
  routine with a recorded reason when it has gone. Until that tick arrives the
  routine is still scheduled. The owner is deliberately not notified — see
  [runs that send nothing](routines.md#runs-that-send-nothing). The routine row
  itself stays readable to its owner: `routines_select_visible` keeps the plain
  owner branch that `0031` closed on sessions, because the recorded pause reason
  is the only explanation they will ever be given, and a routine that vanished
  would be indistinguishable from one that quietly stopped working. There is
  nothing of the workspace's in it — the instruction is theirs, and
  `routine_runs` records counts and status, never content.
- **Their delivery channels survive** — they were never the workspace's to take.

Re-inviting the person gives all of it back, because none of it was destroyed.
The one thing that does not resume itself is a routine the engine paused: the
pause outlives the rejoining, and only its owner can clear it.

## Deleting a workspace

Not from the app. `workspaces` has select, update and insert policies and no
delete policy at all, and no route anywhere calls for one, so there is no request
any account can make that removes a workspace. It is an operator action, taken
against the database, and the migration that made it possible says why it went
unnoticed for so long: the first person to need it would have been somebody
exercising a legal right to erasure.

Two of the references to a workspace do not cascade. `chat_sessions.workspace_id`
and `ideas.workspace_id` were both added after the original schema and are plain
references, so the tested procedure clears those two tables for the workspace
first and then deletes the workspace row. A third,
`profiles.active_workspace_id`, sets itself to null, which is the same state a
fresh account is in and resolves to the person's oldest remaining membership.

What goes with it is everything that hangs off it, directly or through something
that does: memberships, agents, and through the agents every session, message and
favourite; bundles, and through them documents, chunks and agent attachments;
invitations, whatever their status; routines, their run history and their
delivery records; and the delivery channels filed under that workspace.

One thing the application does not do, and an operator should know it. The
cascade is a database cascade, and the uploaded files themselves live in object
storage under the key on each `documents` row. Deleting a single document removes
its object; deleting a bundle, an agent or a workspace deletes the rows that
named those keys and nothing in Covan touches the store. Whether those objects
are then cleaned up is a question about the storage itself — a lifecycle rule on
the bucket, or a sweep somebody runs — not one this codebase answers. If it is
the latter, collect the keys before the rows go, because afterwards there is
nothing left to enumerate them by.

What survives is the people. Deleting a workspace deletes no accounts, and the
last-admin trigger stands aside for exactly this case rather than blocking it —
a membership whose workspace is already gone is debris, and there is nothing left
to leave un-owned.

## Deleting a person

There is no route for this either, and the same operator path applies. The schema
draws one line through it, and it is worth knowing which side a thing falls on.
Six columns record who _made_ something — the `created_by` on workspaces, agents,
bundles and ideas, and both of the who-did-this columns on invitations. All six
null out. A workspace does not evaporate because the person who opened it left,
and a shared agent does not vanish because its author closed their account; the
row stays and the name drops off it.

Everything that was theirs alone goes: their profile, their own sessions and the
messages in them, their favourites, their delivery channels, their routines,
their notification preferences. A private conversation has no meaning without its
person.

One case is refused, and it is refused on purpose.

**The last admin of a surviving workspace.** Somebody who is the only admin of a
workspace that still exists cannot be deleted, because the cascade into
`workspace_members` meets the guard. Whether that should promote the oldest
remaining member, block until the role is handed over, or take the workspace with
it is a product question that has not been answered, and answering it in the
schema would be answering it by accident. Deleting or handing over the workspace
first is the way through.

What a departing account leaves behind, in somebody else's session, is its
words without its name. `messages.sender_id` nulls on delete
(`0018_message_authorship.sql`), the same way the six attribution columns
already did. The alternative — cascading — would have deleted that person's
lines out of conversations belonging to people who are still here, which is a
strange price for one person's erasure. So a shared conversation keeps every
line of it, and the ones written by someone who has gone simply appear
unattributed.

For a while this was not a choice but an omission: the reference declared no
delete behaviour at all, which in Postgres means the strict one, so a single
message in a colleague's shared session made an account undeletable. Nothing
caught it, because no deletion test had one person write into another's
session. `tests/rls/message-authorship.test.ts` is the test that would have.

## Where to go next

- [Core concepts](concepts.md#member) — memberships, sessions and routines
  defined against the tables they live in.
- [Routines](routines.md) — the scheduling and delivery this page only touches at
  the edges.
- [Knowledge bundles](knowledge.md) — what everybody in the workspace, both roles
  alike, can add to and take away.
- [Authorization](architecture.md#authorization-is-postgres) — why the policies
  are the specification and the screens are a view of it.
