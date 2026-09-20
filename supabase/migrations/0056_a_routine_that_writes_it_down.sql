-- =========================================================================
-- A routine that writes it down
--
-- 0054 gave a routine somewhere to send its result and 0055 gave it somewhere
-- to be started from. This gives it somewhere to KEEP the result: a knowledge
-- bundle, where the summary it just delivered becomes an ordinary document —
-- chunked, embedded, retrievable, exportable, deletable — exactly like an
-- upload.
--
-- The point is not storage. It is that a routine stops being a thing that
-- mails you and starts being a thing that accumulates. A weekly competitor
-- digest that files itself is a year of competitor history somebody can ask a
-- question of in twelve months, and the question ("what did they ship in Q2?")
-- is answered by retrieval over fifty-two small documents rather than by
-- somebody scrolling a Slack channel.
--
-- WHY A COLUMN ON `routines` AND NOT A DELIVERY CHANNEL KIND. It would have
-- been less code. It is the wrong shape, for three reasons that are each
-- sufficient on their own:
--
--   1. `announcePause` and `announceQuotaSkip` deliver through the routine's
--      own channel. If a bundle were a channel, "your routine has been paused
--      after repeated failures" would land in the team's knowledge base as a
--      permanent, embedded, retrievable document — and would then be quoted
--      back at somebody in chat six weeks later as if it were knowledge.
--   2. `delivery_channels.secret_ciphertext` is `not null`, because every kind
--      there is a credential for something outside this system. A bundle is
--      inside it and has no secret. The column would have to hold a fiction.
--   3. The guards do not match. A channel is guarded with
--      `dc.user_id = auth.uid()` — channels are personal. A bundle is guarded
--      with `can_write_in_workspace` — bundles are shared, and a viewer must
--      not write to one. Those are different questions and one table cannot
--      ask both.
--
-- So: two columns on `routines`, one on `documents`, two on `routine_runs`.
-- =========================================================================

-- ---- routines.output_bundle_id, routines.output_retention ----------------

alter table public.routines
  -- `set null`, not `cascade`, and the reasoning is 0043's about
  -- `documents.connection_id` applied one level up: deleting a routine must
  -- not delete the year of digests it wrote. The documents stay, the routine
  -- stops adding to them. Nullable throughout, and null is the default: every
  -- routine that exists today files nothing and keeps behaving exactly as it
  -- did.
  add column if not exists output_bundle_id uuid
    references public.knowledge_bundles (id) on delete set null,
  -- How many of its own documents a routine keeps. 52 is a year on the
  -- dominant schedule (weekly); a daily routine keeps about seven weeks, which
  -- is the right answer for a daily — nobody retrieves last March's standup.
  add column if not exists output_retention int not null default 52;

alter table public.routines
  drop constraint if exists routines_output_retention_check;

-- Bounded at both ends, and the upper bound is the interesting one. This is a
-- number a client sends, `authenticated` holds a table-level UPDATE on this
-- table from 0023, and the executor prunes to it after every filing run. An
-- unbounded value is a routine that never prunes; 520 is ten years of weekly
-- and past any real intent.
alter table public.routines
  add constraint routines_output_retention_check
  check (output_retention between 1 and 520);

comment on column public.routines.output_bundle_id is
  'The knowledge bundle this routine files its delivered summaries into, or null to file nothing. Must be a bundle in the routine''s own workspace - see routines_insert_own / routines_update_own, which is where that is enforced, because the service-role executor writes the document and RLS is not filtering it.';

comment on column public.routines.output_retention is
  'How many of its own filed documents this routine keeps. The executor soft-deletes the oldest beyond this after each filing run.';

-- ---- the guard that makes the column safe --------------------------------
--
-- This is the whole security content of this migration, and it is the same
-- lesson 0027 learned the expensive way about `source_config`.
--
-- The API is not the boundary. `authenticated` holds a table-level UPDATE on
-- `routines` from 0023 with no column list, and the anon key ships in the
-- browser bundle — so `PATCH /rest/v1/routines?id=eq...` with an arbitrary
-- `output_bundle_id` reaches Postgres directly, whatever `updateSchema` in
-- `routes/routines.ts` accepts. `routines_update_own` as written constrains
-- user_id, workspace_id, agent_id and delivery_channel_id and says nothing
-- about this column.
--
-- Without the guard below, the attack is one request: point your own routine's
-- output at a bundle id belonging to a workspace you are not in, and wait. The
-- executor runs under the service role, which bypasses RLS entirely, so it
-- would cheerfully insert your agent's summary — text you wrote the
-- instruction for — as a document in their knowledge base, where their agents
-- retrieve it and quote it back to them as their own material. That is a
-- cross-tenant WRITE with an LLM on the far end of it.
--
-- The subquery resolves through `knowledge_bundles`' own RLS (subqueries
-- inside a policy do, which is what 0012 relies on for `agents` and
-- `delivery_channels`), so it requires the bundle to be VISIBLE to the caller
-- as well as to sit in the routine's workspace. Both halves are wanted: the
-- workspace match is what stops the cross-tenant write, and the visibility is
-- what stops a routine being pointed at a bundle in its own workspace that the
-- caller could not otherwise see.
--
-- Not a trigger, unlike 0027. `source_config` needed one because immutability
-- is a statement about the old row as well as the new one. This is a statement
-- about the new row alone — "whatever it says now must be a bundle here" — and
-- a WITH CHECK can see that. It also means the column stays changeable, which
-- it should be: a person may move a routine's output to a different bundle
-- without rebuilding the routine.
--
-- BOTH POLICIES ARE RESTATED IN FULL, and that is the dangerous part of writing
-- one. A policy cannot be added to; it is dropped and written again, so every
-- guard it already had has to be carried forward by hand. These two have been
-- rewritten three times before this — 0012 wrote them, 0019 reworked them when
-- a delivery channel stopped belonging to a workspace, and 0047 added
-- `routine_source_is_visible` so a routine could not be pointed at another
-- workspace's connection. A fourth rewrite that copied 0012's text would
-- silently delete 0047's guard and reopen a cross-tenant read, and nothing
-- would fail: the policy would still exist, still refuse the obvious things,
-- and still be named the same.
--
-- `routine-policy.static.test.ts` is what makes that a failing test rather than
-- a review that has to catch it.

drop policy if exists "routines_insert_own" on public.routines;
create policy "routines_insert_own"
  on public.routines for insert
  with check (
    user_id = auth.uid()
    and public.is_workspace_member(workspace_id)
    and exists (
      select 1 from public.agents a
      where a.id = routines.agent_id and a.workspace_id = routines.workspace_id
    )
    and exists (
      select 1 from public.delivery_channels dc
      where dc.id = routines.delivery_channel_id and dc.user_id = auth.uid()
    )
    -- 0047. A routine may only watch a connection in its own workspace.
    and public.routine_source_is_visible(
      routines.source_kind, routines.source_config, routines.workspace_id
    )
    -- 0056. And may only file into a bundle in its own workspace.
    and (
      routines.output_bundle_id is null
      or exists (
        select 1 from public.knowledge_bundles b
        where b.id = routines.output_bundle_id
          and b.workspace_id = routines.workspace_id
      )
    )
  );

drop policy if exists "routines_update_own" on public.routines;
create policy "routines_update_own"
  on public.routines for update
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and public.is_workspace_member(workspace_id)
    and exists (
      select 1 from public.agents a
      where a.id = routines.agent_id and a.workspace_id = routines.workspace_id
    )
    and exists (
      select 1 from public.delivery_channels dc
      where dc.id = routines.delivery_channel_id and dc.user_id = auth.uid()
    )
    -- 0047, and unreachable today because 0027's trigger already refuses any
    -- update that changes the source. Written anyway, for the reason 0047
    -- gives: a trigger is one `drop trigger` away from being removed by
    -- somebody solving a different problem, and a guard that was never written
    -- is not there to catch that.
    and public.routine_source_is_visible(
      routines.source_kind, routines.source_config, routines.workspace_id
    )
    -- 0056, and very much reachable: this column is meant to be changed.
    and (
      routines.output_bundle_id is null
      or exists (
        select 1 from public.knowledge_bundles b
        where b.id = routines.output_bundle_id
          and b.workspace_id = routines.workspace_id
      )
    )
  );

-- ---- documents.routine_id ------------------------------------------------
--
-- The same shape as 0043's `connection_id`, deliberately: nullable, `set
-- null`, no new grant, and every existing row keeps its meaning. A document
-- now has at most one provenance column set — `connection_id` for a synced
-- file, `routine_id` for a filed summary, neither for an upload — and that is
-- how the Knowledge tab says where something came from without a `kind` column
-- and without a chip.
alter table public.documents
  -- `set null` rather than `cascade`, and the same product decision 0043 made
  -- about disconnecting a source: deleting a routine must not delete the
  -- history it accumulated. The documents stay and become ordinary ones.
  add column if not exists routine_id uuid
    references public.routines (id) on delete set null;

comment on column public.documents.routine_id is
  'The routine that wrote this document, or null for an upload or a synced file. Also the structural half of the loop guard: connection-source.ts filters routine_id is null so a routine watching a connection can never report a document another routine filed into it.';

-- Two things read this column, and both are narrow.
--
-- The retention prune asks for one routine's documents newest-first, which is
-- the (routine_id, created_at desc) half. The loop guard in
-- `connection-source.ts` asks `connection_id = ? and routine_id is null`,
-- which is served by the existing connection index plus a cheap recheck.
--
-- Partial, because the overwhelming majority of documents are uploads and
-- synced files with a null here, and there is no query that wants those.
create index if not exists documents_routine_idx
  on public.documents (routine_id, created_at desc)
  where routine_id is not null;

-- ---- routine_runs.document_id, routine_runs.filing_note ------------------
--
-- A run says what it delivered. Now it also says what it kept, and — when it
-- kept nothing — why, which is the column that matters.
--
-- `filing_note` exists because filing is best-effort and must stay that way.
-- The cron Worker may have no document store bound at all (see
-- `canFileDocuments`), the owner may have been demoted to `viewer` since they
-- set this up, the bundle may have been deleted, the embedding provider may be
-- down. None of those may fail the run: the summary was delivered, the person
-- got their digest, and turning that into a `failed` row would back the
-- routine off geometrically and eventually PAUSE a routine that is working
-- perfectly — for the sake of an optional extra.
--
-- So filing fails quietly, and this is where it says so. A null note with a
-- null document_id means the routine files nothing, which is almost every row.
alter table public.routine_runs
  -- `set null`: deleting the document must not delete the record of the run
  -- that produced it, and a run row that pointed at a deleted document would
  -- be worse than one that says nothing.
  add column if not exists document_id uuid
    references public.documents (id) on delete set null,
  add column if not exists filing_note text;

comment on column public.routine_runs.document_id is
  'The document this run filed into the routine''s output bundle, or null if it filed nothing.';

comment on column public.routine_runs.filing_note is
  'Why this run filed nothing, when it was supposed to. Null when the routine files nothing at all, and null when filing succeeded.';
