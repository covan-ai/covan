-- =========================================================================
-- Which answer you meant
--
-- The chat has had a thumbs-up and a thumbs-down under every reply since it
-- shipped. Clicking one filled in the icon and raised a toast that said
-- "Thanks for the feedback", and that was the whole of it: a `useState` map,
-- forgotten on reload, read by nothing and stored nowhere. Two buttons under
-- every answer in the product, collecting the single highest-signal thing this
-- product could be told — was that answer any good — into a variable.
--
-- The sign-in page's Remember me box was the same shape of bug and got the
-- same treatment: a control that reports success has to have done something.
--
-- The fix is not a ratings table. A one-click rating has to be changeable —
-- clicked twice, or changed from up to down — and `feedback` is deliberately
-- immutable, because an editable complaint is one its reader cannot trust they
-- have the original of. Bolting a toggle onto it would mean undoing that.
--
-- So the thumb stops pretending to be a rating and becomes what it should have
-- been in a product with three outside users: the opening of a sentence. It
-- opens the feedback dialog with the kind already chosen, and what gets stored
-- is what the person actually wrote. This column is the part the person should
-- not have to write — *which* answer they were looking at.
--
-- Prose plus a pointer beats a counter here. A tally of thumbs is worth
-- something at ten thousand replies a day; at this size, one sentence saying
-- what the answer got wrong is worth more than every counter in the schema.
-- =========================================================================

-- Nullable, and most rows will have it null: feedback sent from the sidebar is
-- about the product, not about a reply. `on delete set null` follows the rule
-- 0016 set and 0037 repeated — a note does not evaporate because the
-- conversation it was about was deleted, and the words are still readable
-- without it.
alter table public.feedback
  add column message_id uuid references public.messages (id) on delete set null;

comment on column public.feedback.message_id is
  'The reply this note is about, or null for feedback about the product at '
  'large. Set null when the message goes, so the note survives the '
  'conversation it describes.';

-- The reference has to be one the sender could actually see.
--
-- Not for secrecy — naming an id leaks nothing on its own — but because the
-- operator reads this column as "the answer they were looking at", and a
-- hand-written insert through the Data API could make that sentence false by
-- naming any message in the database. `exists` runs under the caller's own RLS,
-- so "a message you can see" is exactly what it means, with no second copy of
-- the messages policy written out here to drift from the first.
drop policy if exists "feedback_insert_own" on public.feedback;
create policy "feedback_insert_own"
  on public.feedback for insert to authenticated
  with check (
    user_id = auth.uid()
    and (workspace_id is null or public.is_workspace_member(workspace_id))
    and (
      message_id is null
      or exists (select 1 from public.messages m where m.id = feedback.message_id)
    )
  );

-- No new grant: 0041 granted `select, insert` on the table and a column added
-- to it inherits that. There is still no update policy, so the column is as
-- fixed as everything beside it.
