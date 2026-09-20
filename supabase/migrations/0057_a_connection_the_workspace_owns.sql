-- =========================================================================
-- A connection the workspace owns
--
-- 0043 said, in its own comment, that a connection belongs to a workspace: it
-- is the reason a shared bundle says what it says, every member can see it, and
-- an admin can turn it off because "somebody leaves" was a case it thought
-- about. Then it wrote the column the other way round:
--
--     user_id uuid not null references auth.users (id) on delete cascade
--
-- So the person who connected Drive closes their Covan account and the
-- connection is DELETED. `documents.connection_id` is `on delete set null`, so
-- the documents survive — as orphans nothing can refresh, in a bundle nobody
-- can point at the source of. The strongest possible statement that a
-- connection belongs to one person, written into the one product decision 0043
-- said it was not making.
--
-- This migration says it the way 0043 meant it. The row survives its grant
-- holder: unowned, paused, and reconnectable in place by anyone who can write
-- in the workspace.
--
-- It is also 0016's argument, applied to a column 0016 did not reach. That
-- migration converted six foreign keys so that closing an account nulls the
-- attribution and leaves the row — "a workspace does not evaporate because the
-- person who opened it left". `connections.user_id` was written after it and
-- repeated the mistake it had just finished fixing.
--
-- TERMINOLOGY, because it is load-bearing. `user_id` is not the connection's
-- OWNER — the workspace owns it. It is the GRANT HOLDER: whose OAuth grant this
-- is, whose allowance the embeddings are charged to, and whose view of the
-- source decides which files are visible. Those are personal facts about a
-- person, and they are exactly the facts that can go away while the connection
-- stays useful.
-- =========================================================================

-- ---- the grant holder can leave -------------------------------------------
--
-- Found by definition rather than by name. The constraint is
-- `connections_user_id_fkey` on every install that ran 0043 unedited, and
-- naming it anyway would make this migration fail on one that did not.
do $$
declare
  con_name text;
begin
  select con.conname into con_name
  from pg_constraint con
  where con.conrelid = 'public.connections'::regclass
    and con.contype = 'f'
    and pg_get_constraintdef(con.oid) like '%(user_id)%auth.users%';

  if con_name is not null then
    execute format('alter table public.connections drop constraint %I', con_name);
  end if;
end $$;

alter table public.connections
  alter column user_id drop not null;

alter table public.connections
  add constraint connections_user_id_fkey
  foreign key (user_id) references auth.users (id) on delete set null;

comment on column public.connections.user_id is
  'The grant holder: whose OAuth grant this is, whose allowance its embeddings are charged to, and whose view of the source decides what syncs. NOT the owner - the workspace owns the connection. Null means the grant holder closed their account; the row survives, paused, and any member who can write may reconnect it in place.';

-- ---- why the engine stopped, as something a program can branch on ---------
--
-- `paused_reason` is free text written for a person to read, and until now it
-- was also the only thing saying WHAT happened. Two problems with that.
--
-- The interface has to decide whether to offer Resume or Reconnect, and it was
-- deciding by matching prose. A revoked Google grant and a folder that has
-- stopped listing files both arrive as a sentence, and the right answer to them
-- is different: one needs a new grant, the other needs somebody to look.
--
-- And `authenticated` held `update (paused_reason)` from 0043, so any member
-- who can write could rewrite the engine's explanation to anything at all, in a
-- column the interface prints. That grant is revoked below.
alter table public.connections
  add column if not exists paused_code text;

alter table public.connections
  drop constraint if exists connections_paused_code_check;

-- Nine codes and null, and null is a real value rather than a gap: it means a
-- person pressed Pause, which needs no explanation because they know.
--
-- Every one of these is a state the engine can already reach today; none is
-- speculative. `access_narrowed` is the one that is new, and it exists because
-- reconnecting a source with a different person's grant is otherwise a way to
-- delete most of a bundle. See `MIN_NARROWING` in `lib/connections/sync.ts`.
alter table public.connections
  add constraint connections_paused_code_check
  check (paused_code is null or paused_code in (
    -- A Drive connection with no folder chosen yet. Set at the end of the
    -- OAuth flow: there is nothing to sync until somebody picks one.
    'needs_folder',
    -- The grant holder is no longer a member of this workspace.
    'owner_left',
    -- The grant holder closed their Covan account, so `user_id` is null.
    'owner_gone',
    -- The provider refused in a way that will not get better by waiting: the
    -- grant was revoked, or the integration was removed at the source.
    'grant_revoked',
    -- Enough consecutive failures to be broken rather than unlucky.
    'repeated_failures',
    -- The operator removed this provider's OAuth client credentials from the
    -- deployment. Nothing about the connection is wrong.
    'provider_unconfigured',
    -- This build of Covan no longer knows how to sync that provider.
    'unknown_provider',
    -- The source suddenly shows far less than it did, which is what a
    -- reconnect with a narrower grant looks like from here. Nothing is
    -- removed; a person is asked.
    'access_narrowed',
    -- Restored from a workspace export, which carries no OAuth token.
    'restored'
  ));

comment on column public.connections.paused_code is
  'Why the engine paused this, as something a program can branch on. Null means a person paused it, which needs no explanation. paused_reason is the sentence for a human and is written by the engine only - see the revoke below.';

-- ---- somebody said the removal was fine ----------------------------------
--
-- The other half of `access_narrowed`, and without it the pause is a trap: the
-- run pauses because it would remove too much, a person presses Resume, and the
-- next run counts the same documents and pauses again, forever.
--
-- So resuming from that particular pause records a decision, and the next run
-- honours it once. Engine bookkeeping — not in the select grant below, because
-- there is nothing here for a client to read and nothing for one to write.
alter table public.connections
  add column if not exists removals_approved_at timestamptz;

comment on column public.connections.removals_approved_at is
  'Set when a person resumed a connection paused with access_narrowed, meaning "yes, really remove those". Cleared by the next run that acts on it.';

-- ---- policies -------------------------------------------------------------
--
-- Restated in full, because a policy cannot be amended — see
-- `routine-policy.static.test.ts` for what that costs when somebody forgets.
-- Every guard 0043 wrote is carried forward unchanged; what is added is the
-- orphan clause.
--
-- WHO MAY RECONNECT AN UNOWNED CONNECTION. `user_id = auth.uid()` is null-safe
-- in the useless direction: with a null `user_id` it evaluates to NULL, not
-- true, so an orphaned row would have fallen through to "admin only". That is
-- defensible and it is not what this is for. The whole point of surviving the
-- grant holder is that the workspace keeps its connection, and requiring an
-- admin to be the one who re-grants Drive access means a team without a
-- present admin cannot fix it at all. A writer may write documents into this
-- bundle by uploading them; reconnecting the source that fills it is the same
-- permission.
--
-- It is deliberately narrow: `user_id is null` and nothing else. A connection
-- with a living grant holder stays theirs and the admin's.
drop policy if exists "connections_update_owner_or_admin" on public.connections;
create policy "connections_update_owner_or_admin"
  on public.connections for update
  using (
    user_id = auth.uid()
    or public.is_workspace_admin(workspace_id)
    or (user_id is null and public.can_write_in_workspace(workspace_id))
  )
  with check (
    (
      user_id = auth.uid()
      or public.is_workspace_admin(workspace_id)
      or (user_id is null and public.can_write_in_workspace(workspace_id))
    )
    and public.can_write_in_workspace(workspace_id)
    and exists (
      select 1 from public.knowledge_bundles b
      where b.id = connections.bundle_id and b.workspace_id = connections.workspace_id
    )
  );

-- Deleting an orphan is the same argument. A connection nobody holds the grant
-- for is a dead row that every member can see and, until now, only an admin
-- could clear away.
drop policy if exists "connections_delete_owner_or_admin" on public.connections;
create policy "connections_delete_owner_or_admin"
  on public.connections for delete
  using (
    user_id = auth.uid()
    or public.is_workspace_admin(workspace_id)
    or (user_id is null and public.can_write_in_workspace(workspace_id))
  );

-- ---- grants ---------------------------------------------------------------
--
-- `paused_code` joins the readable set. `removals_approved_at` deliberately
-- does not: it is a decision the API records on somebody's behalf after
-- checking the pause it answers, and a client that could write it could skip
-- the check.
grant select (paused_code) on public.connections to authenticated;

-- The one grant this migration takes away, and the reason `paused_code` could
-- not simply have been added beside it. 0043 granted `update (paused_reason)`
-- so that resuming a connection could clear the engine's explanation — a real
-- need, met the wrong way. The consequence was that any member who can write
-- could set that column to anything, and the interface prints it: "Reconnect
-- your Google account at this link" is a sentence somebody could put on a
-- teammate's integrations page.
--
-- `PATCH /connections/:id` now clears it through the service role instead,
-- after the caller's own write to `status` has proved the policy admits them —
-- the same two-step the route already used for `config` and `next_sync_at`.
revoke update (paused_reason) on public.connections from authenticated;
