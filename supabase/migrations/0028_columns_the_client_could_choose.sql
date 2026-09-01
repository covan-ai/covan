-- 0028_columns_the_client_could_choose.sql
--
-- Two tables, one mistake: a policy that checks who you are and not what you
-- wrote. PostgREST is reachable with the anon key, so for every table the real
-- question is not "what does the route send" but "what could the client send
-- instead", and these two answered it badly.
--
-- chat_sessions. The insert policy checks user_id = auth.uid() and nothing
-- else, while 0008's select policy hands reads to every workspace member when
-- visibility = 'shared' — keyed on workspace_id, a column the writer chooses.
-- Foreign keys are enforced by the system and bypass RLS, so any real
-- workspace uuid is accepted, and nothing reconciles workspace_id against the
-- agent's own. A non-member — someone removed, or an invitee who saw the id in
-- GET /invitations/incoming — could insert a shared session into a workspace
-- they cannot read, post to it, and have chat.ts write genuine assistant
-- replies into it with the service-role client. The workspace then shows its
-- members a complete, realistic conversation authored by an outsider, which
-- they cannot delete because the delete policy is owner-only.
--
-- Reads were never affected. This is writing into a tenant, not reading out of
-- one, which is why isolation.test.ts stayed green.
--
-- ideas. The update policy specifies only USING, so Postgres reuses it as the
-- WITH CHECK — and it mentions neither created_by nor workspace_id. 0011 pins
-- created_by = auth.uid() on insert "so a member cannot attribute a card to
-- someone else"; update handed that straight back. Separately, neither the
-- update nor the delete policy calls can_write_in_workspace, so unlike every
-- other shared table touched by 0021 a viewer can rewrite and delete other
-- people's cards — against both 0021's role contract and the words in
-- src/lib/roles.ts. viewer.test.ts missed it by only ever checking that a
-- viewer can create a card in a session of their own.

-- ---- chat_sessions: the workspace must be yours, and the agent must be in it

drop policy if exists "chat_sessions_insert_owner" on public.chat_sessions;

create policy "chat_sessions_insert_owner"
  on public.chat_sessions for insert
  with check (
    user_id = auth.uid()
    and public.is_workspace_member(workspace_id)
    and exists (
      select 1 from public.agents a
      where a.id = chat_sessions.agent_id
        and a.workspace_id = chat_sessions.workspace_id
    )
  );

drop policy if exists "chat_sessions_update_owner" on public.chat_sessions;

create policy "chat_sessions_update_owner"
  on public.chat_sessions for update
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and public.is_workspace_member(workspace_id)
    and exists (
      select 1 from public.agents a
      where a.id = chat_sessions.agent_id
        and a.workspace_id = chat_sessions.workspace_id
    )
  );

-- ---- ideas: your own card, or a role that may write ------------------------

create or replace function public.ideas_created_by_is_immutable()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if new.created_by is distinct from old.created_by then
    raise exception 'a card''s author cannot be changed'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger trg_ideas_created_by_immutable
  before update on public.ideas
  for each row
  execute function public.ideas_created_by_is_immutable();

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
    and exists (
      select 1 from public.chat_sessions cs
      where cs.id = ideas.session_id
        and (
          cs.user_id = auth.uid()
          or (cs.visibility = 'shared' and public.is_workspace_member(cs.workspace_id))
        )
    )
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
    and exists (
      select 1 from public.chat_sessions cs
      where cs.id = ideas.session_id
        and (
          cs.user_id = auth.uid()
          or (cs.visibility = 'shared' and public.is_workspace_member(cs.workspace_id))
        )
    )
  );
