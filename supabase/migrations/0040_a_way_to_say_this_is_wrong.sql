-- =========================================================================
-- A way to say this is wrong
--
-- The first person outside the team to walk through a new account found four
-- defects in five minutes, and the only reason anybody heard about them is
-- that they were a friend with the owner's phone number. Everyone else who
-- hits one of those has no way to say so from inside the product: the app
-- offers a documentation link and a sign-out button, and nothing that points
-- back at the people who wrote it.
--
-- So: one table, written by the person, read by whoever runs the install. Not
-- a support system — there is no ticket, no status, no reply. Saying less than
-- that would be a lie, and a "we'll get back to you" this software cannot keep
-- is worse than an honest "this is recorded".
--
-- What it is NOT, deliberately:
--
--   Not workspace content. Feedback is addressed to the operator, not to the
--   team, so no colleague can read it — including an admin. `/export` does not
--   carry it out and the Team page cannot show it. A box that says "tell us
--   what is broken" while the person who broke it is reading over your
--   shoulder is not a feedback box.
--
--   Not durable past the account. `on delete cascade`, so closing an account
--   takes what that person wrote with it, the same way it takes their
--   conversations. Documents are anonymised instead because other people's
--   answers stand on them (0037); nothing stands on feedback, so there is no
--   case for keeping the words of somebody who has left.
-- =========================================================================

create table if not exists public.feedback (
  id           uuid        primary key default gen_random_uuid(),

  -- Defaulted rather than sent. The insert policy pins it to `auth.uid()`
  -- anyway, so the column is filled from the verified token and there is no
  -- code path that could get it wrong by forgetting.
  user_id      uuid        not null default auth.uid()
                           references auth.users (id) on delete cascade,

  -- Which room they were standing in. Nullable because a person can be
  -- between workspaces — and because this is context for the reader, not a
  -- claim about who the feedback belongs to.
  workspace_id uuid        references public.workspaces (id) on delete set null,

  kind         text        not null default 'other'
                           check (kind in ('problem', 'idea', 'other')),

  -- Bounded at both ends. The lower bound is the interesting one: a row whose
  -- message is whitespace is indistinguishable from a mis-click, and there is
  -- nothing to read.
  message      text        not null
                           check (length(btrim(message)) between 1 and 4000),

  -- The page they were on when they pressed the button, so nobody has to
  -- describe where they were. A path only — never a full URL, which on some
  -- routes would carry ids and a query string nobody meant to send. The dialog
  -- shows this line before it is sent; collecting context invisibly is the
  -- thing the privacy page promises there is none of.
  path         text        check (length(path) <= 200),

  created_at   timestamptz not null default now()
);

alter table public.feedback enable row level security;

-- The grant 0023 requires, and it is deliberately not the usual four verbs.
-- Supabase stopped granting DML on new tables in `public`, so without this every
-- request answers 42501 and the policies below never run at all. `select` and
-- `insert` are the whole of what this table supports: there is no update policy
-- and no delete policy, and granting verbs no policy would ever satisfy would
-- say the opposite of what the paragraph after the policies says.
--
-- `service_role` is left off on purpose. It bypasses RLS by definition, and
-- nothing in the Worker writes here through the service client — the route
-- inserts through the caller's own client, which is what makes the insert
-- policy the boundary rather than a formality.
grant select, insert on public.feedback to authenticated;

-- Reading. Your own, and only ever your own — see the note above about who
-- feedback is addressed to. There is no admin view because there is no admin
-- read: the operator reaches this table through the database, not the app.
drop policy if exists "feedback_select_own" on public.feedback;
create policy "feedback_select_own"
  on public.feedback for select to authenticated
  using (user_id = auth.uid());

-- Writing. Two forgeries to close, and the second is the one that is easy to
-- miss: the Data API is reachable directly with the public anon key, so a
-- hand-written insert can name any column it likes. Without the workspace
-- check, anybody could file feedback against a workspace they have never been
-- in — which is not a leak, but it is a way to put words in a stranger's room
-- and have the operator read them as coming from inside it.
drop policy if exists "feedback_insert_own" on public.feedback;
create policy "feedback_insert_own"
  on public.feedback for insert to authenticated
  with check (
    user_id = auth.uid()
    and (workspace_id is null or public.is_workspace_member(workspace_id))
  );

-- No update policy and no delete policy, which is a decision rather than an
-- omission. What was sent is what was sent: an editable record of a complaint
-- is one the operator cannot trust they are reading the original of, and the
-- interface offers no list to edit it from in any case. The account's own
-- closure is the eraser, and it is the cascade above rather than a policy.

comment on table public.feedback is
  'What somebody told the operator, from inside the product. Written by the '
  'author, read by whoever runs the install — never by a colleague. Goes with '
  'the account when it closes.';
