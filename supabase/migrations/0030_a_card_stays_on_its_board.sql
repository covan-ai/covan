-- 0030_a_card_stays_on_its_board.sql
--
-- The whole-branch review of 0028 found a third column nobody reconciled.
-- 0028 pinned `workspace_id` to the parent session's and made `created_by`
-- immutable, but left `ideas.session_id` itself unpinned. PostgREST is
-- reachable with the anon key, so PATCH /rest/v1/ideas?id=eq.<theirs> with a
-- new session_id was always accepted: it re-parents the card onto a different
-- brainstorm board outright.
--
-- 0028's WITH CHECK does not catch this, and cannot by construction — it
-- compares workspace_id against `(select cs.workspace_id from chat_sessions cs
-- where cs.id = ideas.session_id)`, and that subquery runs against the *new*
-- row. After a re-parent, the new session is the parent, so the check is
-- satisfied against the very row that just moved. A WITH CHECK predicate has
-- no way to compare the new session_id against the old one, because it never
-- sees the old row — the same reason 0027 reached for a trigger over a policy
-- predicate for `routines.source_config`.
--
-- The consequence is contained rather than cross-tenant: the subquery still
-- runs under the caller's own RLS, so a non-member of the target session's
-- workspace gets NULL there and 0028's WITH CHECK still fails the write. But a
-- viewer — "Uses the agents. Changes none of them." per src/lib/roles.ts — can
-- move their own card onto a *shared* board they are only supposed to read,
-- which is the same class of bug 0028 exists to close.
--
-- The route is not the boundary either: updateIdeaSchema in
-- worker/src/routes/ideas.ts never accepts session_id, so the app has no
-- legitimate reason to change it after the card is created.
--
-- A separate trigger function rather than widening 0028's
-- ideas_created_by_is_immutable, because the two guard unrelated invariants
-- (who wrote the card vs. which board it lives on) with independent error
-- messages, and 0028 is an applied migration — this one only needs
-- `create or replace` on it if folding were the better shape, and here it
-- is not.

create or replace function public.ideas_session_id_is_immutable()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if new.session_id is distinct from old.session_id then
    raise exception 'a card cannot be moved to a different session'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger trg_ideas_session_id_immutable
  before update on public.ideas
  for each row
  execute function public.ideas_session_id_is_immutable();
