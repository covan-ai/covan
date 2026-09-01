-- 0027_a_url_that_stays_the_one_we_checked.sql
--
-- A routine's source url is validated exactly once, by assertFetchableUrl in
-- POST /routines. That is deliberate and the update route agrees: `updateSchema`
-- has no `sourceUrl` field, so the API offers no way to move a routine's target
-- after it is set.
--
-- The API is not the boundary. `authenticated` holds a table-level UPDATE from
-- 0023 and the anon key ships in the browser bundle, so PATCH /rest/v1/routines
-- with a new source_config was always accepted: routines_update_own constrains
-- user_id, workspace_id, agent_id and delivery_channel_id, and says nothing
-- about source_config. Create a routine against a URL that passes the guard,
-- then repoint it at anything at all.
--
-- A trigger rather than a WITH CHECK, because WITH CHECK cannot see the old
-- row, and "this column may not change" is a statement about both.

create or replace function public.routines_source_config_is_immutable()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if new.source_config is distinct from old.source_config
     or new.source_kind is distinct from old.source_kind then
    raise exception 'a routine''s source cannot be changed after it is created'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger trg_routines_source_config_immutable
  before update on public.routines
  for each row
  execute function public.routines_source_config_is_immutable();
