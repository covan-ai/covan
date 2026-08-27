-- 0029_an_invitation_that_does_not_wait_forever.sql
--
-- accept_invitation matches the invite's email against the caller's verified
-- JWT email — deliberately, so that the address is the credential and no token
-- ever has to travel in a link. That works only for as long as the address
-- means the same person.
--
-- 0003 gave invitations a created_at and no expiry, so a pending row waits
-- indefinitely. Corporate mail gets reassigned to new hires; personal domains
-- lapse and can be re-registered. Either way the next holder of the address
-- signs up, finds the invite waiting in GET /invitations/incoming, and joins
-- the workspace at the role the original invite offered — which may be admin.
--
-- Ids are gen_random_uuid() and acceptance is single-use and email-bound
-- already, so expiry is the only leg that was missing.

alter table public.invitations
  add column expires_at timestamptz not null default now() + interval '7 days';

-- Rows that predate this column get the same window from now rather than being
-- retroactively dead, so a legitimately pending invite is not silently voided
-- by the deploy.
update public.invitations
  set expires_at = now() + interval '7 days'
  where status = 'pending';

-- ---- accept_invitation() RPC ----------------------------------------------
-- Runs as owner (bypasses RLS) so a not-yet-member invitee can join. Validates
-- the caller's JWT email matches the invite, inserts membership, marks accepted,
-- and switches the caller's active workspace to the joined one. Returns the id.
--
-- Two changes from 0003's version: the SELECT that loads v_invite now also
-- requires expires_at > now(), and — because the address IS the credential —
-- a defence-in-depth check that the caller's own address was actually
-- confirmed, since the self-host stack hardcodes GOTRUE_MAILER_AUTOCONFIRM and
-- ships with signup open by default. security definer is what lets this read
-- auth.users; the function already has it and already sets search_path.
create or replace function public.accept_invitation(p_invite_id uuid)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_invite public.invitations;
  v_email text;
begin
  if not exists (
    select 1 from auth.users u
    where u.id = auth.uid() and u.email_confirmed_at is not null
  ) then
    raise exception 'confirm your email address before accepting an invitation';
  end if;

  v_email := lower(coalesce(auth.jwt() ->> 'email', ''));

  select * into v_invite
  from public.invitations
  where id = p_invite_id and status = 'pending' and expires_at > now();

  if not found then
    raise exception 'invitation not found, already handled, or has expired';
  end if;

  if lower(v_invite.email) <> v_email then
    raise exception 'this invitation is not addressed to you';
  end if;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_invite.workspace_id, auth.uid(), v_invite.role)
  on conflict (workspace_id, user_id) do nothing;

  update public.invitations
    set status = 'accepted', accepted_at = now(), accepted_by = auth.uid()
    where id = p_invite_id;

  update public.profiles
    set active_workspace_id = v_invite.workspace_id
    where id = auth.uid();

  return v_invite.workspace_id;
end;
$$;

grant execute on function public.accept_invitation(uuid) to authenticated;
