# The API

Everything the interface does, it does through one HTTP API. There is no private
back channel and no second set of endpoints: the web app is a client, and so is
anything you write. This page is about reaching it from somewhere that cannot
sign in — a script, a scheduled job, another service.

## Getting a key

Settings → **API keys** → **New key**. Give it a name you will recognise later,
and copy the key when it is shown. It is shown once. Covan stores a SHA-256 hash
of it and nothing else, so there is no screen — and no support request — that can
produce it again. If you lose one, revoke it and make another.

A key looks like this:

```
covan_sk_KJ8vQ2mR7tXbN4pL9wYcZ3aH6dF1sG5e
```

The `covan_sk_` prefix is not decoration. It is how the API tells a key from a
session token without parsing either, and it is what a secret scanner matches on
if the key ends up somewhere it should not.

If the section is not in your Settings, this deployment has no API keys: minting
requires the project's JWT signing secret, and an operator who has not set
`SUPABASE_JWT_SECRET` has not turned the feature on. See
[Self-hosting](self-hosting.md).

## What a key can do

**Exactly what you can do.** There are no scopes to choose, and that is a design
decision rather than an omission.

Authorization in Covan lives in Postgres — see
[Architecture](architecture.md#authorization-is-postgres) — where every policy
gates on `auth.uid()`. So the API does not check a key against a permission list.
It looks the key up, mints a sixty-second token for the person who owns it, and
makes the request as them. Postgres cannot tell your script from your browser,
and every policy that would have applied to you still applies. A viewer's key can
read and not write, because a viewer can read and not write.

Scopes would be a second permission system standing next to that one, and two
systems that disagree about the same question are worse than one. What a key
gives up in granularity it gains in there being nothing to get wrong.

Three things a key cannot do, each by explicit refusal:

- **Create another key.** Otherwise a leaked key writes itself permanent
  successors and revoking the original achieves nothing.
- **Revoke a key.** Otherwise a leaked key takes down the keys you are relying
  on.
- **Close the account.** Otherwise a leaked key ends the account it came from in
  one call, destroying the evidence and the account together, and no revocation
  afterwards can undo it.

All three need a signed-in session. Everything else is open to a key —
including `GET /workspaces/:id/export`, which is not refused because it is a
read: a key that can reach `/agents` and `/messages` can already assemble the
same archive with a loop, so a refusal would be a gate with a door beside it.

### A key belongs to a person

Not to the workspace. When you leave a workspace — or an admin removes you —
your keys stop working at the same moment your own access does, because they
_are_ your access. A script running on a departed colleague's key goes quiet.

That is the correct behaviour and it is also the one that surprises people, so
the removal dialog on the Team page says how many live keys somebody has before
you remove them.

Revoking is one-way. A revoked key cannot be restored, only replaced.

## Making a request

Send the key as a bearer token. The base URL for Covan Cloud is
`https://api.covan.app`; a self-hosted install uses whatever address its API
Worker answers on.

```bash
curl https://api.covan.app/agents \
  -H "Authorization: Bearer $COVAN_API_KEY"
```

Bodies are JSON, and so are responses:

```bash
curl -X POST https://api.covan.app/sessions \
  -H "Authorization: Bearer $COVAN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"agentId": "…", "title": "Nightly check"}'
```

The one endpoint that does not answer JSON is `POST /chat/stream`, which streams
server-sent events — the same stream the chat window reads.

### Errors

| Status | What it means                                                                                                              |
| ------ | -------------------------------------------------------------------------------------------------------------------------- |
| `400`  | The body failed validation. The response names the fields.                                                                 |
| `401`  | No key, an unknown key, a revoked key, or a key on a deployment that cannot honour one. All four look the same on purpose. |
| `403`  | A policy refused. You are authenticated; you are not permitted.                                                            |
| `404`  | Not there, or not yours — Row Level Security returns nothing rather than admitting a row exists.                           |
| `409`  | A conflict, e.g. inviting somebody who is already a member.                                                                |
| `429`  | Rate limited.                                                                                                              |
| `501`  | The deployment has not enabled this feature.                                                                               |

A `403` and a `404` are often the same underlying refusal seen from different
angles: when a policy hides a row, the route cannot tell "you may not" from "it
is not there", and it says the second because that is what it can prove.

### Rate limits

Two tiers, both per minute. The standard tier — 120 requests, keyed by address —
stands in front of everything. The expensive tier — 20 requests, keyed by user —
stands in front of the six endpoints that buy a completion or a transcription:
`/chat/stream`, `/transcribe`, `/brainstorm/ideas/suggest`, `/persona/suggest`,
`/routines/draft` and `/routines/:id/run`.

A hosted workspace also has a monthly token allowance, which is a ceiling on the
bill rather than on the rate. A self-hosted install has none: the operator brings
their own OpenAI key and decides what to spend on it.

## The endpoints

Everything below is scoped to your active workspace unless it says otherwise.
This is a map rather than a full reference — the request and response shapes are
the ones `worker/src/routes/` accepts, and `src/lib/api-client.ts` is a typed
client for all of it.

### Agents

|                                                |                                  |
| ---------------------------------------------- | -------------------------------- |
| `GET /agents`                                  | Every agent in the workspace     |
| `POST /agents`                                 | Create one                       |
| `PATCH /agents/:id`                            | Rename, re-persona, change model |
| `DELETE /agents/:id`                           | Delete                           |
| `POST /agents/:id/bundles/:bundleId`           | Attach a knowledge bundle        |
| `DELETE /agents/:id/bundles/:bundleId`         | Detach it                        |
| `GET /favorites` · `POST /agents/:id/favorite` | Your own shortcuts               |

### Conversations

|                                                |                               |
| ---------------------------------------------- | ----------------------------- |
| `GET /sessions` · `POST /sessions`             | List and open conversations   |
| `PATCH /sessions/:id` · `DELETE /sessions/:id` | Rename, share, delete         |
| `GET /sessions/:id/messages`                   | The transcript                |
| `POST /messages` · `PATCH /messages/:id`       | Write and edit your own lines |
| `DELETE /messages/after/:id`                   | Truncate, for a re-ask        |
| `POST /chat/stream`                            | Ask. Streams SSE.             |
| `POST /transcribe`                             | Audio to text                 |

A session is private to you unless its `visibility` is `shared`, in which case
the workspace can read it. Assistant replies cannot be written by any client,
including this one — see [Your team](team.md).

### Knowledge

|                                                  |                       |
| ------------------------------------------------ | --------------------- |
| `GET /bundles` · `POST /bundles`                 | Subjects              |
| `PATCH /bundles/:id` · `DELETE /bundles/:id`     | Rename, delete        |
| `POST /bundles/:id/documents/upload`             | Upload a document     |
| `PATCH /documents/:id` · `DELETE /documents/:id` | Rename, move, delete  |
| `GET /documents/:id/download`                    | The original file     |
| `POST /documents/:id/reindex`                    | Re-chunk and re-embed |

### Routines

|                                                |                                  |
| ---------------------------------------------- | -------------------------------- |
| `GET /routines` · `POST /routines`             | Scheduled work                   |
| `PATCH /routines/:id` · `DELETE /routines/:id` | Change, delete                   |
| `POST /routines/:id/run`                       | Run now, rather than on schedule |
| `GET /routines/:id/runs`                       | What happened                    |
| `POST /routines/draft`                         | Turn a sentence into a routine   |
| `GET`/`POST`/`DELETE /delivery-channels`       | Where output goes                |

### Workspace and people

|                                                              |                                                                                                                |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `GET /me` · `PATCH /me`                                      | You, and your display name                                                                                     |
| `GET /workspaces` · `POST /workspaces`                       | Every workspace you are in                                                                                     |
| `POST /workspace/active`                                     | Switch which one requests are scoped to                                                                        |
| `PATCH /workspace`                                           | Name, slug, default model. Admin.                                                                              |
| `PATCH`/`DELETE /workspace/members/:userId`                  | Change a role, remove somebody. Admin.                                                                         |
| `DELETE /workspace/members/me`                               | Leave                                                                                                          |
| `GET`/`POST`/`DELETE /invitations`                           | Invite and revoke. Admin.                                                                                      |
| `GET /invitations/incoming` · `POST /invitations/:id/accept` | Yours to accept                                                                                                |
| `GET /workspaces/:id/export`                                 | The whole workspace as one zip — [Taking it with you](export.md)                                               |
| `DELETE /account`                                            | Close your own account. Session only. Refused while you are the last admin of a workspace others are still in. |

### Usage and keys

|                                           |                                                            |
| ----------------------------------------- | ---------------------------------------------------------- |
| `GET /usage`                              | Your own totals and what is left of your allowance         |
| `GET /usage/workspace`                    | Everyone's, by agent and by month. Admin. Never by person. |
| `GET /api-keys`                           | Your own live keys. Never anyone else's.                   |
| `POST /api-keys` · `DELETE /api-keys/:id` | Session only, as above                                     |

### Other

`GET /health` is the only unauthenticated endpoint. It answers `{"ok": true}` and
says nothing about anything else.

`GET /notification-preferences` and `PATCH` on the same path carry your email
preferences. `PATCH /onboarding` and `POST /onboarding/complete` back the first
run.

## Keeping a key safe

A key is a password that does not expire and cannot be seen twice. Treat it that
way: an environment variable or a secret store, never a repository, never a URL,
never a log line. Give each job its own key so one can be revoked without
stopping the others, and revoke anything you cannot place — the list in Settings
shows when each key was last used precisely so a forgotten one is recognisable.

If a key does leak: revoke it first, then look at what it could have reached,
which is everything you can reach. A key cannot have created other keys, so
revoking really is the end of it.
