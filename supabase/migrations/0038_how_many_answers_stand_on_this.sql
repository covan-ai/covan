-- =========================================================================
-- How many answers stand on this document
--
-- 0005 stored which documents grounded a reply; #54 started storing their ids
-- alongside the names, so a citation is a link rather than a string. This is
-- what the link was for: a document that is nine months old and behind forty
-- answers is a different problem from a document that is nine months old and
-- behind none, and the interface could not tell them apart.
--
-- The count has to cross private sessions, and that is the whole reason this is
-- a function rather than a view.
--
-- Chats are private by default (0008). A member reading `messages` through RLS
-- sees their own sessions and the shared ones, so a count assembled in the
-- client would be a count of *that person's* answers — different for everybody
-- looking at the same document, and near zero for somebody who has just joined.
-- "Which documents does this team lean on" is not a question any one member can
-- answer from what they are allowed to read.
--
-- So the function reads across the workspace and returns a number, and nothing
-- else. Not who asked, not what they asked, not which session, not when. The
-- most it discloses is that a document the whole workspace can already read has
-- been used n times — which is the same trade #44 makes for unanswered
-- questions, and worth naming rather than assuming.
--
-- Membership is still checked, per bundle, inside the function. `security
-- definer` turns RLS off for the body; it does not make the caller anybody
-- else, so `auth.uid()` is still them and `is_workspace_member` still answers
-- honestly. A bundle in a workspace the caller is not in contributes nothing.

-- Containment (`@>`) is the operator the count uses, and jsonb_path_ops is the
-- smaller, faster GIN opclass for exactly that operator — it indexes values
-- rather than keys, which is all `@> [{"id": ...}]` needs.
--
-- Without this the count is a sequential scan of every message in the database
-- per document. That is survivable at today's sizes and is not survivable at
-- the size this feature becomes useful at, which is the wrong way round.
create index if not exists messages_sources_gin
  on public.messages using gin (sources jsonb_path_ops);

/**
 * Citations per document, for documents in the given bundles.
 *
 * Returns a row per document that has at least one citation. A document with
 * none is absent rather than zero — the caller already knows which documents it
 * asked about, and a missing row is the same answer in fewer bytes.
 */
create or replace function public.document_citation_counts(p_bundle_ids uuid[])
returns table (document_id uuid, citations bigint)
language sql
security definer
stable
set search_path = pg_catalog, public
as $$
  select d.id, count(*)
  from public.documents d
  join public.knowledge_bundles b on b.id = d.bundle_id
  join public.messages m
    -- `d.id::text`: ids are stored as JSON strings, and jsonb equality is typed
    -- — `{"id": "<uuid>"}` never matches a uuid literal, it matches a string.
    on m.sources @> jsonb_build_array(jsonb_build_object('id', d.id::text))
  join public.chat_sessions s on s.id = m.session_id
  where d.bundle_id = any(p_bundle_ids)
    -- The reply and the document have to belong to the same room. A document id
    -- is unique, so a citation from elsewhere should be impossible — this says
    -- so out loud, and lets the planner start from the workspace.
    and s.workspace_id = b.workspace_id
    and public.is_workspace_member(b.workspace_id)
  group by d.id;
$$;

/**
 * The oldest reply whose citations carry ids, for one workspace.
 *
 * Every count above is a count over a window, and the window is not "all of
 * history": replies written before #54 cite by name alone and cannot be
 * matched to a document at all. A list that does not say so reads as a census
 * and is a sample — a document uploaded two years ago and heavily used until
 * spring would show a smaller number than one uploaded last week.
 *
 * Rather than hard-code the date the ids started, this asks the data. It is the
 * first reply that could have been counted, which is exactly the sentence the
 * interface needs to print. Null means none yet: a workspace with no counted
 * replies at all, where the honest thing to show is nothing rather than zeroes.
 */
create or replace function public.citations_counted_since(p_workspace_id uuid)
returns timestamptz
language sql
security definer
stable
set search_path = pg_catalog, public
as $$
  select min(m.created_at)
  from public.messages m
  join public.chat_sessions s on s.id = m.session_id
  where s.workspace_id = p_workspace_id
    and public.is_workspace_member(p_workspace_id)
    -- An element carrying a real id. Spelled out rather than written as a
    -- jsonpath filter, because three shapes have to come out false and only one
    -- true: `sources` null at all, the pre-#54 `[{"name": …}]`, and the
    -- `{"id": null, "name": …}` that chat.ts still writes when retrieval
    -- matched a document it could not identify. Only a string id counts.
    and jsonb_typeof(m.sources) = 'array'
    and exists (
      select 1
      from jsonb_array_elements(m.sources) e
      where jsonb_typeof(e -> 'id') = 'string'
    );
$$;

-- `authenticated` only. Neither function is useful to a signed-out caller and
-- both read across sessions, so `anon` has no business holding them even with
-- the membership check inside.
revoke all on function public.document_citation_counts(uuid[]) from public, anon;
revoke all on function public.citations_counted_since(uuid) from public, anon;
grant execute on function public.document_citation_counts(uuid[]) to authenticated, service_role;
grant execute on function public.citations_counted_since(uuid) to authenticated, service_role;
