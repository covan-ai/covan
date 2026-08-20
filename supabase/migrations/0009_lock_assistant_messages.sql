-- Assistant messages are server-authoritative: only the worker's service-role
-- client (which bypasses RLS) may insert them. Clients may insert their own
-- user messages only. This replaces the collaborative-chat INSERT policy,
-- which allowed a role='assistant' branch that let any shared-session member
-- forge an assistant reply.

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
