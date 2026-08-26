-- 0026_the_other_half_of_authorship.sql
--
-- 0018 fixed this on INSERT and said so in its header: a client must only ever
-- write in its own voice, because the other members' clients branch on `role`
-- alone and render it under the agent's name and avatar, and history.ts
-- replays it to the model as a prior assistant turn. Words in the agent's
-- mouth, and context poisoning, from one row.
--
-- It only ever changed messages_insert_user_self. messages_update_owner has
-- been sitting here untouched since 0001, and its USING and WITH CHECK are the
-- same expression — "the parent session is mine" — which inspects neither
-- `role` nor `sender_id`. 0023 grants `authenticated` a table-level UPDATE and
-- the anon key ships in the browser bundle, so one PATCH to PostgREST does
-- through UPDATE precisely what 0018 stopped through INSERT.
--
-- Two changes, and the second is not merely tidying. The WITH CHECK now
-- mirrors 0018's. And the USING narrows from "any row in a session I own" to
-- "a row I wrote": the route that needs this policy is PATCH /messages/:id,
-- which edits your own line, and the old predicate let the owner of a shared
-- session rewrite anyone else's contribution to it. Editing someone else's
-- sentence in a transcript they are still reading was never intended.
--
-- The server is unaffected, for the same reason 0018 gave: assistant rows are
-- written through the service-role client in worker/src/routes/chat.ts, which
-- bypasses RLS entirely, and they carry no sender_id at all.

drop policy if exists "messages_update_owner" on public.messages;

create policy "messages_update_owner"
  on public.messages for update
  using (
    sender_id = auth.uid()
    and role = 'user'
    and exists (
      select 1 from public.chat_sessions cs
      where cs.id = messages.session_id
        and (
          cs.user_id = auth.uid()
          or (cs.visibility = 'shared' and public.is_workspace_member(cs.workspace_id))
        )
    )
  )
  with check (
    sender_id = auth.uid()
    and role = 'user'
    and exists (
      select 1 from public.chat_sessions cs
      where cs.id = messages.session_id
        and (
          cs.user_id = auth.uid()
          or (cs.visibility = 'shared' and public.is_workspace_member(cs.workspace_id))
        )
    )
  );
