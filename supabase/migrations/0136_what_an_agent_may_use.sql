-- =========================================================================
-- What an agent may use
--
-- Configuration's Tools section (A10) is a switch per thing an agent can
-- reach: the browser, and each connected app or service the person talking to
-- it can see. Until now every agent reached all of them, so the switches are
-- stored as what is turned OFF — an empty list is every agent as it was, and
-- nothing changes for an agent nobody opens.
--
-- `browser_off` is a boolean beside `web_search`, its neighbour in the same
-- section. `connections_off` holds tool connection ids; a connection that is
-- deleted later simply stops matching, which is the same as being off, so
-- there is no foreign key to keep in step. The engine reads both through the
-- caller's own client (chat) or with the agent row it already has (routines)
-- and drops the tools and connections they name; `loadConnection` refuses an
-- id on the list, so a model that remembers one cannot call it anyway.
--
-- Written like `web_search`: through the caller's own client, by whoever may
-- edit the agent (0104's `agents_update_editors`).
-- =========================================================================

alter table public.agents
  add column if not exists browser_off boolean not null default false,
  add column if not exists connections_off uuid[] not null default '{}';

alter table public.agents
  drop constraint if exists agents_connections_off_size;
alter table public.agents
  add constraint agents_connections_off_size
  check (cardinality(connections_off) <= 500);

grant insert (browser_off, connections_off) on public.agents to authenticated;
grant update (browser_off, connections_off) on public.agents to authenticated;
