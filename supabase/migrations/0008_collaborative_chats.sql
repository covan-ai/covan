-- Collaborative chats: per-session visibility, sender attribution, and Realtime.

-- ---- schema -------------------------------------------------------------

alter table public.chat_sessions
  add column if not exists visibility text not null default 'private'
    check (visibility in ('private', 'shared')),
  add column if not exists workspace_id uuid references public.workspaces (id);

-- Backfill workspace_id from each session's agent (agents are workspace-scoped).
update public.chat_sessions cs
set workspace_id = a.workspace_id
from public.agents a
where a.id = cs.agent_id
  and cs.workspace_id is null;

create index if not exists chat_sessions_workspace_id_idx
  on public.chat_sessions (workspace_id);

-- sender_id references profiles so PostgREST can embed sender:profiles(...).
alter table public.messages
  add column if not exists sender_id uuid references public.profiles (id);

-- Backfill existing user messages to their session owner.
update public.messages m
set sender_id = cs.user_id
from public.chat_sessions cs
where cs.id = m.session_id
  and m.role = 'user'
  and m.sender_id is null;

create index if not exists messages_sender_id_idx on public.messages (sender_id);

-- ---- chat_sessions RLS: owner OR shared-and-member for reads --------------

drop policy if exists "chat_sessions_select_owner" on public.chat_sessions;
create policy "chat_sessions_select_owner_or_shared"
  on public.chat_sessions for select
  using (
    user_id = auth.uid()
    or (visibility = 'shared' and public.is_workspace_member(workspace_id))
  );

-- INSERT/UPDATE/DELETE stay owner-only (visibility toggle is an owner action).
-- (chat_sessions_insert_owner / _update_owner / _delete_owner are unchanged.)

-- ---- messages RLS: gate on parent-session visibility ---------------------

drop policy if exists "messages_select_owner" on public.messages;
create policy "messages_select_session_visible"
  on public.messages for select
  using (
    exists (
      select 1 from public.chat_sessions cs
      where cs.id = messages.session_id
        and (
          cs.user_id = auth.uid()
          or (cs.visibility = 'shared' and public.is_workspace_member(cs.workspace_id))
        )
    )
  );

drop policy if exists "messages_insert_owner" on public.messages;
create policy "messages_insert_session_visible"
  on public.messages for insert
  with check (
    (role = 'assistant' or sender_id = auth.uid())
    and exists (
      select 1 from public.chat_sessions cs
      where cs.id = messages.session_id
        and (
          cs.user_id = auth.uid()
          or (cs.visibility = 'shared' and public.is_workspace_member(cs.workspace_id))
        )
    )
  );

-- UPDATE/DELETE on messages stay as-is (owner of the parent session only).

-- ---- touch_session: bump updated_at for any viewer ----------------------
-- The reply driver in /chat/stream may not own a shared session, so the
-- owner-only UPDATE policy would block a plain updated_at bump. This RPC does
-- it under definer rights, still gated on the caller being able to see it.

create or replace function public.touch_session(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.chat_sessions cs
  set updated_at = now()
  where cs.id = p_session_id
    and (
      cs.user_id = auth.uid()
      or (cs.visibility = 'shared' and public.is_workspace_member(cs.workspace_id))
    );
end;
$$;

grant execute on function public.touch_session(uuid) to authenticated;

-- ---- Realtime publication ------------------------------------------------
-- Add tables to the supabase_realtime publication (idempotent guard).

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public' and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public' and tablename = 'chat_sessions'
  ) then
    alter publication supabase_realtime add table public.chat_sessions;
  end if;
end $$;
