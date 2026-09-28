-- Remove the connected-Supabase-account carrier. One road to a Postgres again.
--
-- 0061 added a second way to reach a database: instead of installing
-- `covan_query` in it, an admin pasted a Supabase Management API token, ticked
-- some projects, and each became a `tool_connections` row with no credential of
-- its own that borrowed the account's. It was the shorter road and it is the
-- one being removed, because the token it asks for opens EVERY project in that
-- account rather than the ticked ones — a scope nobody can narrow, for a
-- convenience the PostgREST road already provides with a function.
--
-- A hosted Supabase project is still perfectly connectable. It takes the
-- function, like every other Postgres (`docs/integrations.md`).
--
-- THIS DELETES LIVE ROWS. Production had exactly one at the time of writing —
-- label `covan`, connected 2026-09-22, queried 21 times by `query_database`,
-- last on 2026-09-25 — and it stops working here. That was decided knowingly:
-- the agent loses that database until it is reconnected over PostgREST. Capture
-- what is there before running this, because nothing else holds it:
--
--   select label, base_url, config, created_at
--   from public.tool_connections where transport = 'supabase';
--
-- APPLY THIS **AFTER** THE WORKER IS DEPLOYED, which is the opposite of the
-- usual order and matters. `routes/tool-connections.ts` and
-- `lib/harness/connections.ts` named `account_id` in their PostgREST select
-- strings until the build that accompanies this file, and PostgREST answers the
-- WHOLE request with an error when asked for a column that does not exist — so
-- running this against the old worker turns `GET /tool-connections`, and every
-- agent turn that lists connections, into a 500 for every workspace rather than
-- only for the one holding the Supabase row.

-- 1. The rows first.
--
-- `on delete cascade` on `account_id` fires on row deletes; `drop table` is not
-- one, so the projects would otherwise survive as orphans — and then step 3's
-- `add constraint` would validate them and abort the whole migration with
-- 23514. Predicated on the transport rather than on the account, because that
-- is exactly what the narrowed check below will refuse.
--
-- `tool_connection_grants.tool_connection_id` is `on delete cascade` (0063), so
-- any always-allow permissions go with them. Nothing else in the schema
-- references `tool_connections`.
delete from public.tool_connections where transport = 'supabase';

-- 2. The credential rule, dropped BY NAME before the column it mentions.
--
-- This is the dangerous step and the reason the order is written out. Postgres
-- automatically drops any constraint involving a dropped column — so removing
-- `account_id` while `tool_connections_credential_shape` still referenced it
-- would take the whole constraint with it, 0063's composio rules included,
-- silently and with no error. Dropping it here makes step 5 impossible to
-- forget.
alter table public.tool_connections
  drop constraint if exists tool_connections_credential_shape;

-- 3. The transports that remain.
alter table public.tool_connections
  drop constraint if exists tool_connections_transport_check;

alter table public.tool_connections
  add constraint tool_connections_transport_check
  check (transport in ('http', 'sql', 'composio'));

-- 4. The column, and the index and grant that hang off it.
drop index if exists public.tool_connections_account_idx;

alter table public.tool_connections
  drop column if exists account_id;

-- 5. The credential rule again, without the arm that is gone.
--
-- Still a CASE with an `else` rather than a chain of ORs, for the reason 0063
-- gives: a fifth transport added to the check above without being added here
-- fails closed. The OR form would let it through with no credential rule at all,
-- which is the quiet version of this constraint not existing.
--
-- `secret_ciphertext` STAYS NULLABLE. 0061 dropped its NOT NULL for the
-- supabase case, but 0063's `composio` arm also requires it to be null — so
-- restoring the column constraint here would break every connected application.
-- The rule lives in this CASE, not on the column.
alter table public.tool_connections
  add constraint tool_connections_credential_shape
  check (
    case transport
      when 'composio' then
        secret_ciphertext is null
        and toolkit_slug is not null
        and (status = 'pending' or connected_account_id is not null)
      else
        secret_ciphertext is not null
        and connected_account_id is null
        and composio_user_id is null
        and toolkit_slug is null
    end
  );

-- 6. The table, and the function `drop table` does not take with it.
--
-- No `cascade` needed now that `account_id` is gone — and `cascade` here would
-- be the same class of silent removal as step 2, so it is deliberately absent.
drop table if exists public.supabase_accounts;

drop function if exists public.supabase_accounts_stamp();
