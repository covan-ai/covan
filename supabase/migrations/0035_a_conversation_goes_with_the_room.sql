-- 0035_a_conversation_goes_with_the_room.sql
--
-- `delete from workspaces` failed on any workspace anybody had ever used, and
-- three separate places carried the same paragraph explaining how to get past
-- it.
--
-- Every foreign key pointing at `workspaces` cascades — `agents`, `api_keys`,
-- `document_chunks`, `invitations`, `knowledge_bundles`, `routines`,
-- `workspace_members` — except three. Two of those three are decisions, and
-- both are written down: `delivery_channels.workspace_id` is `set null`
-- because a channel belongs to a PERSON rather than to a room (0019), and
-- `profiles.active_workspace_id` is `set null` because the state that leaves
-- behind is the one a fresh account is already in.
--
-- The other two were never decided. `chat_sessions.workspace_id` arrived in
-- 0008 and `ideas.workspace_id` in 0011, both after the original schema, both
-- written as a plain `references public.workspaces (id)` with no delete rule.
-- Nobody chose NO ACTION for them; NO ACTION is what you get when you do not
-- say. And because the failure only shows up when a workspace is deleted —
-- which nothing in the product did until account closure — the accident had
-- years to look like the schema.
--
-- What it cost is the giveaway. Not a bug anybody hit, but the same paragraph
-- copied into three places: `worker/src/routes/account.ts` clearing both
-- tables before deleting each empty workspace, `tests/rls/export-roundtrip.
-- test.ts` doing the same to make room for a restore, and `docs/team.md`
-- documenting it as the operator's procedure. Three copies of one rule is how
-- a rule goes stale.
--
-- Cascade rather than `set null`, because unlike a delivery channel neither
-- row means anything without its workspace. A session is already reachable
-- only through an agent and agents cascade; an idea belongs to a session. The
-- column was refusing a relationship the rest of the schema already had.
--
-- `chat_sessions.workspace_id` stays nullable and `ideas.workspace_id` stays
-- `not null`; this changes what happens on delete and nothing else.
--
-- **For whoever removes the three workarounds:** they are safe either way, but
-- not in any order. Clearing the two tables first still does exactly what it
-- did — the rows go, and then the workspace goes. What changes is that the
-- delete now succeeds without them. Since migrations reach this schema's
-- production by hand, apply this file there BEFORE merging the removal, or the
-- route runs against a database that still refuses.

alter table public.chat_sessions
  drop constraint if exists chat_sessions_workspace_id_fkey;

alter table public.chat_sessions
  add constraint chat_sessions_workspace_id_fkey
  foreign key (workspace_id) references public.workspaces (id) on delete cascade;

alter table public.ideas
  drop constraint if exists ideas_workspace_id_fkey;

alter table public.ideas
  add constraint ideas_workspace_id_fkey
  foreign key (workspace_id) references public.workspaces (id) on delete cascade;
