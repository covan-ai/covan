-- 0021_a_role_that_only_reads.sql
--
-- The Team screen presented `member` as the role that cannot change things.
-- Nothing in the database agreed. Not one policy on `agents`,
-- `knowledge_bundles`, `documents`, `document_chunks` or `agent_bundles` ever
-- looked at `role` — they all asked only "is this person in the workspace?" —
-- so a plain member could delete any agent in it, taking every session,
-- message and routine attached to that agent with it. `role` gated exactly two
-- things: workspace administration and invitations.
--
-- There were two ways to make the screen true. Make `member` read-only, or add
-- the role the screen was describing. Making `member` read-only would have
-- meant that in a product whose whole claim is that a team trains one agent
-- together, only admins could do the training — so instead there is now a third
-- role, and `member` keeps building.
--
--   admin   runs the place: people, roles, invitations, the workspace itself
--   member  builds: agents, knowledge, documents — and everything below
--   viewer  uses what is there, and changes none of it
--
-- WHAT A VIEWER STILL HAS. Their own conversations, messages, brainstorm ideas,
-- routines, delivery channels, favourites and notification preferences — every
-- one of which is keyed to their user id rather than to their role, and none of
-- which is touched here. A viewer can chat with any agent in the workspace and
-- can share a session with it. The line this migration draws is between the
-- SHARED things a workspace owns and the things that are yours: shared things
-- need a member, yours need only membership. A viewer who could not chat would
-- be a login with nothing behind it, in a product that is about chatting.

-- ---- the third question a policy can ask ----------------------------------
--
-- `is_workspace_member` and `is_workspace_admin` already exist in this shape
-- and for the same reason: SECURITY DEFINER so a policy on workspace_members
-- does not re-enter RLS and recurse, STABLE so the planner may call it once.
--
-- Written as "member and not viewer" rather than "admin or member" on purpose.
-- A fourth role added later is presumed able to write unless it is explicitly
-- read-only, which fails towards a role that works rather than towards one
-- that is silently locked out of the product with no error to explain it.
create or replace function public.can_write_in_workspace(p_workspace_id uuid)
returns boolean
language sql
security definer
stable
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = p_workspace_id
      and wm.user_id = auth.uid()
      and wm.role <> 'viewer'
  );
$$;

-- NO REVOKE, unlike `claim_due_routines`. That one is called through PostgREST
-- and revoking PUBLIC is the whole security boundary. This one is evaluated
-- INSIDE a policy, by the invoking role — so `authenticated` needs EXECUTE or
-- every write it guards fails with "permission denied for function", including
-- writes by an admin. `is_workspace_member` and `is_workspace_admin` keep the
-- default grant for exactly this reason, and so does this. There is nothing to
-- protect: it takes a workspace id, reads the caller's own membership, and
-- returns a boolean the caller could work out by selecting their own row.

-- ---- agents ---------------------------------------------------------------
-- 0001 wrote these as an inline `exists (select 1 from workspace_members ...)`
-- rather than through the helper. They move to the helper here, which is what
-- makes the change reviewable: after this migration, every write policy on a
-- shared table names `can_write_in_workspace` and nothing else.

drop policy if exists "agents_insert_workspace_member" on public.agents;
create policy "agents_insert_workspace_member"
  on public.agents for insert
  with check (created_by = auth.uid() and public.can_write_in_workspace(workspace_id));

drop policy if exists "agents_update_workspace_member" on public.agents;
create policy "agents_update_workspace_member"
  on public.agents for update
  using (public.can_write_in_workspace(workspace_id))
  with check (public.can_write_in_workspace(workspace_id));

drop policy if exists "agents_delete_workspace_member" on public.agents;
create policy "agents_delete_workspace_member"
  on public.agents for delete
  using (public.can_write_in_workspace(workspace_id));

-- ---- knowledge_bundles ----------------------------------------------------

drop policy if exists "kb_insert_member" on public.knowledge_bundles;
create policy "kb_insert_member"
  on public.knowledge_bundles for insert
  with check (created_by = auth.uid() and public.can_write_in_workspace(workspace_id));

drop policy if exists "kb_update_member" on public.knowledge_bundles;
create policy "kb_update_member"
  on public.knowledge_bundles for update
  using (public.can_write_in_workspace(workspace_id))
  with check (public.can_write_in_workspace(workspace_id));

drop policy if exists "kb_delete_member" on public.knowledge_bundles;
create policy "kb_delete_member"
  on public.knowledge_bundles for delete
  using (public.can_write_in_workspace(workspace_id));

-- ---- documents ------------------------------------------------------------
-- Reached through their bundle, which is where the workspace lives.

drop policy if exists "documents_insert_member" on public.documents;
create policy "documents_insert_member"
  on public.documents for insert
  with check (
    exists (
      select 1 from public.knowledge_bundles b
      where b.id = documents.bundle_id and public.can_write_in_workspace(b.workspace_id)
    )
  );

drop policy if exists "documents_update_member" on public.documents;
create policy "documents_update_member"
  on public.documents for update
  using (
    exists (
      select 1 from public.knowledge_bundles b
      where b.id = documents.bundle_id and public.can_write_in_workspace(b.workspace_id)
    )
  )
  with check (
    exists (
      select 1 from public.knowledge_bundles b
      where b.id = documents.bundle_id and public.can_write_in_workspace(b.workspace_id)
    )
  );

drop policy if exists "documents_delete_member" on public.documents;
create policy "documents_delete_member"
  on public.documents for delete
  using (
    exists (
      select 1 from public.knowledge_bundles b
      where b.id = documents.bundle_id and public.can_write_in_workspace(b.workspace_id)
    )
  );

-- ---- document_chunks ------------------------------------------------------
-- Written by the caller's own client, not the service role (see
-- worker/src/routes/documents.ts), so this policy is load-bearing: without it a
-- viewer could not add a document but could still write chunks against one.

drop policy if exists "dc_insert_member" on public.document_chunks;
create policy "dc_insert_member"
  on public.document_chunks for insert
  with check (public.can_write_in_workspace(workspace_id));

drop policy if exists "dc_delete_member" on public.document_chunks;
create policy "dc_delete_member"
  on public.document_chunks for delete
  using (public.can_write_in_workspace(workspace_id));

-- ---- agent_bundles --------------------------------------------------------
-- Attaching knowledge to an agent changes what that agent knows, which is the
-- clearest case of changing a shared thing without editing its row.

drop policy if exists "ab_insert_member" on public.agent_bundles;
create policy "ab_insert_member"
  on public.agent_bundles for insert
  with check (
    exists (
      select 1
      from public.agents a
      join public.knowledge_bundles b on b.id = agent_bundles.bundle_id
      where a.id = agent_bundles.agent_id
        and a.workspace_id = b.workspace_id
        and public.can_write_in_workspace(a.workspace_id)
    )
  );

drop policy if exists "ab_delete_member" on public.agent_bundles;
create policy "ab_delete_member"
  on public.agent_bundles for delete
  using (
    exists (
      select 1 from public.agents a
      where a.id = agent_bundles.agent_id and public.can_write_in_workspace(a.workspace_id)
    )
  );

-- ---- the role has to be spellable -----------------------------------------
--
-- Both constraints, because an invitation carries a role and
-- `accept_invitation` copies it into the membership row unchanged — widening
-- one without the other would let an invitation be created that could never be
-- accepted. Nothing else reads `role` by value:
-- `prevent_last_admin_removal` only ever compares it to 'admin'.

alter table public.workspace_members
  drop constraint if exists workspace_members_role_check;
alter table public.workspace_members
  add constraint workspace_members_role_check
  check (role in ('admin', 'member', 'viewer'));

alter table public.invitations
  drop constraint if exists invitations_role_check;
alter table public.invitations
  add constraint invitations_role_check
  check (role in ('admin', 'member', 'viewer'));
