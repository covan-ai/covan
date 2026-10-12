-- A face, a sentence and a clock: a person can say more about themselves than
-- a name.
--
-- Until now the only thing anybody could change about their own profile was
-- `name`. The avatar was whatever the sign-in provider handed over -- and since
-- the sign-up form sends none and no OAuth provider is wired, that was nothing
-- -- and the email was fixed at sign-up. This adds the three text fields the
-- account page now edits (`bio`, `locale`, `timezone`), makes `email` follow
-- the auth record when somebody changes their address, and narrows who may
-- write which column.
--
-- ---------------------------------------------------------------------------
-- WHY THE AVATAR'S BYTES ARE NOT IN THIS DATABASE.
--
-- `avatar_url` keeps holding a URL, and an uploaded photo's URL is a path the
-- API serves (`/avatars/<user>/<random>.<ext>`) from the same document store
-- that holds uploaded files. The alternative that needs no new route -- a
-- `data:` URL in this column -- would put the image inside every row that
-- embeds a profile: `/me` for every member of every workspace, every message's
-- `sender:profiles(...)`, every search result and every export. A 100 KB photo
-- multiplied by that is the wrong shape. Supabase Storage would be a second
-- blob store that the compose stack does not run. The document store already
-- works on both runtimes, so the bytes go there and only the path comes here.
--
-- ---------------------------------------------------------------------------
-- WHY `email` BECOMES THE TRIGGER'S, AND WHY THE GRANT NARROWS.
--
-- An address change is confirmed by GoTrue, on `auth.users`, and nothing here
-- ever heard about it: `profiles.email` was written once by `handle_new_user`
-- and then went stale the day somebody changed theirs, while the team page
-- kept showing the old one. `sync_profile_email` mirrors the change the moment
-- GoTrue commits it, the same way `on_auth_user_created` already mirrors the
-- sign-up.
--
-- Once a trigger owns the column, a client must not. The table-wide UPDATE
-- grant from 0023 let anybody set their own `email` to anything through
-- PostgREST -- `profiles_update_own` scopes the ROW to the caller, not the
-- columns -- and co-members read that column as who this person is. So the
-- grant becomes a column list that leaves `email` out: RLS still decides whose
-- row, the grant now decides which fields. 0012 does the same for
-- `delivery_channels.label` and 0043 for `connections`.
--
-- The list is short because the writers are: the API sets `name` and the three
-- new fields (`routes/me.ts`), `avatar_url` (`routes/avatars.ts`) and
-- `active_workspace_id` (`lib/workspace.ts`, `routes/workspace.ts`). The
-- SECURITY DEFINER functions that also write `active_workspace_id`
-- (`create_workspace`, `accept_invitation`) run as their owner and are not
-- affected by a role's grant. `service_role` is left as it was.
--
-- ---------------------------------------------------------------------------
-- THE CHECKS.
--
-- `bio` is a sentence, not a page: 280 characters, the length the account page
-- counts down from. `locale` is the shape of a BCP 47 tag, not a list of them;
-- nothing reads it yet, and a list would be a migration every time somebody
-- wants a language nobody thought of. `timezone` is the shape of an IANA name;
-- the API canonicalises it against the runtime's own zone database before it
-- gets here, and the check is what stops a client that skipped the API from
-- storing a path. None of them is `not null`: an unset field means "follow the
-- browser", which is the default everybody had before this file.
--
-- Idempotent, so it can be re-applied by hand without harm.

alter table public.profiles
  add column if not exists bio text,
  add column if not exists locale text,
  add column if not exists timezone text;

alter table public.profiles drop constraint if exists profiles_bio_length;
alter table public.profiles add constraint profiles_bio_length
  check (bio is null or char_length(bio) <= 280);

alter table public.profiles drop constraint if exists profiles_locale_shape;
alter table public.profiles add constraint profiles_locale_shape
  check (locale is null or locale ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$');

alter table public.profiles drop constraint if exists profiles_timezone_shape;
alter table public.profiles add constraint profiles_timezone_shape
  check (
    timezone is null
    or (char_length(timezone) <= 64 and timezone ~ '^[A-Za-z_]+(/[A-Za-z0-9_+-]+)*$')
  );

comment on column public.profiles.bio is
  'A sentence about the person, at most 280 characters. Visible to co-members.';
comment on column public.profiles.locale is
  'BCP 47 tag the person chose, or null for "follow the browser". Nothing reads it yet.';
comment on column public.profiles.timezone is
  'IANA zone name, canonicalised by the API, or null for "follow the browser". Visible to co-members.';

-- ---- email follows auth.users ----------------------------------------------

create or replace function public.sync_profile_email()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.email is distinct from old.email then
    update public.profiles set email = new.email where id = new.id;
  end if;
  return new;
end;
$$;

-- A trigger function cannot be called directly, so there is no endpoint to
-- close here; the revoke is for the reader who checks every definer function
-- for one rather than for Postgres.
revoke all on function public.sync_profile_email() from public;

drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row execute function public.sync_profile_email();

-- Catch up on every address that already drifted before the trigger existed.
update public.profiles p
   set email = u.email
  from auth.users u
 where u.id = p.id
   and p.email is distinct from u.email;

-- ---- which columns a client may write --------------------------------------

revoke update on public.profiles from anon, authenticated;
grant update (name, avatar_url, bio, locale, timezone, active_workspace_id)
  on public.profiles to authenticated;
