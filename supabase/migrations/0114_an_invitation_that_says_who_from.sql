-- =========================================================================
-- An invitation that says who it is from
--
-- Somebody invited to a workspace was shown "You've been invited · as member"
-- with no workspace and no inviter. The incoming list joined `workspaces(name)`
-- through the invitee's own client, and the invitee is by definition not yet a
-- member, so `workspaces`' policy hid the row and the name came back empty.
-- The signed-out `/invite` page knew even less: only that some invitation
-- existed.
--
-- Two readers, each answering exactly what the person in front of it already
-- holds:
--
--   incoming_invitations()          the caller's own pending invitations —
--                                   addressed to the address on their
--                                   account — with the workspace's name and
--                                   the inviter's. The same rows
--                                   GET /invitations/incoming already
--                                   returned, plus two names.
--
--   invitation_preview(id, token)   for the `/invite` page before anybody has
--                                   signed in. Answers only for the id AND the
--                                   token from the email, which is the proof
--                                   0090 already treats as the invitee's.
--                                   Returns the two names, the role, the
--                                   address the account has to be, and whether
--                                   it is still open; nothing for a wrong
--                                   pair, the same nothing for every wrong
--                                   pair.
--
-- Both are SECURITY DEFINER because neither reader can see `workspaces` or
-- `profiles` yet, which is the whole problem. The preview is granted to
-- service_role only, like every token check in this schema: no definer
-- function answers the anon key (0084), so the API asks it on the page's
-- behalf (`routes/invitation-preview.ts`). Neither returns anything about a
-- workspace beyond its name, and neither accepts anything: accepting is still
-- `accept_invitation(id, token)`, a button pressed while signed in.
-- =========================================================================

create or replace function public.incoming_invitations()
returns table (
  id uuid,
  workspace_id uuid,
  workspace_name text,
  inviter_name text,
  role text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select i.id, i.workspace_id, w.name, nullif(trim(p.name), ''), i.role, i.created_at
  from public.invitations i
  join public.workspaces w on w.id = i.workspace_id
  left join public.profiles p on p.id = i.invited_by
  where i.status = 'pending'
    and i.expires_at > now()
    and i.email = (select lower(u.email) from auth.users u where u.id = auth.uid())
  order by i.created_at desc;
$$;

revoke all on function public.incoming_invitations() from public, anon;
grant execute on function public.incoming_invitations() to authenticated, service_role;

create or replace function public.invitation_preview(p_invite_id uuid, p_token text)
returns table (
  workspace_name text,
  inviter_name text,
  email text,
  role text,
  open boolean
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select w.name,
         nullif(trim(p.name), ''),
         i.email,
         i.role,
         (i.status = 'pending' and i.expires_at > now())
  from public.invitations i
  join public.workspaces w on w.id = i.workspace_id
  left join public.profiles p on p.id = i.invited_by
  where i.id = p_invite_id
    and i.token_hash is not null
    and p_token is not null
    and length(p_token) <= 200
    and i.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
$$;

revoke all on function public.invitation_preview(uuid, text) from public, anon, authenticated;
grant execute on function public.invitation_preview(uuid, text) to service_role;
