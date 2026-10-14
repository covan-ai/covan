-- Nothing for nobody: the `anon` role -- a request carrying the public anon key
-- and no session -- may read, write or call nothing in `public`.
--
-- Nothing in Covan uses it. The browser signs in through GoTrue and every data
-- request after that runs as `authenticated`; the API reads and writes as the
-- caller or as the service role. But 0023 granted every table to `anon` and
-- `authenticated` alike, and the platform's default privileges grant every
-- new table, sequence and function to `anon` explicitly. So `anon` held the
-- same table grants as a signed-in member, kept out only by policies -- and
-- most policies here name no role, so they are asked of `anon` too, and are
-- one careless `using (true)` from answering it.
--
-- Functions are the sharper half. A `security definer` function runs as its
-- owner, and twenty-one of them were executable by `anon` because the default
-- grant names it outright: `revoke ... from public`, the phrase the rest of
-- the schema uses, does not touch a grant made to `anon` by name. Each of them
-- checks `auth.uid()` before it does anything, and `auth.uid()` is null for an
-- anonymous caller, so none is known to be exploitable. That is one check per
-- function standing between the internet and a definer, which is the
-- arrangement this file removes.
--
-- After this:
--
--   * no table or sequence in `public` is granted to `anon`;
--   * the twenty-one definer functions are executable by `authenticated` and
--     `service_role` only (granted first, so nothing that works today stops);
--   * tables, sequences and functions created later by this role are not
--     granted to `anon` by default either, so the next migration does not
--     have to remember.
--
-- `tests/rls/grant-ratchet.test.ts` holds all three, against the database.

revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;

alter default privileges for role postgres in schema public revoke all on tables from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;
alter default privileges for role postgres in schema public revoke all on functions from anon;

-- ---- the definer functions a signed-in client calls ---------------------------
--
-- By exact signature, and deliberately not `on all functions in schema
-- public`: the `vector` extension lives in this schema and its operators are
-- functions too.

-- policy helpers
grant execute on function public.is_workspace_member(uuid) to authenticated, service_role;
revoke execute on function public.is_workspace_member(uuid) from public, anon;
grant execute on function public.is_workspace_admin(uuid) to authenticated, service_role;
revoke execute on function public.is_workspace_admin(uuid) from public, anon;
grant execute on function public.can_write_in_workspace(uuid) to authenticated, service_role;
revoke execute on function public.can_write_in_workspace(uuid) from public, anon;
grant execute on function public.shares_workspace(uuid) to authenticated, service_role;
revoke execute on function public.shares_workspace(uuid) from public, anon;
grant execute on function public.session_is_visible(uuid) to authenticated, service_role;
revoke execute on function public.session_is_visible(uuid) from public, anon;

-- client RPCs
grant execute on function public.create_workspace(text) to authenticated, service_role;
revoke execute on function public.create_workspace(text) from public, anon;
grant execute on function public.accept_invitation(uuid) to authenticated, service_role;
revoke execute on function public.accept_invitation(uuid) from public, anon;
grant execute on function public.touch_session(uuid) to authenticated, service_role;
revoke execute on function public.touch_session(uuid) from public, anon;
grant execute on function public.show_message_version(uuid) to authenticated, service_role;
revoke execute on function public.show_message_version(uuid) from public, anon;
grant execute on function public.soft_delete_agent(uuid) to authenticated, service_role;
revoke execute on function public.soft_delete_agent(uuid) from public, anon;
grant execute on function public.soft_delete_bundle(uuid) to authenticated, service_role;
revoke execute on function public.soft_delete_bundle(uuid) from public, anon;
grant execute on function public.soft_delete_document(uuid) to authenticated, service_role;
revoke execute on function public.soft_delete_document(uuid) from public, anon;
grant execute on function public.restore_agent(uuid) to authenticated, service_role;
revoke execute on function public.restore_agent(uuid) from public, anon;
grant execute on function public.restore_bundle(uuid) to authenticated, service_role;
revoke execute on function public.restore_bundle(uuid) from public, anon;
grant execute on function public.restore_document(uuid) to authenticated, service_role;
revoke execute on function public.restore_document(uuid) from public, anon;
grant execute on function public.workspace_trash(uuid) to authenticated, service_role;
revoke execute on function public.workspace_trash(uuid) from public, anon;
grant execute on function public.workspace_api_key_count(uuid, uuid) to authenticated, service_role;
revoke execute on function public.workspace_api_key_count(uuid, uuid) from public, anon;
grant execute on function public.workspace_coverage(uuid, integer) to authenticated, service_role;
revoke execute on function public.workspace_coverage(uuid, integer) from public, anon;
grant execute on function public.workspace_coverage_agents(uuid, integer) to authenticated, service_role;
revoke execute on function public.workspace_coverage_agents(uuid, integer) from public, anon;
grant execute on function public.workspace_usage_all(uuid) to authenticated, service_role;
revoke execute on function public.workspace_usage_all(uuid) from public, anon;
grant execute on function public.workspace_usage_monthly(uuid, integer) to authenticated, service_role;
revoke execute on function public.workspace_usage_monthly(uuid, integer) from public, anon;
