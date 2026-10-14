-- Finished where it was started: a connected application becomes active only
-- when the browser Composio sends back is the starter's.
--
-- Connecting an application creates a pending row and hands the person a
-- Composio link. Until now the row went active as soon as Composio said the
-- account behind it had been authorised — by whoever authorised it. So
-- somebody could start a connection, send the link to somebody else, and have
-- that person's mailbox become a connected application in the starter's
-- workspace.
--
-- The link now sends the consenting browser back to Covan with a nonce, and
-- the row stores only the nonce's SHA-256. Completing the connection takes the
-- nonce, from a signed-in request by the person who created the row; a
-- browser holding it on anybody else's behalf gets the account revoked at
-- Composio instead. Polling the row's status no longer activates anything.
--
-- No client role is granted the column: SELECT on `tool_connections` is a
-- column list (0059, 0063), and a hash the browser could read back would be a
-- hash somebody could match.

alter table public.tool_connections
  add column if not exists completion_nonce_hash text;

alter table public.tool_connections
  drop constraint if exists tool_connections_completion_nonce_hash_shape;
alter table public.tool_connections
  add constraint tool_connections_completion_nonce_hash_shape
  check (completion_nonce_hash is null or completion_nonce_hash ~ '^[0-9a-f]{64}$');

create index if not exists tool_connections_completion_nonce_idx
  on public.tool_connections (completion_nonce_hash)
  where completion_nonce_hash is not null;
