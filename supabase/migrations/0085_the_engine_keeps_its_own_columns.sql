-- The engine keeps its own columns: a client may write what a person can
-- write about a document, and nothing the sync engine, a routine or the purge
-- reads as fact.
--
-- `documents` still carried 0023's table-wide INSERT and UPDATE grants, and
-- its policies scope the ROW (a bundle in a workspace you can write) rather
-- than the columns. Several columns on that row are not a person's to set:
--
--   r2_key         where the bytes are. Download reads it, and the purge
--                  deletes the object it names thirty days after the row is
--                  hidden.
--   connection_id  "this document came from that connection". The sync engine
--   external_*     rewrites such rows, and a routine watching the connection
--   synced_at      summarises them.
--   routine_id     "a routine filed this". Retention prunes by it.
--   deleted_at     when the thirty days started.
--   created_at
--
-- Every one of those is written by the service role (sync, filing, purge) or
-- by a definer function (soft delete, restore), never by a client. The places
-- the API writes with the caller's own client set only the columns granted
-- below: an upload and a report insert (bundle, name, size, key, text), and a
-- move updates `bundle_id`.
--
-- `deleted_*` is not granted. Hiding a row is `soft_delete_document`'s job,
-- and a client UPDATE that sets `deleted_at` never got past the policies
-- anyway: the new row is checked against `documents_select_member`, which
-- hides deleted rows, so Postgres refuses it as a policy violation.
--
-- What the grants cannot say is which VALUES are acceptable, so a trigger
-- says that:
--
--   * an inserted `r2_key` is a fresh key under the row's own bundle, in the
--     exact shape the API mints (`<bundle>/<uuid>-<safe name>`) -- which also
--     rules out `..` and every other path a filesystem store would resolve;
--   * a move stays inside the workspace (the API already refused that with a
--     400; the policy alone did not).
--
-- ---------------------------------------------------------------------------
-- WHY `current_user`, NOT `auth.uid()`.
--
-- The trigger has to wave through the service role, the definer functions
-- (`soft_delete_document` runs as the function owner), and foreign-key
-- actions: deleting a connection or a routine sets `connection_id` /
-- `routine_id` to null on the documents, and that UPDATE runs as the table
-- owner while the request's JWT is still in `request.jwt.claims`. `auth.uid()`
-- would see a person there and refuse the cascade, which would make it
-- impossible to remove a connection. The role is what tells the cases apart:
-- PostgREST runs a client as `authenticated` (or `anon`), and nothing else is.
--
-- ---------------------------------------------------------------------------
-- EXISTING ROWS.
--
-- Rows written before this file may already carry values the rules below
-- refuse. They are repaired first, each change reported with RAISE NOTICE so
-- the migration's own output says which rows moved and what they held:
--
--   1. a document naming a connection or a routine in ANOTHER workspace loses
--      the reference -- the document stays, it just stops being that
--      connection's or that routine's;
--   2. an `external_url` that is not http(s) is cleared;
--   3. an `r2_key` that is not under any bundle, or is under a bundle in
--      another workspace, is cleared -- the row stays, its download stops;
--   4. an `r2_key` shared by several rows is kept by the row that minted it
--      -- the one in the key's own bundle, then one that is not deleted, then
--      the oldest -- and cleared on the rest. Not deleted before oldest,
--      because `created_at` was a client's to write and a deleted row is the
--      one the purge would act on.
--
-- After that a key can belong to one row only, and the unique index makes it
-- so for good. If anything was missed the index cannot be built and this whole
-- file rolls back, which is the right failure.

-- ---- 1. references into another workspace ----------------------------------

do $$
declare
  r record;
begin
  for r in
    select d.id, d.connection_id
      from public.documents d
      join public.knowledge_bundles b on b.id = d.bundle_id
      join public.connections c on c.id = d.connection_id
     where c.workspace_id <> b.workspace_id
  loop
    raise notice 'documents %: connection_id % cleared (another workspace)', r.id, r.connection_id;
  end loop;

  update public.documents d
     set connection_id = null
    from public.knowledge_bundles b, public.connections c
   where b.id = d.bundle_id
     and c.id = d.connection_id
     and c.workspace_id <> b.workspace_id;

  for r in
    select d.id, d.routine_id
      from public.documents d
      join public.knowledge_bundles b on b.id = d.bundle_id
      join public.routines t on t.id = d.routine_id
     where t.workspace_id <> b.workspace_id
  loop
    raise notice 'documents %: routine_id % cleared (another workspace)', r.id, r.routine_id;
  end loop;

  update public.documents d
     set routine_id = null
    from public.knowledge_bundles b, public.routines t
   where b.id = d.bundle_id
     and t.id = d.routine_id
     and t.workspace_id <> b.workspace_id;
end $$;

-- ---- 2. links that are not links -------------------------------------------

do $$
declare
  r record;
begin
  for r in
    select id, external_url from public.documents
     where external_url is not null and external_url !~* '^https?://'
  loop
    raise notice 'documents %: external_url % cleared (not http)', r.id, r.external_url;
  end loop;

  update public.documents
     set external_url = null
   where external_url is not null and external_url !~* '^https?://';
end $$;

-- ---- 3 and 4. storage keys -------------------------------------------------

do $$
declare
  r record;
begin
  for r in
    with keyed as (
      select d.id, d.r2_key, b.workspace_id as doc_ws,
             case when split_part(d.r2_key, '/', 1)
                         ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  then split_part(d.r2_key, '/', 1)::uuid end as key_bundle
        from public.documents d
        join public.knowledge_bundles b on b.id = d.bundle_id
       where d.r2_key is not null
    )
    select k.id, k.r2_key
      from keyed k
      left join public.knowledge_bundles kb on kb.id = k.key_bundle
     where k.key_bundle is null
        or (kb.id is not null and kb.workspace_id <> k.doc_ws)
  loop
    raise notice 'documents %: r2_key % cleared (not under this workspace)', r.id, r.r2_key;
    update public.documents set r2_key = null where id = r.id;
  end loop;

  for r in
    select id, r2_key
      from (
        select d.id, d.r2_key,
               row_number() over (
                 partition by d.r2_key
                 order by (d.bundle_id::text = split_part(d.r2_key, '/', 1)) desc,
                          (d.deleted_at is null) desc,
                          d.created_at, d.id
               ) as rank
          from public.documents d
         where d.r2_key is not null
      ) ranked
     where rank > 1
  loop
    raise notice 'documents %: r2_key % cleared (held by another row)', r.id, r.r2_key;
    update public.documents set r2_key = null where id = r.id;
  end loop;
end $$;

create unique index if not exists documents_r2_key_unique
  on public.documents (r2_key)
  where r2_key is not null;

-- ---- which columns a client may write --------------------------------------

revoke insert, update on public.documents from anon, authenticated;
grant insert (bundle_id, name, size, r2_key, content, created_by)
  on public.documents to authenticated;
grant update (bundle_id) on public.documents to authenticated;

-- ---- which values ------------------------------------------------------------

create or replace function public.documents_guard_client_writes()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_from uuid;
  v_to uuid;
begin
  -- Service role, definer functions and foreign-key actions. See the header.
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.r2_key is not null
       and new.r2_key !~ ('^' || new.bundle_id::text
                          || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
                          || '-[A-Za-z0-9._-]{1,200}$') then
      raise exception 'r2_key must be a new key under the document''s own bundle'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if new.bundle_id is distinct from old.bundle_id then
    -- Read through the caller's own policies: both bundles are ones the
    -- documents policies already required them to be able to write.
    select workspace_id into v_from from public.knowledge_bundles where id = old.bundle_id;
    select workspace_id into v_to from public.knowledge_bundles where id = new.bundle_id;
    if v_from is null or v_to is null or v_from <> v_to then
      raise exception 'a document cannot move to a bundle in another workspace'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

-- A trigger function cannot be called directly; the revoke is for the reader
-- who checks every function for an endpoint.
revoke all on function public.documents_guard_client_writes() from public;

drop trigger if exists trg_documents_guard_client_writes on public.documents;
create trigger trg_documents_guard_client_writes
  before insert or update on public.documents
  for each row execute function public.documents_guard_client_writes();
