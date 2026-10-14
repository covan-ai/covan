-- A face from here: `profiles.avatar_url` is null or the path of a photo this
-- API stored for that person, `/avatars/<their id>/<32 hex>.<png|jpg|webp>`.
--
-- 0082 granted the column to its owner, because the upload route writes it
-- through the caller's own client, and left the value free. Any `https://` URL
-- went in, and every member list a co-member opened loaded it: an image on
-- somebody else's server, fetched by every browser that showed the face, with
-- each viewer's address and the time they looked. Sign-up copied
-- `raw_user_meta_data.avatar_url` the same way, and that metadata is whatever
-- the person signing up sent.
--
-- No identity provider sets this column today -- sign-in is email and
-- password -- so the only well-formed value is the one `routes/avatars.ts`
-- writes, and a constraint can say so for every writer at once. Sign-up drops
-- a value that does not fit rather than failing the sign-up over a field
-- nobody sees on that form.
--
-- Values that already break the rule are cleared, with a notice; the person
-- sees their monogram until they upload a photo.

do $$
declare
  v_count bigint;
begin
  update public.profiles
     set avatar_url = null
   where avatar_url is not null
     and avatar_url !~ ('^/avatars/' || id::text || '/[0-9a-f]{32}\.(png|jpg|webp)$');
  get diagnostics v_count = row_count;
  if v_count > 0 then
    raise notice 'profiles: % avatar_url value(s) cleared that were not a photo stored here', v_count;
  end if;
end $$;

alter table public.profiles drop constraint if exists profiles_avatar_url_stored_here;
alter table public.profiles
  add constraint profiles_avatar_url_stored_here
  check (avatar_url is null
         or avatar_url ~ ('^/avatars/' || id::text || '/[0-9a-f]{32}\.(png|jpg|webp)$'));

create or replace function public.profiles_drop_foreign_avatar()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.avatar_url is not null
     and new.avatar_url !~ ('^/avatars/' || new.id::text || '/[0-9a-f]{32}\.(png|jpg|webp)$')
  then
    new.avatar_url := null;
  end if;
  return new;
end;
$$;

revoke all on function public.profiles_drop_foreign_avatar() from public;

drop trigger if exists trg_profiles_drop_foreign_avatar on public.profiles;
create trigger trg_profiles_drop_foreign_avatar
  before insert on public.profiles
  for each row execute function public.profiles_drop_foreign_avatar();
