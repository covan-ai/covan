-- 0031_access_follows_membership.sql
--
-- The last of the nine gaps found on 2026-08-21 by reading /docs against the
-- code. The other eight shipped in 0018-0022; this one waited because the fix
-- was a product decision rather than a patch, and the decision is now made:
-- access to a workspace's rows follows membership of that workspace.
--
-- Eleven policies across chat_sessions, messages and ideas gate on the same
-- copied predicate:
--
--   cs.user_id = auth.uid()
--   or (cs.visibility = 'shared' and is_workspace_member(cs.workspace_id))
--
-- The second branch checks membership. The first does not, and never did — a
-- session genuinely belongs to the person who opened it, so RLS returns it
-- however the route is written. Remove somebody from a workspace and they keep
-- reading the private conversations they had with its agents.
--
-- What that costs is not their own questions, which are arguably theirs to
-- keep. It is the other half of the transcript: every assistant reply was
-- grounded in the workspace's knowledge bundles, so the thread is a readable
-- copy of what those documents said. The agent itself is already unreachable —
-- POST /chat/stream loads it through the caller's own client and 404s — which
-- is exactly what made this easy to miss. Removal ended their access to the
-- documents and left the answers behind.
--
-- The predicate is rewritten so membership is unconditional and ownership only
-- decides which member sees it:
--
--   is_workspace_member(cs.workspace_id)
--   and (cs.user_id = auth.uid() or cs.visibility = 'shared')
--
-- Nothing is deleted. The rows sit where they are and come back the moment the
-- person is invited back, which is what the removal dialog on the team page now
-- says, and what tests/rls/membership.test.ts asserts in both directions.
--
-- ---- Not changed, deliberately -------------------------------------------
--
-- `routines_select_visible` carries the same open branch and keeps it. The harm
-- there is already closed further up: the executor checks membership before
-- every run and pauses the routine with "the routine's owner is no longer a
-- member of this workspace" (worker/src/lib/routines/executor.ts), and
-- routine_runs records counts and status, never content. Leaving the row
-- readable is the point — it is the only place that pause reason is shown, and
-- hiding it would replace an explanation with a routine that silently stopped.
--
-- GET /sessions/:id/messages still filters on session_id alone. It leans on
-- messages_select_session_visible below, which is the arrangement the whole
-- suite is built on; a workspace scope in the route would be a second query
-- guarding what the database already refuses.

-- ---- the predicate, once -------------------------------------------------
-- Seven of the eleven policies gate on the parent session rather than on their
-- own columns, and each had its own copy of the expression. That is how the
-- open branch came to exist in five places at once, and why fixing it in one
-- would have been indistinguishable from fixing it everywhere. They now name
-- this function and nothing else, the way 0021 collapsed every write policy on
-- a shared table onto can_write_in_workspace.
--
-- SECURITY DEFINER, matching is_workspace_member and can_write_in_workspace:
-- the predicate is complete on its own rather than resting on whatever
-- chat_sessions' own select policy happens to say next year. STABLE so the
-- planner may call it once per row.
create or replace function public.session_is_visible(p_session_id uuid)
returns boolean
language sql
security definer
stable
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.chat_sessions cs
    where cs.id = p_session_id
      and public.is_workspace_member(cs.workspace_id)
      and (cs.user_id = auth.uid() or cs.visibility = 'shared')
  );
$$;

-- NO REVOKE, for the reason 0021 spells out: this is evaluated inside a policy
-- by the invoking role, so `authenticated` needs EXECUTE or every read it
-- guards fails with "permission denied for function". Only functions reached
-- through PostgREST — claim_due_routines — are revoked from PUBLIC.

-- ---- chat_sessions -------------------------------------------------------

drop policy if exists "chat_sessions_select_owner_or_shared" on public.chat_sessions;

create policy "chat_sessions_select_owner_or_shared"
  on public.chat_sessions for select
  using (
    public.is_workspace_member(workspace_id)
    and (user_id = auth.uid() or visibility = 'shared')
  );

-- The USING here has been the weaker half of an asymmetric pair since 0028,
-- which added membership to the WITH CHECK and left USING as bare ownership.
-- An ex-member's UPDATE was already refused — the check fails — but a policy
-- whose two halves disagree about what it is for is one edit away from being
-- read wrong. The agent-in-this-workspace guard from 0028 is unchanged.
drop policy if exists "chat_sessions_update_owner" on public.chat_sessions;

create policy "chat_sessions_update_owner"
  on public.chat_sessions for update
  using (user_id = auth.uid() and public.is_workspace_member(workspace_id))
  with check (
    user_id = auth.uid()
    and public.is_workspace_member(workspace_id)
    and exists (
      select 1 from public.agents a
      where a.id = chat_sessions.agent_id
        and a.workspace_id = chat_sessions.workspace_id
    )
  );

-- Deleting your own leftovers is not obviously harmful, and it is still the one
-- of the three that could be argued either way. It goes with the others because
-- a session marked shared is a thread the team is still reading, and somebody
-- who has left the workspace should not be able to take it down from outside.
drop policy if exists "chat_sessions_delete_owner" on public.chat_sessions;

create policy "chat_sessions_delete_owner"
  on public.chat_sessions for delete
  using (user_id = auth.uid() and public.is_workspace_member(workspace_id));

-- ---- messages ------------------------------------------------------------

drop policy if exists "messages_select_session_visible" on public.messages;

create policy "messages_select_session_visible"
  on public.messages for select
  using (public.session_is_visible(session_id));

-- 0018's own-voice guard is unchanged: sender_id and role are what stop a
-- client putting words in the agent's mouth, and they are independent of this.
drop policy if exists "messages_insert_user_self" on public.messages;

create policy "messages_insert_user_self"
  on public.messages for insert
  with check (
    sender_id = auth.uid()
    and role = 'user'
    and public.session_is_visible(session_id)
  );

drop policy if exists "messages_update_owner" on public.messages;

create policy "messages_update_owner"
  on public.messages for update
  using (
    sender_id = auth.uid()
    and role = 'user'
    and public.session_is_visible(session_id)
  )
  with check (
    sender_id = auth.uid()
    and role = 'user'
    and public.session_is_visible(session_id)
  );

-- The one that must NOT take the helper. Deleting a message has been the
-- parent session's owner alone since 0001, while session_is_visible is true for
-- every member of a shared session — swapping it in here would hand anyone
-- reading a shared thread the power to delete lines out of it. Ownership stays
-- inline; only the membership condition is added.
drop policy if exists "messages_delete_owner" on public.messages;

create policy "messages_delete_owner"
  on public.messages for delete
  using (
    exists (
      select 1
      from public.chat_sessions cs
      where cs.id = messages.session_id
        and cs.user_id = auth.uid()
        and public.is_workspace_member(cs.workspace_id)
    )
  );

-- ---- ideas ---------------------------------------------------------------
-- A brainstorm board hangs off a session exactly as messages do, so the same
-- open branch reached the cards. The role and authorship guards from 0021 and
-- 0028 — can_write_in_workspace, created_by, the pinned workspace_id, and the
-- two immutability triggers from 0028 and 0030 — are unchanged.

drop policy if exists "ideas_select_session_visible" on public.ideas;

create policy "ideas_select_session_visible"
  on public.ideas for select
  using (public.session_is_visible(session_id));

drop policy if exists "ideas_insert_session_visible" on public.ideas;

create policy "ideas_insert_session_visible"
  on public.ideas for insert
  with check (
    created_by = auth.uid()
    and public.session_is_visible(session_id)
  );

drop policy if exists "ideas_update_session_visible" on public.ideas;

create policy "ideas_update_session_visible"
  on public.ideas for update
  using (
    (
      created_by = auth.uid()
      or public.can_write_in_workspace(
        (select cs.workspace_id from public.chat_sessions cs where cs.id = ideas.session_id)
      )
    )
    and public.session_is_visible(session_id)
  )
  with check (
    workspace_id = (select cs.workspace_id from public.chat_sessions cs where cs.id = ideas.session_id)
  );

drop policy if exists "ideas_delete_session_visible" on public.ideas;

create policy "ideas_delete_session_visible"
  on public.ideas for delete
  using (
    (
      created_by = auth.uid()
      or public.can_write_in_workspace(
        (select cs.workspace_id from public.chat_sessions cs where cs.id = ideas.session_id)
      )
    )
    and public.session_is_visible(session_id)
  );
