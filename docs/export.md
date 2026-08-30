# Taking a workspace with you

Settings → **Take it with you** → _Download the archive_. One zip, containing
everything the workspace holds and the SQL to put it back into a Covan you run
yourself.

The point of it is that the README's claim should be checkable by the person the
claim is aimed at. "Self-host it, nothing is held hostage" has always been true
of the licence and of the database — and `pg_dump` is an answer for whoever runs
the server, not for the team using their install. This is the same answer, made
available to the people whose work it is.

## What is in it

```
manifest.json                  what this file is, whose view it holds, what was left out
workspace.sql                  every row, as inserts, in one transaction
restore.sh                     the two commands, in order
data/<table>.json              the same rows as JSON, for reading rather than replaying
documents/<id>-<name>          the original file of every document
data/export-warnings.json      anything that could not be collected
```

The tables: the workspace itself, its members and their profiles, agents and
their personas, knowledge bundles and what they are attached to, documents,
chat sessions and messages, brainstorm ideas, favourites, delivery channels,
routines and their run history.

## What is not, and why

- **Retrieval chunks.** Every chunk carries a 1536-dimension vector, so a
  workspace with ten thousand of them is tens of megabytes of numbers that say
  nothing a human can read — and they are derived. The documents are in the
  archive; `POST /admin/backfill-embeddings` rebuilds the chunks from them after
  a restore, with whatever embedding model the new install is configured for,
  which is more useful than replaying the old one's. See
  [self-hosting](self-hosting.md#keeping-your-documents-off-openai-too).
- **API keys.** A key is not a record of what a workspace holds; it is a way to
  become one of its members. An archive carrying them would be a key store that
  people email to each other.
- **Delivery secrets.** `delivery_channels` comes back with its label and its
  kind, and without a real `secret_ciphertext`. That column is encrypted with
  the install's `ROUTINE_SECRET_KEY` and would be undecryptable noise anywhere
  else — and the export could not read it even if it wanted to, because
  migration 0023 withholds that column from `authenticated`.

  The column is `not null`, so the restore writes a placeholder that is visibly
  not a credential. **Every routine therefore comes back paused**, with the
  reason on its own row: re-enter the channel's credential, then resume it. A
  routine restored still running would fail on a schedule, somewhere nobody is
  looking. Skipping the channels instead was not an option —
  `routines.delivery_channel_id` is `not null` too, so a workspace with any
  routine would have had nothing to restore at all.

- **Invitations, notification preferences and onboarding state.** An invitation
  is an offer to somebody who has not accepted, scoped to an install's tokens.
  The other two follow a person rather than a workspace.

`manifest.json` repeats all of this, so the file explains itself in two years
when nobody remembers this page.

## Whose view it is

An export is a read like any other and goes through your own client, so what is
in it is what you could see by clicking around. **An admin's export and a
member's export are different files.** Somebody else's private chat sessions are
not in your copy, and the manifest says so rather than letting a filename imply
the archive is the whole workspace.

One consequence worth knowing: if a row in your export points at something you
could not see — an idea cited from a message in somebody else's private session
— that reference is dropped rather than left to fail the restore. The manifest's
`droppedReferences` counts each one.

## Putting it back

```sh
unzip covan-acme-2026-08-31.zip -d acme
cd acme
./restore.sh "postgres://..." "<the user id it should belong to>"
```

Or, without the script:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v owner="'<user-id>'" -f workspace.sql
```

`owner` is required and psql stops if it is missing. **Every person in the
original workspace becomes that one account.** Accounts cannot be carried
between installs — there is no id to bring across — and inventing users for
people who did not ask to be recreated would be worse than saying so plainly.
The membership rows collapse to a single admin: the account you named.

Ids are preserved, so the restore is comparable to the export row for row, and
the filenames under `documents/` still match their rows. Every statement is
`on conflict do nothing`, so a restore interrupted half way can simply be run
again.

The same clause has a consequence worth knowing: **restoring into a database
that already holds a row with the same id keeps the row that is already there.**
Usually that is what you want — a delivery channel outlives the workspace it was
added from (migration 0019), so re-restoring in the same install keeps the real
channel with its real secret rather than replacing it with this archive's
stand-in. It also means a restore is not a way to roll a workspace back to an
earlier state: for that, restore into an empty database.

### The documents

`workspace.sql` restores the rows. The files are separate, and where they go
depends on how the target install stores them:

- **Docker / any Node host.** Documents live under `DOCS_DIR`, keyed by the
  `r2_key` column. Copy each file there under its key:

  ```sh
  jq -r '.[] | select(.r2_key) | "\(.id)\t\(.r2_key)"' data/documents.json |
  while IFS=$'\t' read -r id key; do
    dest="$DOCS_DIR/$key"
    mkdir -p "$(dirname "$dest")"
    cp documents/$id-* "$dest"
  done
  ```

- **Cloudflare.** The same keys, in the R2 bucket bound as `DOCS`:

  ```sh
  jq -r '.[] | select(.r2_key) | "\(.id)\t\(.r2_key)"' data/documents.json |
  while IFS=$'\t' read -r id key; do
    npx wrangler r2 object put "covan-docs/$key" --file documents/$id-*
  done
  ```

Skip this step and the workspace restores with documents it lists and cannot
open. `data/export-warnings.json` names anything that was already unreadable at
export time.

### Then rebuild retrieval

```sh
curl -X POST "$API/admin/backfill-embeddings" -H "x-admin-key: $ADMIN_API_KEY"
```

Until that finishes, answers fall back to the agent's persona alone — degraded,
not broken, and exactly what happens today for a document whose upload-time
embedding failed.

## Limits

The archive is built in one request and held in the browser before it is saved,
which is what fetching with a bearer token costs — an `<a href>` carries no
Authorization header. The server streams, so its own memory holds one document
at a time; the ceiling is the browser's.

The zip is written without compression and without Zip64, so it refuses past
4 GB or 65,535 entries rather than emitting an archive whose offsets have
wrapped. If you reach either, the archive is not the tool you want — take a
database backup instead.
