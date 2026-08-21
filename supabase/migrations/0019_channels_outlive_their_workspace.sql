-- 0019_channels_outlive_their_workspace.sql
--
-- A workspace could be made permanently undeletable by a routine in a
-- different workspace — one its admins cannot see and did not create.
--
-- Everything in this schema treats a delivery channel as belonging to a
-- PERSON. `routines_insert_own` and `routines_update_own` admit any channel
-- where `dc.user_id = auth.uid()` and never compare workspaces; the picker at
-- GET /delivery-channels is scoped by RLS to the caller, not to a workspace;
-- and the executor matches the channel on `user_id`, deliberately (see the
-- SCOPING note in worker/src/lib/routines/executor.ts). docs/routines.md says
-- so in as many words: "A channel belongs to the person who created it rather
-- than to the workspace." Using one from any workspace you are in is the
-- intended behaviour, not a loophole.
--
-- One column disagreed. `workspace_id` is written once, from the creator's
-- *active* workspace at the moment they added the channel (see POST
-- /delivery-channels), and after that nothing reads it — it is provenance.
-- But it cascaded. So:
--
--   1. Someone in workspaces A and B adds a channel while A is active.
--   2. They build a routine on an agent in B and pick that channel. Allowed.
--   3. A's admin deletes A. The cascade removes the channel; B's routine still
--      references it; `routines_delivery_channel_id_fkey` is NO ACTION
--      DEFERRABLE, so the check fires at commit and the whole delete is rolled
--      back with "violates foreign key constraint".
--
-- A's admin sees a foreign key error naming a table they have no rows in, and
-- there is no action available to them that fixes it — the routine holding
-- their workspace hostage lives somewhere they cannot reach. Measured against
-- a live database before this migration: the delete failed and the workspace
-- survived.
--
-- The fix is to let the column say what it means. `set null` keeps the channel
-- and its secret alive for the person who owns it, keeps B's routine
-- delivering, and lets A go. Deleting the PERSON is untouched: `user_id`
-- references auth.users on delete cascade, so their channels still leave with
-- them. Deleting a channel that is still wired to a routine is untouched too:
-- it still raises, which is the 409 the API returns.
--
-- Nulling rather than dropping the column: it still answers "where was this
-- added from" for every channel whose workspace is alive, which is all of them
-- until one is deleted. A null means "the workspace it was added from is
-- gone", which is true and worth being able to tell.

alter table public.delivery_channels
  alter column workspace_id drop not null;

alter table public.delivery_channels
  drop constraint if exists delivery_channels_workspace_id_fkey;

alter table public.delivery_channels
  add constraint delivery_channels_workspace_id_fkey
  foreign key (workspace_id) references public.workspaces (id) on delete set null;
