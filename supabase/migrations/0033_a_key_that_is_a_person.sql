-- 0033_a_key_that_is_a_person.sql
--
-- A long-lived credential for the REST API. Until now there was none: the only
-- way to reach the API was a browser session's bearer token, which expires in an
-- hour and cannot be handed to a cron job. The docs say the API exists; nothing
-- said how to hold a key to it, and that gap is what this closes.
--
-- ---- what a key is -------------------------------------------------------
--
-- A key belongs to a PERSON and acts as that person. That is not a shortcut, it
-- is the only shape that keeps the authorization model intact: everything in
-- this database gates on `auth.uid()`, so a credential that resolves to nobody
-- would have to be scoped by application code instead — which is precisely what
-- worker/src/service-client.static.test.ts exists to prevent. The API Worker
-- looks a key up, mints a sixty-second JWT for its owner, and makes the request
-- as them. Postgres cannot tell the difference, and that is the point.
--
-- The consequence is deliberate and should be said out loud: when somebody
-- leaves a workspace their keys stop working, because their own access stopped
-- working. A script that ran on a departed colleague's key goes quiet. The
-- alternative — a key owned by the workspace rather than by a person — needs a
-- service-account user to be, which is a second kind of member for the Team
-- page, the removal flow and every "who did this" question to learn about. That
-- is a larger decision than this migration, so the removal dialog is being
-- taught to count somebody's live keys instead (see the function at the bottom).
--
-- ---- what is stored ------------------------------------------------------
--
-- The hash, never the key. `token_hash` is SHA-256 hex of the plaintext, and
-- SHA-256 rather than bcrypt or argon deliberately: the token is 32 bytes from a
-- CSPRNG, so there is no dictionary to slow an attacker down through. A slow
-- hash here would buy nothing and spend Worker CPU on every single request.
--
-- `prefix` is the first characters of the key, kept in the clear so a row can be
-- recognised in a list. It is not a secret and not enough to reconstruct one.

create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- What it is for, in the owner's words. Bounded so the list stays readable.
  name text not null check (length(btrim(name)) between 1 and 60),
  token_hash text not null unique,
  prefix text not null,
  created_at timestamptz not null default now(),
  -- Written past the end of the response and only when the stored value is
  -- already stale — see `touchApiKey` in worker/src/lib/api-keys.ts. A forgotten
  -- key is recognised at five-minute resolution, which is all the interface
  -- asks for and much less than a write on every request costs.
  last_used_at timestamptz,
  revoked_at timestamptz
);

-- The lookup the API Worker makes on every key-authenticated request is by
-- `token_hash`, which the unique constraint already indexes. This one serves the
-- list in Settings and the count function below.
create index if not exists api_keys_user_live_idx
  on public.api_keys (user_id)
  where revoked_at is null;

alter table public.api_keys enable row level security;

-- ---- policies ------------------------------------------------------------
--
-- Own keys only, on all four verbs. No admin branch, and its absence is a
-- decision: an `or is_workspace_admin(...)` here would be read by the next
-- person as "admins may list a colleague's keys", and the route that wanted to
-- answer "my keys" would quietly start answering "keys I am allowed to see".
-- That is the mistake 0022 documented and that GET /invitations/incoming made
-- for real. The one thing an admin genuinely needs — how many live keys somebody
-- has, before removing them — is a function, at the bottom, that checks for
-- itself.

drop policy if exists "api_keys_select_own" on public.api_keys;

create policy "api_keys_select_own"
  on public.api_keys for select
  using (user_id = auth.uid());

-- Membership is required as well as ownership, so a key cannot be minted into a
-- workspace the caller has left. `is_workspace_member` rather than
-- `can_write_in_workspace`: a viewer may hold a key, because the key can do no
-- more than the viewer can, and every policy it meets will say so.
drop policy if exists "api_keys_insert_own" on public.api_keys;

create policy "api_keys_insert_own"
  on public.api_keys for insert
  with check (
    user_id = auth.uid()
    and public.is_workspace_member(workspace_id)
  );

-- UPDATE exists for revocation, and the trigger below is what keeps it to that.
-- Membership is deliberately NOT required: somebody who has been removed from a
-- workspace should still be able to revoke the key they left behind.
drop policy if exists "api_keys_update_own" on public.api_keys;

create policy "api_keys_update_own"
  on public.api_keys for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "api_keys_delete_own" on public.api_keys;

create policy "api_keys_delete_own"
  on public.api_keys for delete
  using (user_id = auth.uid());

-- ---- what an update may change -------------------------------------------
--
-- The policy above says who may update. This says what an update is for, the
-- way 0028 and 0030 pinned the columns a client could choose on ideas.
--
-- Two things it stops. Re-pointing a row — a new `token_hash`, a different
-- `user_id`, another workspace — would turn "revoke a key" into "swap the secret
-- behind a row somebody else's audit trail is looking at". And un-revoking:
-- without the second check, revocation is reversible, so a key revoked because
-- it leaked comes back the moment the same request is replayed with a null.
create or replace function public.api_keys_only_revocation()
returns trigger
language plpgsql
as $$
begin
  if new.id is distinct from old.id
    or new.workspace_id is distinct from old.workspace_id
    or new.user_id is distinct from old.user_id
    or new.token_hash is distinct from old.token_hash
    or new.prefix is distinct from old.prefix
    or new.created_at is distinct from old.created_at
  then
    raise exception 'an api key can only be renamed or revoked'
      using errcode = '42501';
  end if;

  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'a revoked api key cannot be restored'
      using errcode = '42501';
  end if;

  -- last_used_at is written by the service role, which does not reach this
  -- trigger's `authenticated` path in practice — but it is left out of the list
  -- above rather than defended here, because a rule that fires on the row's own
  -- bookkeeping would make every request's touch fail.
  return new;
end;
$$;

drop trigger if exists api_keys_only_revocation on public.api_keys;

create trigger api_keys_only_revocation
  before update on public.api_keys
  for each row
  execute function public.api_keys_only_revocation();

-- ---- what an admin may know ----------------------------------------------
--
-- One number, for the dialog that removes somebody from a workspace. Their keys
-- die with their membership, and an admin who is not told that finds out when a
-- script stops at three in the morning.
--
-- SECURITY DEFINER because the policies above are own-keys-only by design, and
-- it checks `is_workspace_admin` for itself rather than trusting a caller who
-- has already checked — the arrangement 0032 settled on. It raises instead of
-- returning zero, because "you are not an admin" and "they have no keys" are
-- different answers and a bare 0 cannot tell them apart.
--
-- Nothing here identifies a key. A name or a prefix would put one person's
-- credentials on another person's screen for a reason that only needs a count.
create or replace function public.workspace_api_key_count(
  p_workspace_id uuid,
  p_user_id uuid
)
returns integer
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  n integer;
begin
  if not public.is_workspace_admin(p_workspace_id) then
    raise exception 'not an admin of this workspace' using errcode = '42501';
  end if;

  select count(*)
    into n
    from public.api_keys k
   where k.workspace_id = p_workspace_id
     and k.user_id = p_user_id
     and k.revoked_at is null;

  return n;
end;
$$;

-- Reached through PostgREST, so it follows 0032's rule rather than 0021's:
-- revoked from PUBLIC and granted back to the roles that actually call it.
revoke execute on function public.workspace_api_key_count(uuid, uuid) from public;
grant execute on function public.workspace_api_key_count(uuid, uuid) to authenticated, service_role;
