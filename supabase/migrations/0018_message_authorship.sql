-- 0018_message_authorship.sql
--
-- Two things about `messages` that the schema got wrong, and that nothing in
-- the suite looked at until now. They are the same column from two ends:
-- sender_id says who wrote a row, role says whose voice it is written in.
--
-- 1. ROLE WAS UNCONSTRAINED ON INSERT. 0009 replaced the collaborative-chat
--    policy with one requiring sender_id = auth.uid(), and its header claimed
--    that stopped a client writing an assistant row. It did not: the policy
--    never inspected `role`, there is no trigger on messages and no revoke, so
--    `authenticated` kept its PostgREST INSERT. A member could write
--    role='assistant' carrying their own sender_id into any session they could
--    see. In a shared session the other members' clients branch on role alone
--    and render it under the agent's name and avatar, and worker/src/lib/
--    history.ts replays it to the model as a prior assistant turn — so it is
--    both words in the agent's mouth and context poisoning.
--
-- 2. SENDER_ID BLOCKED ACCOUNT DELETION. 0008 added the column as a plain
--    reference to profiles, so NO ACTION. Deleting an account cascades its
--    profile, and any message that person had written in somebody else's
--    shared or brainstorm session then refused the delete. 0016 set out to make
--    accounts deletable and handled six columns this way; this is the seventh,
--    added afterwards and missed. tests/rls/deletion.test.ts passed throughout
--    because it never had one user write into another's session.

-- ---- 1. a client may only write in its own voice --------------------------

-- The server is unaffected: assistant rows are written through the
-- service-role client (worker/src/routes/chat.ts), which bypasses RLS
-- entirely, and they carry no sender_id at all.
drop policy if exists "messages_insert_user_self" on public.messages;

create policy "messages_insert_user_self"
  on public.messages for insert
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

-- ---- 2. a message outlives its author, without their name -----------------

-- `set null` rather than `cascade`, deliberately. Cascading would delete the
-- departing person's lines out of conversations belonging to people who are
-- still here — removing sentences from somebody else's transcript to satisfy
-- somebody else's erasure. Nulling the author keeps the conversation whole and
-- costs only the name: the chat view already renders the sender badge as
-- `{isShared && m.sender && ...}`, so a message with no sender simply appears
-- unattributed. `role` is still 'user', so it does not become an agent reply.
alter table public.messages
  drop constraint if exists messages_sender_id_fkey;

alter table public.messages
  add constraint messages_sender_id_fkey
  foreign key (sender_id) references public.profiles (id) on delete set null;
