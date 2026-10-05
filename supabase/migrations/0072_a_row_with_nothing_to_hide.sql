-- Let a connected application that needs no credential be a connection, and
-- give a connection somewhere to record that its credential was refused.
--
-- Two changes to `tool_connections`, in one file because both touch
-- `tool_connections_credential_shape` and that constraint is the one place the
-- tenant boundary is written as a rule rather than as a comment. Opening it
-- twice would mean arguing it twice.
--
-- ---------------------------------------------------------------------------
-- WHY (1): THIRTY-FOUR APPLICATIONS CANNOT BE CONNECTED AT ALL. covan#253.
--
-- A Composio toolkit with auth scheme `NO_AUTH` — `hackernews`,
-- `composio_search`, `weathermap`, `codeinterpreter`, `yelp` and thirty more —
-- has no credential of any kind. Probed against the live API 2026-10-05, and
-- the answer was not what this schema assumes:
--
--   POST /api/v3/auth_configs {type: "use_composio_managed_auth"}
--     -> 400 Auth_Config_NoAuthApp: "Cannot create an auth config for toolkit
--        "hackernews" because it does not require authentication. … You can use
--        its tools directly without creating a connected account."
--   POST /api/v3/auth_configs {type: "no_auth"}
--     -> 400: Expected 'use_composio_managed_auth' | 'use_custom_auth'
--
-- And `/connected_accounts/link` requires an `auth_config_id` on both v3 and
-- v3.1, so there is no way round it. Such a toolkit has **no auth config, no
-- connected account and no link**; its tools execute on `user_id` alone, which
-- was verified directly (`HACKERNEWS_GET_LATEST_POSTS` with no
-- `connected_account_id`: `successful: true`). Composio's own documentation
-- agrees: for a no-auth server, "No connection is required."
--
-- So the correct row is `status = 'active'` with `connected_account_id` null,
-- which `tool_connections_credential_shape` has forbidden since 0063. Pressing
-- Connect on any of the thirty-four 502s today, every time.
--
-- WHY THIS IS AN `auth_kind` AND NOT A RELAXATION. The lazy fix is to append
-- `or connected_account_id is null` to the composio arm, and it is wrong twice
-- over: it drops the invariant for every row including the managed ones, and it
-- still leaves the worker unable to tell "needs no account" from "lost its
-- account" — so it does not even solve the problem it weakens the schema for.
--
-- `auth_kind` already answers "how is this row's credential held", with two
-- values: a header in the row (`static_header`), or a grant at Composio
-- (`composio`). "There is no credential anywhere" is a third answer to that
-- same question, so it is a third value and not a new column. A second
-- discriminator beside `auth_kind` would be two facts about one thing that can
-- disagree, and keeping them in step would need a constraint whose only job is
-- that — strictly worse than one enum, which cannot contradict itself.
--
-- It is also the value a client cannot touch. 0059:181 grants
-- `update (label, allowed_methods, config)` to `authenticated` and nothing
-- else, so no member can relabel a managed row `composio_no_auth` through
-- PostgREST to make an account-less row legal, and no route lets a caller
-- choose it — `routes/composio.ts` and `routes/tool-connections.ts` both
-- hardcode it. That is what makes this a scoped widening rather than a hole,
-- and `tests/rls/agent-harness.test.ts` now pins it.
--
-- NOT DERIVED AT RUNTIME, which was the real alternative. Postgres cannot ask
-- Composio, so deriving it would force the unconditional relaxation above and
-- buy nothing. Worse, `gemini` publishes both `NO_AUTH` and `API_KEY`, so which
-- kind a toolkit "is" depends on an ordering decision in our own code — and a
-- row re-derived differently next month would start addressing a different
-- account. Same argument 0063 makes for storing `composio_user_id` instead of
-- deriving it: the row records how it was actually connected, not what the
-- catalogue says today.
--
-- WHY THIS DOES NOT WEAKEN THE TENANT BOUNDARY, which is the thing 0063:22-33
-- exists to protect and the reason this header is long.
--
-- That argument is about a credential. One `COMPOSIO_API_KEY` serves every
-- workspace, so `connected_account_id` is the whole address of a grant, and
-- what sits at that address is somebody's mailbox. A `NO_AUTH` toolkit has
-- nothing at any address: two workspaces executing the same no-auth operation
-- reach the same public API and get the same answer. **There is no tenant data
-- behind one for an account id to separate.** The id is absent because there is
-- nothing for it to protect, not because the rule was loosened.
--
-- Everything else still holds. `loadConnection` filters by `workspace_id` on
-- top of RLS, so another workspace's row id is "no such connection" rather than
-- a refusal. `composio_user_id` is a server-chosen random uuid granted to no
-- client role. And the clause being changed applies **only to rows that declare
-- themselves no-auth** — the managed clause below is byte-identical to 0068's,
-- so 0063's banner sentence stays literally true of every row it was written
-- about. What changes: for `auth_kind = 'composio_no_auth'`, the database no
-- longer refuses active-without-an-account. Nothing else.
--
-- ---------------------------------------------------------------------------
-- WHY (2): A CREDENTIAL THAT IS ACCEPTED IS NOT ONE THAT WORKS. covan#258.
--
-- Measured 2026-10-05: a deliberately wrong API key submitted to Composio's
-- hosted connect page yields a connected account with `status: "ACTIVE"` and
-- `status_reason: null`. Composio does not check a credential at connect time.
-- So the row goes active, the card loses its "Finishing…" chip, a chat starter
-- appears, and the failure surfaces only on the first `run_tool` — as the
-- provider's own 401, in front of whoever asked an agent to do something rather
-- than whoever typed the key.
--
-- `verified_at` and `verify_error` are where the answer goes. Two nullable
-- columns rather than a fourth `status` value, deliberately: `status` is the
-- consent lifecycle, and a new value there would be coerced to `active` by
-- `lib/dto.ts` and `lib/harness/connections.ts` until five TypeScript unions
-- were widened — rendering as "connected" in exactly the place that matters —
-- while `listConnections` would stop returning the row to agents with no error
-- anywhere, and `routes/composio.ts`'s abandoned-row replacement would delete a
-- live connection as unfinished. A rejected credential is a fact ABOUT an
-- active connection, not a different stage of becoming one.
--
-- They are `select`-granted and NOT `update`-granted, like every other column
-- a service-role write owns. Advisory rather than a boundary: nothing is
-- authorised by them, so a stale one costs a wrong sentence on a card and
-- nothing more.
--
-- The deliberate decision they encode: a refused credential **warns**, it does
-- not fail the row. A check with false negatives would mark a working
-- connection broken while the person holds a key they have every reason to
-- trust, which is worse than the defect it fixes.
--
-- ---------------------------------------------------------------------------
-- THE ORDER MATTERS, and 0068:45-52 is why this is spelled out. Postgres
-- silently drops any constraint mentioning a dropped column, so both checks are
-- dropped BY NAME before being re-added, and the auth-kind check is widened
-- BEFORE the shape check that now reads it — otherwise the first insert
-- carrying the new value fails on the old vocabulary.
--
-- No data migration. No existing row changes. Every constraint here is wider
-- than the one it replaces, so this is safe to apply before or after the worker
-- that uses it: a worker deployed first gets a clean 23514 on connect rather
-- than writing a row the schema does not want.

-- 1. The vocabulary, widened first because the rule below reads it.
--
-- 0063:85-94 gave this constraint a stable name for exactly this moment, and
-- said why: `auth_kind` is the one column 0059 wrote inline, so the name is
-- Postgres's generated default and is identical on every install.
alter table public.tool_connections
  drop constraint if exists tool_connections_auth_kind_check;

alter table public.tool_connections
  add constraint tool_connections_auth_kind_check
  check (auth_kind in ('static_header', 'composio', 'composio_no_auth'));

comment on column public.tool_connections.auth_kind is
  'How this row''s credential is held. `static_header` keeps it in '
  '`secret_ciphertext`. `composio` holds none itself and names a grant at '
  'Composio through `connected_account_id`. `composio_no_auth` holds none and '
  'names none, because the application needs none — its operations execute on '
  '`composio_user_id` alone (0072, covan#253). Service-role write only: not in '
  '0059''s update grant, which is what stops a member relabelling a managed row '
  'to make an account-less one legal.';

-- 2. Where a refused credential is recorded.
alter table public.tool_connections
  add column if not exists verified_at timestamptz;

alter table public.tool_connections
  add column if not exists verify_error text;

comment on column public.tool_connections.verified_at is
  'When this connection''s credential was last checked against the provider, '
  'through Composio''s proxy so the credential never comes here. Null means '
  'never checked — which includes every row written before 0072, and every row '
  'whose check could not be made. Not an expiry: a credential can stop working '
  'at any time after it.';

comment on column public.tool_connections.verify_error is
  'The provider''s own sentence, when it refused this connection''s credential. '
  'Non-null is a warning on the card and suppresses the chat starter; the row '
  'stays `active` on purpose, because a check with false negatives must never '
  'close a connection that works (0072, covan#258).';

-- 3. The credential rule, dropped by name and re-added with both shapes stated
--    positively.
--
-- `auth_kind in (…)` on the composio arm is not redundant with step 1: it makes
-- "which auth kinds a composio row may hold" a fact this constraint states,
-- rather than something the inner `else` happens to tolerate. A `static_header`
-- value smuggled onto a composio row is now refused here too.
--
-- Still a CASE with an `else` rather than a chain of ORs, for 0063's reason and
-- 0068's: a fifth transport added to `tool_connections_transport_check` without
-- being added here fails closed, where the OR form would admit it with no
-- credential rule at all.
alter table public.tool_connections
  drop constraint if exists tool_connections_credential_shape;

alter table public.tool_connections
  add constraint tool_connections_credential_shape
  check (
    case transport
      when 'composio' then
        secret_ciphertext is null
        and toolkit_slug is not null
        and auth_kind in ('composio', 'composio_no_auth')
        and case auth_kind
              when 'composio_no_auth' then
                connected_account_id is null
                and composio_user_id is not null
              else
                status = 'pending' or connected_account_id is not null
            end
      else
        secret_ciphertext is not null
        and connected_account_id is null
        and composio_user_id is null
        and toolkit_slug is null
    end
  );

-- 4. The two new columns join the select grant 0059, 0061 and 0063 built up.
--
-- `connected_account_id` and `composio_user_id` are still absent from it and
-- still belong nowhere near it. These two are different in kind: they describe
-- a connection's health rather than address anything, and the card is what
-- reads them.
grant select (verified_at, verify_error) on public.tool_connections to authenticated;
