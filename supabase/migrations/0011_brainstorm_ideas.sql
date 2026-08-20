-- Brainstorm sessions: a session kind plus a shared kanban idea board.

-- ---- chat_sessions.kind --------------------------------------------------
alter table public.chat_sessions
  add column if not exists kind text not null default 'chat'
    check (kind in ('chat', 'brainstorm'));

-- ---- ideas table ---------------------------------------------------------
create table if not exists public.ideas (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.chat_sessions (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id),
  title text not null,
  detail text,
  stage text not null default 'review'
    check (stage in ('review', 'promising', 'in_progress', 'parked')),
  position numeric not null default 0,
  created_by uuid references auth.users (id),
  source_message_id uuid references public.messages (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ideas_board_idx
  on public.ideas (session_id, stage, position);

alter table public.ideas enable row level security;

-- ---- ideas RLS: gate on parent-session visibility ------------------------
-- Anyone who can read the parent session (owner, or shared + workspace member)
-- can read and write its ideas. INSERT additionally pins created_by to the
-- caller so a member cannot attribute a card to someone else.

drop policy if exists "ideas_select_session_visible" on public.ideas;
create policy "ideas_select_session_visible"
  on public.ideas for select
  using (
    exists (
      select 1 from public.chat_sessions cs
      where cs.id = ideas.session_id
        and (
          cs.user_id = auth.uid()
          or (cs.visibility = 'shared' and public.is_workspace_member(cs.workspace_id))
        )
    )
  );

drop policy if exists "ideas_insert_session_visible" on public.ideas;
create policy "ideas_insert_session_visible"
  on public.ideas for insert
  with check (
    created_by = auth.uid()
    and exists (
      select 1 from public.chat_sessions cs
      where cs.id = ideas.session_id
        and (
          cs.user_id = auth.uid()
          or (cs.visibility = 'shared' and public.is_workspace_member(cs.workspace_id))
        )
    )
  );

drop policy if exists "ideas_update_session_visible" on public.ideas;
create policy "ideas_update_session_visible"
  on public.ideas for update
  using (
    exists (
      select 1 from public.chat_sessions cs
      where cs.id = ideas.session_id
        and (
          cs.user_id = auth.uid()
          or (cs.visibility = 'shared' and public.is_workspace_member(cs.workspace_id))
        )
    )
  );

drop policy if exists "ideas_delete_session_visible" on public.ideas;
create policy "ideas_delete_session_visible"
  on public.ideas for delete
  using (
    exists (
      select 1 from public.chat_sessions cs
      where cs.id = ideas.session_id
        and (
          cs.user_id = auth.uid()
          or (cs.visibility = 'shared' and public.is_workspace_member(cs.workspace_id))
        )
    )
  );

-- ---- Realtime publication ------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public' and tablename = 'ideas'
  ) then
    alter publication supabase_realtime add table public.ideas;
  end if;
end $$;

-- DELETE events must carry session_id (not just the PK) so Realtime's
-- session_id=eq.<id> filter matches deletions for board subscribers.
alter table public.ideas replica identity full;
