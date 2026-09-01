-- =========================================================================
-- Who put this document here
--
-- `documents` knows which bundle it is in and nothing about the person who
-- uploaded it. That is enough for access — a bundle belongs to a workspace and
-- the workspace grants the reading — and it stops being enough at exactly one
-- moment: somebody asks for everything they contributed to be removed.
--
-- `DELETE /account` deletes the workspaces nobody else is in and leaves the
-- ones that still have members, which is the right answer for the room. It
-- means the leaver's documents stay, readable by the team, and no query could
-- find them even if we decided they should go. It matters most for a file
-- dropped into a private chat: it becomes workspace knowledge the moment it is
-- embedded, and until now nothing recorded whose file it was.
--
-- This column does not decide any of that. It is the fact the decision needs,
-- and the reason to add it before the decision is made is that it cannot be
-- backfilled. Every document that exists today has no answer and will stay
-- null forever; the column only ever tells the truth about uploads that come
-- after it. Each day it does not exist is another day of documents it can
-- never speak for.
--
-- Nullable, and not load-bearing. It says who uploaded a thing, not whose it
-- is — the same standing as `created_by` on workspaces, agents and bundles,
-- and it follows their rule from 0016: the reference is `on delete set null`,
-- so a document does not evaporate because its uploader left. Attribution
-- survives its author by becoming anonymous, which is also what an account
-- closure should leave behind.

alter table public.documents
  add column created_by uuid default auth.uid() references auth.users (id) on delete set null;

comment on column public.documents.created_by is
  'Who uploaded this, or null: for every document that predates this column, '
  'and for anything written by the service role. Attribution, not ownership — '
  'access comes from the bundle''s workspace.';

-- The default is the whole mechanism, and the policy is what makes it honest.
--
-- Nothing in the API sends this column: `POST /bundles/:id/documents/upload`
-- inserts through the caller's own client, so `auth.uid()` fills it in and
-- there is no code path that could get it wrong by forgetting. But the Data API
-- is reachable directly, and a hand-written insert can name any column it
-- likes. Without the check below, a member could file their upload under a
-- colleague's name — which is worse than no attribution at all, because the
-- erasure request this column exists to answer would then delete the wrong
-- person's documents, or miss the right one's.
--
-- `is null` stays allowed: the service role inserts with no `auth.uid()`, and
-- the honest record of that is null rather than a failure.

drop policy if exists "documents_insert_member" on public.documents;
create policy "documents_insert_member"
  on public.documents for insert
  with check (
    (created_by is null or created_by = auth.uid())
    and exists (
      select 1 from public.knowledge_bundles b
      where b.id = documents.bundle_id and public.can_write_in_workspace(b.workspace_id)
    )
  );

-- An update must not be able to do what the insert cannot, and this is a
-- trigger rather than a policy for a reason worth writing down.
--
-- `PATCH` on a document is how a file moves between bundles
-- (worker/src/routes/documents.ts), and any writer in the workspace may make
-- that move — including on a document somebody else uploaded. So the obvious
-- `with check (created_by = auth.uid())` would be wrong twice over: it would
-- refuse a legitimate move of a colleague's file, and it still would not say
-- what we mean. RLS's `with check` sees only the new row; "this column may not
-- change" is a statement about both, and only a trigger can see both.
--
-- Without it there is a second door to the same forgery the insert check
-- closes: upload as yourself, then rewrite `created_by` to a colleague. The
-- erasure request this column exists to answer would then reach the wrong
-- person's documents.
--
-- The service role is exempt on purpose. It is the only thing that could ever
-- need to correct this column, and it is not reachable from a browser.

-- Not `security definer`: it reads only the row in front of it and the caller's
-- own uid, so it needs no privilege the caller does not already have. The
-- search path is still pinned, because a function that can be reached from a
-- request should not resolve `auth.uid` through whatever the caller set.
create or replace function public.documents_pin_created_by()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if auth.uid() is not null and new.created_by is distinct from old.created_by then
    raise exception 'created_by cannot be changed'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_documents_pin_created_by on public.documents;
create trigger trg_documents_pin_created_by
  before update on public.documents
  for each row
  execute function public.documents_pin_created_by();
