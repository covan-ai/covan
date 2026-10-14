-- An invitation you can hold: accepting one takes the secret from the email
-- that carried it, not just the address it was sent to.
--
-- `accept_invitation` (0029) let anybody whose confirmed address matched the
-- invitation's accept it. That made "confirmed" the whole credential, and a
-- confirmed address only proves a mailbox when the install actually sends a
-- confirmation. The compose stack auto-confirms by default (it ships with no
-- mailer), and an install that leaves it that way lets anybody sign up as an
-- invitee's address before the invitee does, see the pending invitation, and
-- take it -- at whatever role it carries, admin included.
--
-- So an invitation now has a token: 32 random bytes the API mints and mails,
-- of which the database keeps only a SHA-256. `accept_invitation` takes it
-- alongside the id and refuses without it. Reading the mail is what proves
-- the mailbox, whatever the install's confirmation setting is. The address
-- still has to match as well, so the token alone is not a way into somebody
-- else's account either.
--
-- One answer for every refusal (wrong token, no token, expired, accepted,
-- revoked, someone else's address): telling them apart tells a guesser which
-- part they got right.
--
-- Invitations made before this have no token and cannot be accepted. They stay
-- pending, and the admin's list marks them for a new link:
-- `reissue_invitation` mints a fresh token, restarts the seven days and logs
-- `invitation.resent`.
--
-- `token_hash` is granted to no client role -- an admin listing invitations
-- has no use for it -- and the insert grant names the columns a client may
-- set, so `status`, `expires_at` and `accepted_*` keep their defaults.

alter table public.invitations
  add column if not exists token_hash text,
  add column if not exists token_issued_at timestamptz;

alter table public.invitations
  drop constraint if exists invitations_token_hash_shape;
alter table public.invitations
  add constraint invitations_token_hash_shape
  check (token_hash is null or token_hash ~ '^[0-9a-f]{64}$');

-- ---- which columns a client may touch ----------------------------------------

revoke all on public.invitations from anon, authenticated;
grant select (id, workspace_id, email, role, invited_by, status, created_at,
              accepted_at, accepted_by, expires_at, token_issued_at)
  on public.invitations to authenticated;
grant insert (workspace_id, email, role, invited_by, token_hash)
  on public.invitations to authenticated;
grant delete on public.invitations to authenticated;

-- A client inserting a token records when it was minted. Not a default: a row
-- inserted without one has no token to date.
create or replace function public.invitations_stamp_token()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.token_issued_at := case when new.token_hash is null then null else now() end;
  return new;
end;
$$;

revoke all on function public.invitations_stamp_token() from public;

drop trigger if exists trg_invitations_stamp_token on public.invitations;
create trigger trg_invitations_stamp_token
  before insert on public.invitations
  for each row execute function public.invitations_stamp_token();

-- ---- accepting -------------------------------------------------------------------

create or replace function public.accept_invitation(p_invite_id uuid, p_token text)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_invite public.invitations;
  v_email text;
begin
  -- A request made with an API key carries a workspace it is held to (0087),
  -- and joining another one is the opposite of that. The API refuses it too.
  if public.request_workspace() is not null then
    raise exception 'an invitation is accepted by its invitee, signed in' using errcode = '42501';
  end if;

  -- From the account itself, not from the token's claims: the address and its
  -- confirmation are GoTrue's to state.
  select lower(u.email) into v_email
    from auth.users u
   where u.id = auth.uid() and u.email_confirmed_at is not null;

  if v_email is null then
    raise exception 'confirm your email address before accepting an invitation'
      using errcode = '42501';
  end if;

  select * into v_invite
    from public.invitations
   where id = p_invite_id
     and status = 'pending'
     and expires_at > now()
     and token_hash is not null
     and token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex')
     and lower(email) = v_email
   for update;

  if not found then
    raise exception 'this invitation link is not valid any more — ask for a new one'
      using errcode = 'P0002';
  end if;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_invite.workspace_id, auth.uid(), v_invite.role)
  on conflict (workspace_id, user_id) do nothing;

  update public.invitations
     set status = 'accepted', accepted_at = now(), accepted_by = auth.uid(), token_hash = null
   where id = p_invite_id;

  update public.profiles
     set active_workspace_id = v_invite.workspace_id
   where id = auth.uid();

  return v_invite.workspace_id;
end;
$$;

grant execute on function public.accept_invitation(uuid, text) to authenticated, service_role;
revoke execute on function public.accept_invitation(uuid, text) from public, anon;

-- The one-argument form, for the minutes between this migration and the API
-- that sends a token. It accepts nothing. A later migration drops it.
create or replace function public.accept_invitation(p_invite_id uuid)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  raise exception 'open the link in your invitation email to accept it'
    using errcode = 'P0002';
end;
$$;

grant execute on function public.accept_invitation(uuid) to authenticated, service_role;
revoke execute on function public.accept_invitation(uuid) from public, anon;

-- ---- a new link --------------------------------------------------------------

create or replace function public.reissue_invitation(p_invite_id uuid, p_token_hash text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_invite public.invitations;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'not a token hash' using errcode = '22023';
  end if;

  select * into v_invite
    from public.invitations
   where id = p_invite_id and status = 'pending'
   for update;

  -- Same answer for "no such invitation" and "not yours to resend": an admin
  -- of one workspace learns nothing about another's.
  if not found or not public.is_workspace_admin(v_invite.workspace_id) then
    raise exception 'invitation not found' using errcode = 'P0002';
  end if;

  update public.invitations
     set token_hash = p_token_hash,
         token_issued_at = now(),
         expires_at = now() + interval '7 days'
   where id = p_invite_id;

  perform public.log_workspace_event(
    v_invite.workspace_id, 'invitation.resent', 'invitation', v_invite.id, v_invite.email,
    jsonb_build_object('role', v_invite.role));
end;
$$;

grant execute on function public.reissue_invitation(uuid, text) to authenticated, service_role;
revoke execute on function public.reissue_invitation(uuid, text) from public, anon;
