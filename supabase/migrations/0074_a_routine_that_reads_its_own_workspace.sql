-- =========================================================================
-- A routine that reads its own workspace
--
-- Every routine until now has fetched from outside: a webhook payload, a
-- watched page, an RSS feed, or the documents a connection already synced.
-- `lib/routines/material.ts` is the whole vocabulary and all of its cases are
-- third-party text.
--
-- covan-ai/covan#44 wants a report over the workspace's OWN data — which of its
-- answers found nothing in its own documents — and there was no shape for that.
-- So `source_kind` gains `workspace`, and `source_config` says which report:
-- `{"report": "coverage_gaps"}`.
--
-- The `report` key is why this is an abstraction rather than one feature with a
-- column. The second customer is already named: a stale-document nudge is
-- `{"report": "stale_documents"}` and needs no constraint change, no policy
-- rewrite and no migration — which is the whole test of whether this was the
-- right place to cut.
--
-- ---- the guard, and why it cannot live where 0047's does -------------------
--
-- `routine_source_is_visible` (0047) reads:
--
--     p_source_kind <> 'connection' or exists (...)
--
-- so it answers TRUE for any kind it has never heard of. That is correct for a
-- function about connections and it means the new kind walks straight through
-- the gate the policies already call. The guard has to be written somewhere
-- new.
--
-- What needs guarding is not cross-tenant reach. `source_config` names no other
-- tenant's object, and `is_workspace_member(workspace_id)` already pins the row
-- to a workspace the caller belongs to. It is PRIVILEGE: a member who is not an
-- admin must not be able to create a routine that delivers an admin-only
-- report, and the API is not the boundary. `authenticated` holds table-level
-- INSERT and UPDATE on `routines` from 0023, and the anon key ships in the
-- browser bundle, so `POST /rest/v1/routines` reaches Postgres whatever
-- `routes/routines.ts` accepts. That is 0027's lesson and 0056's, now a third
-- time.
--
-- And the second half: such a routine may never file into a knowledge bundle.
-- 0056 lets a routine's delivered summary become an ordinary chunked, embedded,
-- retrievable document, and a coverage report filed there is a document about
-- what the team does not know — which every agent in the workspace would then
-- retrieve and quote back at somebody in chat as if it were knowledge. The
-- clusters are k-anonymous so this is not a disclosure; it is simply not
-- knowledge, and 0056's own header refuses the identical shape when it refuses
-- to let pause announcements become documents. This half has no run-time
-- backstop at all: the executor files with the service role, so a column that
-- is set is a document that gets written.
--
-- One function rather than two inline clauses, and the reason is risk rather
-- than tidiness: the dangerous part of this migration is restating two policies
-- from memory, and the smaller the addition inside that edit, the smaller the
-- chance of botching what was already there. It is also unit-testable on its
-- own and changeable later without touching a policy again — which is exactly
-- what 0047 bought by writing `routine_source_is_visible` instead of inlining
-- its subquery.
--
-- RUN TIME IS A SEPARATE CHECK AND THIS IS NOT IT. The executor runs under the
-- service role and bypasses RLS entirely, so no policy here can catch an admin
-- who was demoted last week or a workspace that turned the report off
-- yesterday. `lib/routines/coverage-source.ts` WILL re-ask both on every run
-- and pause the routine with a reason — it is not written yet, and this
-- sentence is a requirement on it rather than a description of it. The
-- functions it will call are in 0075: `workspace_coverage_gaps` and
-- `workspace_coverage_totals` raise 42501 when the owner is no longer an admin
-- or the workspace has turned the report off, which is the refusal the pause
-- will be built on. This guard is about creation — and about
-- the one update that creation cannot cover, which is adding an output bundle
-- to a routine that already reads the workspace.
-- =========================================================================

-- ---- the vocabulary ------------------------------------------------------
--
-- Dropped by NAME, and not with 0047's discovery loop, which is the dangerous
-- thing to copy here. That loop drops every check constraint on the table whose
-- definition mentions `source_kind`, and when 0047 ran there was exactly one.
-- There are now three:
--
--   routines_source_kind_check              the vocabulary (0047 named it)
--   routines_connection_config_check        0047's own shape guard
--   routines_webhook_needs_no_source_check  0055's
--
-- The second two mention `source_kind` in their bodies, so the loop would now
-- drop two guards on its way to the one it wanted, silently and with nothing
-- re-adding them. A named drop is safe precisely because 0047 stopped relying
-- on a generated name: after 0047 this constraint is called the same thing on
-- every database that ran it, so the `if exists` cannot quietly skip and leave
-- an old `in (...)` list behind refusing every workspace routine.
--
-- Nothing is needed for the other two. A `workspace` routine is not a
-- `connection` one, so 0047's shape guard passes it; and 0055's already says a
-- webhook-triggered routine must have `source_kind = 'none'`, which correctly
-- means this kind is schedule-only without a word being added here.
alter table public.routines drop constraint if exists routines_source_kind_check;
alter table public.routines
  add constraint routines_source_kind_check
  check (source_kind in ('rss', 'web', 'none', 'connection', 'workspace'));

-- ---- the guard -----------------------------------------------------------
create or replace function public.routine_workspace_source_is_permitted(
  p_source_kind text,
  p_workspace_id uuid,
  p_output_bundle_id uuid
) returns boolean
language sql
stable
-- Deliberately NOT security definer, which is 0047's note about its own guard.
-- It would not change today's answer — `auth.uid()` reads the request's JWT
-- claims out of a session setting, and `is_workspace_admin` is itself a definer
-- function that asks about the caller, so neither is affected by how this
-- wrapper is declared. The reason is what the next clause added here would do:
-- a definer function runs with the owner's table privileges, so any lookup
-- written into this body later would see every row in the database and answer
-- for a caller it never consulted. A policy helper has no business being the
-- one thing in the chain that is not asking as the caller.
--
-- No `set search_path` either, and that too follows 0047. Everything named here
-- is schema-qualified, and a function with a SET clause cannot be inlined by
-- the planner — which, in an expression evaluated once per row inside a policy,
-- is a cost paid for nothing.
as $$
  select p_source_kind <> 'workspace'
      or (public.is_workspace_admin(p_workspace_id)
          and p_output_bundle_id is null);
$$;

comment on function public.routine_workspace_source_is_permitted(text, uuid, uuid) is
  'True unless the routine reads its own workspace and either the caller is not an admin of it or the routine would file its output as a document. Runs as the caller; must not become SECURITY DEFINER.';

-- No grant for the function. A `stable` SQL function that is not SECURITY
-- DEFINER runs with the caller's own privileges and discloses nothing they
-- could not ask for directly, so PUBLIC's default EXECUTE is harmless here —
-- unlike 0012's `claim_due_routines` or 0053's pair, where revoking PUBLIC is
-- the security boundary. 0047's `routine_source_is_visible` has no grant line
-- either, for this reason.

-- ---- both policies, restated in full -------------------------------------
--
-- A policy cannot be added to. It is dropped and written again, so every guard
-- it already had has to be carried forward by hand, and forgetting one fails
-- nothing: the policy still exists, still has its name, and still refuses the
-- obvious things. These two have now been written five times — 0012 created
-- them, 0019 reworked them when a delivery channel stopped belonging to a
-- workspace, 0027 restated them, 0047 added `routine_source_is_visible`, and
-- 0056 added the output-bundle guard. 0056's own header records that its first
-- draft was built on 0012's text and would have deleted 0047's guard.
--
-- EVERY CLAUSE BELOW WAS ALREADY THERE EXCEPT THE LAST. In order: 0012's owner,
-- membership, agent-in-workspace and channel-ownership checks; 0047's
-- `routine_source_is_visible`; 0056's output-bundle workspace match; and
-- 0074's. The UPDATE policy additionally keeps its USING clause, without which
-- anyone could update any row they could also satisfy the WITH CHECK for.
--
-- `routine-policy.static.test.ts` fails if any of the first five went missing —
-- it reads every version of a policy in the tree and requires the latest to
-- still name what the earlier ones named. What it cannot see is a clause that
-- is present and no longer refuses, or the new guard being absent; that is
-- `tests/rls/coverage-gaps.test.ts`, which exercises all seven against a real
-- database through PostgREST as the user whose privilege is in question.

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
    -- 0074. And may only read its own workspace's data if the caller is an
    -- admin of it, and then only if it files nothing.
    and public.routine_workspace_source_is_permitted(
      routines.source_kind, routines.workspace_id, routines.output_bundle_id
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
    -- 0074, and very much reachable on this policy for the same reason 0056's
    -- clause is. `source_kind` cannot be changed after creation, so this is not
    -- about repointing a routine at the workspace's data; it is about the two
    -- updates that leave the source alone. Adding an output bundle to a routine
    -- that already reads the workspace passes every clause above it — the bundle
    -- is in the right workspace and the caller can see it — and this is the only
    -- thing that refuses it. And an admin who is demoted cannot be stopped from
    -- owning the routine they already made, but can be stopped from editing it;
    -- the run-time check in coverage-source.ts, once that file exists, is what
    -- will pause it — on the 42501 that 0075's two read functions raise for an
    -- owner who is no longer an admin.
    and public.routine_workspace_source_is_permitted(
      routines.source_kind, routines.workspace_id, routines.output_bundle_id
    )
  );
