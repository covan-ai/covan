-- Every client-written message must name the person who wrote it.
--
-- This replaces the collaborative-chat INSERT policy, whose `role = 'assistant'`
-- branch let any member of a shared session insert a message with no sender at
-- all. The check below requires sender_id = auth.uid() unconditionally, so a
-- client-written row always carries its author, and the unattributed rows the
-- worker writes for the assistant are ones no client can produce.
--
-- What it does not do is constrain `role`. The policy never inspects it, there
-- is no trigger on messages and no revoke, so `authenticated` keeps its
-- PostgREST INSERT: a member can write role='assistant' carrying their own
-- sender_id into any session they can see, and the chat UI, which branches on
-- role alone, renders it under the agent's name and avatar.

drop policy if exists "messages_insert_session_visible" on public.messages;

create policy "messages_insert_user_self"
  on public.messages for insert
  with check (
    sender_id = auth.uid()
    and exists (
      select 1 from public.chat_sessions cs
      where cs.id = messages.session_id
        and (
          cs.user_id = auth.uid()
          or (cs.visibility = 'shared' and public.is_workspace_member(cs.workspace_id))
        )
    )
  );
