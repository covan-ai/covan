-- =========================================================================
-- An answer you can go back to
--
-- Regenerate deletes. Pressing it drops the reply that was there, asks again,
-- and there is no way back — so the question it really asks is "are you sure
-- the next answer will be better than this one", which is not a question
-- anybody can answer before seeing the next answer. People stop pressing it.
--
-- Two columns turn that into a choice instead of a gamble.
--
-- `original_message_id` points at the FIRST version of an answer, not at the
-- one immediately before it. A chain of "replaces the previous" is the shape
-- that suggests itself and it is the wrong one: reading it back needs a
-- recursive walk, and every read of a conversation would do that walk for
-- every answer in it. Pointing every version at the same root makes the whole
-- set one predicate — `id = root or original_message_id = root` — and makes
-- "which version am I on" an ordering rather than a traversal.
--
-- `superseded_at` is what hides the versions nobody is looking at. Null is the
-- one on screen. It is a timestamp rather than a boolean because the useful
-- question later is not only which version is showing but when the others
-- stopped: an agent that gets regenerated to death is a fact about the agent,
-- and `0041`'s feedback table is not going to record it.
--
-- Exactly one row per chain has `superseded_at is null`. That is an invariant
-- the database cannot express — it is a condition across rows, and the
-- partial unique index that would say it needs the root in a column the root
-- itself does not have. It is held by the one writer instead: assistant rows
-- are server-authoritative (RLS forbids a client from writing one at all), so
-- every version and every supersede goes through the service client in
-- `routes/chat.ts` and `routes/messages.ts`.
--
-- No policy change, for that same reason. `messages_select_session_visible`
-- (0031) already decides who may read these rows and both columns ride on it.
-- `messages_update_owner` (0031) pins a member to `role = 'user'`, so no
-- client can supersede anything; the server does it with the service role, the
-- way it already writes the replies themselves.
--
-- Nothing changes for an existing conversation. Every row that exists has both
-- columns null, which reads as "the only version of itself, and showing".
-- =========================================================================

alter table public.messages
  add column if not exists original_message_id uuid references public.messages (id) on delete cascade,
  add column if not exists superseded_at timestamptz;

-- Only a reply has versions.
--
-- The same shape as `messages_grounding_valid` (0039) and for the same reason:
-- a member may write their own question, and without this they could stamp it
-- as superseded and take their own turn out of a transcript somebody else is
-- reading — or point it at an answer and put it in a version chain it has no
-- business being in. The role half is the security half.
alter table public.messages
  add constraint messages_version_valid check (
    role = 'assistant'
    or (original_message_id is null and superseded_at is null)
  );

-- The version chain, read from any member of it.
create index if not exists idx_messages_original_message_id
  on public.messages (original_message_id)
  where original_message_id is not null;

-- The transcript, which after this is "the messages in this session that are
-- not superseded, oldest first". Partial, because the superseded rows are the
-- ones this index exists to skip and there is no query that wants them mixed
-- in — the version picker asks for a chain by root, which is the index above.
create index if not exists idx_messages_session_visible
  on public.messages (session_id, created_at)
  where superseded_at is null;

-- =========================================================================
-- Switching which version shows
--
-- One statement, because the alternative is two and the window between them
-- is a conversation with no answer in it. Superseding the chain and then
-- un-superseding one of them leaves zero rows visible for as long as the
-- second statement takes; doing it the other way round leaves two. Neither is
-- a state a reader should ever be able to catch, and a `case` in a single
-- update means neither exists.
--
-- `security definer` for the same reason `touch_session` (0008) is: the write
-- crosses rows a client is not allowed to write. And, like that function, the
-- permission check is *inside* — owner of the conversation, which is the rule
-- `messages_delete_owner` (0031) already applies to every other way of
-- rewriting a transcript. A caller who does not own it matches nothing, so the
-- function does nothing; `routes/messages.ts` checks first so the interface
-- gets an honest 403 rather than a silent success.
--
-- `coalesce(superseded_at, now())` rather than a bare `now()`: a version that
-- was already put aside was put aside at some point, and rewriting that
-- timestamp every time somebody flicks between two answers would turn the
-- column into a record of the last click.
-- =========================================================================

create or replace function public.show_message_version(p_message_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_root uuid;
  v_session uuid;
begin
  select coalesce(m.original_message_id, m.id), m.session_id
    into v_root, v_session
    from public.messages m
    join public.chat_sessions cs on cs.id = m.session_id
   where m.id = p_message_id
     and m.role = 'assistant'
     and cs.user_id = auth.uid();

  if v_root is null then
    return;
  end if;

  update public.messages
     set superseded_at = case
           when id = p_message_id then null
           else coalesce(superseded_at, now())
         end
   where session_id = v_session
     and (id = v_root or original_message_id = v_root);
end;
$$;

grant execute on function public.show_message_version(uuid) to authenticated;
