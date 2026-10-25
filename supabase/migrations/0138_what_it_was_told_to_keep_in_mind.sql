-- =========================================================================
-- What it was told to keep in mind
--
-- "Remember that invoices go out on the first working day." "Remember I want
-- the short version." Said to an agent today, either sentence lasts as long
-- as the thread it was said in. This is where it goes instead: one row per
-- sentence, at most 280 characters, read back into the agent's instructions
-- in later conversations.
--
--   about   'team'    a fact about how this team works.
--           'person'  a fact about the person who said it.
--   scope   'owner'      only the person who wrote it (`created_by`) sees it.
--           'workspace'  every member sees it; every writer may correct or
--                        remove it.
--
-- `about` is what the note is about and `scope` is who reads it, and they are
-- separate on purpose. A note about a person is never shared — the check below
-- says so, whoever is asking. A note about the team said in a private thread
-- starts as the asker's and stays theirs until they press "Share with team":
-- 0106's rule for a bundle ("yours until you share it"), applied to a
-- sentence. Said in a shared thread, it may be written shared at once, since
-- the room it was said in was shared already.
--
-- Only the author moves a note from private to shared, and nobody moves one
-- back. An admin can correct or delete a shared note, as any writer can, but
-- cannot read, share or delete somebody's private one — the line 0098 drew
-- for connections and 0106 for bundles, and the one 0076 drew for opt-outs
-- ("self only, including for admins, and that is the point"). A viewer may
-- keep private notes, as a viewer may keep a private thread, and may not
-- write the team's.
--
-- A note names the thread it came from, when it came from one, and that has
-- to be a thread its author can see: 0042's reasoning for `feedback.
-- message_id`, where the reader takes the pointer as "where this was said".
-- It is `on delete set null`, as 0016 and 0037 keep a note when the
-- conversation it was about goes.
--
-- WHEN THE AUTHOR'S ACCOUNT GOES. Their shared notes stay, authorless, the way
-- 0016 keeps what somebody wrote for the team after they leave. Their private
-- ones go with them: a private note with nobody to own it is a row no policy
-- will ever show anyone or let anyone delete. A `before delete` trigger on
-- `profiles` removes them before the foreign key nulls the author on the rest,
-- and the `owner_needs_author` check makes forgetting that a failed deletion
-- rather than a silent orphan.
--
-- Not in the Realtime publication: the Settings page reads the list when it
-- opens, and nothing watches it change. The caps (100 private notes per
-- person per workspace, 200 shared per workspace) live in the tool and the
-- route, which can say why they refused, not here.
-- =========================================================================

create table if not exists public.memory_notes (
  id                uuid        primary key default gen_random_uuid(),
  workspace_id      uuid        not null references public.workspaces (id) on delete cascade,
  created_by        uuid        references public.profiles (id) on delete set null,
  about             text        not null,
  scope             text        not null default 'owner',
  text              text        not null,
  source            text        not null default 'agent',
  source_session_id uuid        references public.chat_sessions (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

alter table public.memory_notes drop constraint if exists memory_notes_about_known;
alter table public.memory_notes add constraint memory_notes_about_known
  check (about in ('person', 'team'));

alter table public.memory_notes drop constraint if exists memory_notes_scope_known;
alter table public.memory_notes add constraint memory_notes_scope_known
  check (scope in ('owner', 'workspace'));

alter table public.memory_notes drop constraint if exists memory_notes_source_known;
alter table public.memory_notes add constraint memory_notes_source_known
  check (source in ('agent', 'person'));

alter table public.memory_notes drop constraint if exists memory_notes_text_length;
alter table public.memory_notes add constraint memory_notes_text_length
  check (char_length(text) between 1 and 280);

-- A note about a person is never shared.
alter table public.memory_notes drop constraint if exists memory_notes_person_is_private;
alter table public.memory_notes add constraint memory_notes_person_is_private
  check (about = 'team' or scope = 'owner');

-- A private note nobody owns is one nobody can ever read; see the header.
alter table public.memory_notes drop constraint if exists memory_notes_owner_needs_author;
alter table public.memory_notes add constraint memory_notes_owner_needs_author
  check (scope = 'workspace' or created_by is not null);

-- The same sentence twice from the same person is one note.
create unique index if not exists memory_notes_unique_text
  on public.memory_notes (workspace_id, created_by, lower(text));

create index if not exists memory_notes_workspace_idx
  on public.memory_notes (workspace_id, scope, created_at);

comment on table public.memory_notes is
  'Sentences the agent was told to keep in mind (0138). about: person or team; scope: owner (only created_by reads it) or workspace (every member reads it, every writer edits it). A person note is never shared; only created_by shares a team note, and nobody unshares one.';

alter table public.memory_notes enable row level security;

-- ===========================================================================
-- policies
-- ===========================================================================

drop policy if exists "memory_notes_select_member" on public.memory_notes;
create policy "memory_notes_select_member"
  on public.memory_notes for select
  using (
    public.is_workspace_member(workspace_id)
    and (created_by = auth.uid() or scope = 'workspace')
  );

drop policy if exists "memory_notes_insert_own" on public.memory_notes;
create policy "memory_notes_insert_own"
  on public.memory_notes for insert
  with check (
    created_by = auth.uid()
    and public.is_workspace_member(workspace_id)
    and (scope = 'owner' or public.can_write_in_workspace(workspace_id))
    and (
      source_session_id is null
      or exists (
        select 1 from public.chat_sessions s
        where s.id = memory_notes.source_session_id
          and s.workspace_id = memory_notes.workspace_id
      )
    )
  );

-- The check is the insert's rule again, so a viewer cannot share their own
-- private note by updating it into a row they could not have inserted.
drop policy if exists "memory_notes_update_member" on public.memory_notes;
create policy "memory_notes_update_member"
  on public.memory_notes for update
  using (
    public.is_workspace_member(workspace_id)
    and (
      created_by = auth.uid()
      or (scope = 'workspace' and public.can_write_in_workspace(workspace_id))
    )
  )
  with check (
    public.is_workspace_member(workspace_id)
    and (scope = 'owner' or public.can_write_in_workspace(workspace_id))
  );

drop policy if exists "memory_notes_delete_member" on public.memory_notes;
create policy "memory_notes_delete_member"
  on public.memory_notes for delete
  using (
    public.is_workspace_member(workspace_id)
    and (
      created_by = auth.uid()
      or (scope = 'workspace' and public.can_write_in_workspace(workspace_id))
    )
  );

-- As every workspace table (0087): a key made for one workspace reaches no
-- other workspace's notes.
drop policy if exists memory_notes_request_workspace on public.memory_notes;
create policy memory_notes_request_workspace on public.memory_notes
  as restrictive for all to authenticated
  using ((select public.request_workspace()) is null
         or workspace_id = (select public.request_workspace()))
  with check ((select public.request_workspace()) is null
              or workspace_id = (select public.request_workspace()));

-- ===========================================================================
-- sharing goes one way, and only by the author
-- ===========================================================================

-- A policy cannot compare the new row with the old, so this is a trigger, as
-- 0106's `knowledge_bundles_guard_scope` is. The service role is let through
-- as it is there: nothing in the engine changes a scope, and a repair by hand
-- should not need the trigger dropped.
create or replace function public.memory_notes_guard_scope()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if new.scope is distinct from old.scope
     and not (old.scope = 'owner'
              and new.scope = 'workspace'
              and old.created_by is not distinct from auth.uid()) then
    raise exception 'only the person who wrote this note can share it, and a shared note stays shared'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.memory_notes_guard_scope() from public, anon;

drop trigger if exists trg_memory_notes_guard_scope on public.memory_notes;
create trigger trg_memory_notes_guard_scope
  before update on public.memory_notes
  for each row execute function public.memory_notes_guard_scope();

-- ===========================================================================
-- a departed author's private notes go with them
-- ===========================================================================

-- Definer, because an account is deleted by GoTrue's cascade or the service
-- role, and neither is a member the policies above would let delete these.
create or replace function public.profiles_take_private_notes()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  delete from public.memory_notes
   where created_by = old.id
     and scope = 'owner';
  return old;
end;
$$;

revoke all on function public.profiles_take_private_notes() from public, anon;

drop trigger if exists trg_profiles_take_private_notes on public.profiles;
create trigger trg_profiles_take_private_notes
  before delete on public.profiles
  for each row execute function public.profiles_take_private_notes();

-- ===========================================================================
-- grants
-- ===========================================================================

-- Named rather than inherited, for all three roles: 0076 found that a new
-- table's default privileges hand `service_role` everything, truncate and
-- trigger included, and revoked them there for the same reason as here.
revoke all on public.memory_notes from anon, authenticated, service_role;
grant select, delete on public.memory_notes to authenticated;
grant insert (workspace_id, created_by, about, scope, text, source, source_session_id)
  on public.memory_notes to authenticated;
grant update (scope, text, updated_at) on public.memory_notes to authenticated;
grant select, insert, update, delete on public.memory_notes to service_role;
