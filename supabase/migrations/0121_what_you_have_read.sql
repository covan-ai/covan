-- =========================================================================
-- What you have read
--
-- The Inbox (A4) marks a thread unread when something was written in it since
-- you last looked: an agent's reply, a routine's run, a colleague's message in
-- a thread they shared. That needs one fact per person per thread — when they
-- last read it — and nothing else. Unread is derived from it at read time
-- (`inbox_rows`, 0122): a message newer than `last_read_at` that somebody
-- other than you wrote. No counter is stored, so no counter can drift.
--
-- One row per (thread, person). Written by the person's own client through
-- the API (`POST /inbox/read`), so the policies are own-row only and the row
-- must point at a thread the person can see: marking a thread you cannot open
-- would be a way to learn that it exists.
--
-- Every thread that exists when this runs is marked read for its owner as of
-- now. Without that, the first Inbox anybody opened would list every reply
-- since their first day as unread, which is noise rather than news.
--
-- `mark_all_sessions_read` is the "Mark all read" button: one statement for
-- every thread the caller can see in a workspace, rather than a request per
-- row. Invoker, so the visibility it acts on is the policies' own.
-- =========================================================================

create table if not exists public.session_reads (
  session_id   uuid        not null references public.chat_sessions (id) on delete cascade,
  user_id      uuid        not null references auth.users (id) on delete cascade,
  workspace_id uuid        not null references public.workspaces (id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (session_id, user_id)
);

create index if not exists session_reads_user_idx
  on public.session_reads (user_id, workspace_id);

alter table public.session_reads enable row level security;

drop policy if exists "session_reads_select_own" on public.session_reads;
create policy "session_reads_select_own"
  on public.session_reads for select
  using (user_id = auth.uid());

drop policy if exists "session_reads_insert_own" on public.session_reads;
create policy "session_reads_insert_own"
  on public.session_reads for insert
  with check (
    user_id = auth.uid()
    and public.session_is_visible(session_id)
    and workspace_id = (select cs.workspace_id from public.chat_sessions cs where cs.id = session_id)
  );

drop policy if exists "session_reads_update_own" on public.session_reads;
create policy "session_reads_update_own"
  on public.session_reads for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and public.session_is_visible(session_id));

drop policy if exists session_reads_request_workspace on public.session_reads;
create policy session_reads_request_workspace on public.session_reads
  as restrictive for all to authenticated
  using ((select public.request_workspace()) is null
         or workspace_id = (select public.request_workspace()));

-- An upsert keyed on (session_id, user_id): the same columns both ways (0094).
revoke all on public.session_reads from anon, authenticated;
grant select on public.session_reads to authenticated;
grant insert (session_id, user_id, workspace_id, last_read_at) on public.session_reads to authenticated;
grant update (session_id, user_id, workspace_id, last_read_at) on public.session_reads to authenticated;
grant select, insert, update, delete on public.session_reads to service_role;

-- What came before this migration counts as read, for the owner of each thread.
insert into public.session_reads (session_id, user_id, workspace_id, last_read_at)
select cs.id, cs.user_id, cs.workspace_id, now()
  from public.chat_sessions cs
 where cs.user_id is not null
on conflict (session_id, user_id) do nothing;

-- The newest message of a thread is what every Inbox row shows and what unread
-- is measured against; 0001's index on session_id alone answers neither.
create index if not exists messages_session_created_idx
  on public.messages (session_id, created_at desc);

create or replace function public.mark_all_sessions_read(p_workspace_id uuid)
returns integer
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_count integer;
begin
  if auth.uid() is null or not public.is_workspace_member(p_workspace_id) then
    raise exception 'not a member of this workspace' using errcode = '42501';
  end if;

  insert into public.session_reads (session_id, user_id, workspace_id, last_read_at)
  select cs.id, auth.uid(), cs.workspace_id, now()
    from public.chat_sessions cs
   where cs.workspace_id = p_workspace_id
  on conflict (session_id, user_id) do update set last_read_at = excluded.last_read_at;

  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke all on function public.mark_all_sessions_read(uuid) from public, anon;
grant execute on function public.mark_all_sessions_read(uuid) to authenticated, service_role;
