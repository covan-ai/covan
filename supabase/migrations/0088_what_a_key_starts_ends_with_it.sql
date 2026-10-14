-- What a key starts ends with it: a routine, a delivery channel or a webhook
-- trigger made with an API key carries that key, and revoking the key stops
-- all three.
--
-- A key is allowed to set up scheduled work -- a nightly script that creates
-- or adjusts routines is what the API is mostly for. But a routine runs on its
-- own long after the request that made it, as its owner, delivering to
-- wherever its channel points. Made with a key that later leaks, that is a
-- webhook somebody else chose, receiving a summary of the workspace every
-- morning, and revoking the key changed nothing: the routine never asked
-- which key made it. Neither did the channel, nor the trigger token that lets
-- a third party start a run.
--
-- So each records the key:
--
--   routines           stamped by the database. A key request runs on a
--                      token that names the key (`covan_key`), the column's
--                      default reads it, and a trigger makes sure a client
--                      can neither choose the value nor clear it. Two paths
--                      create routines -- the API and the agent's
--                      `schedule_job` tool -- and both go through the
--                      caller's own client, so both are covered without
--                      either knowing.
--   delivery_channels  written by the API, which creates these with the
--   routine_triggers   service role (the row holds a secret). It passes the
--                      key along explicitly.
--
-- And revoking a key -- `revoked_at` going from null to a time -- does three
-- things in the same statement:
--
--   * the key's channels are disabled. Not deleted: a routine references its
--     channel with a foreign key, and a disabled channel is one the executor
--     and the API refuse to deliver to or to choose;
--   * every active routine the key made, or that delivers to one of those
--     channels, is paused, with a reason the routine page shows;
--   * the key's webhook triggers are deleted, so their tokens stop working.
--
-- A key can no longer be deleted by a client, only revoked: `on delete set
-- null` would have untagged everything it made without running any of the
-- above. Nothing in the API deleted a key row; revocation was always an
-- update.

-- ---- the claim ---------------------------------------------------------------

create or replace function public.request_api_key()
returns uuid
language sql
stable
as $$
  select nullif(
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb
      ->> 'covan_key',
    ''
  )::uuid
$$;

-- ---- the columns -------------------------------------------------------------

alter table public.routines
  add column if not exists api_key_id uuid
    default public.request_api_key()
    references public.api_keys (id) on delete set null;

alter table public.delivery_channels
  add column if not exists api_key_id uuid references public.api_keys (id) on delete set null,
  add column if not exists disabled_at timestamptz;

alter table public.routine_triggers
  add column if not exists api_key_id uuid references public.api_keys (id) on delete set null;

-- `delivery_channels` is readable column by column (0023 keeps the secret
-- out). The two new columns are the owner's to see: which key made a channel,
-- and whether it still delivers -- which the routine guard below and the
-- channel list both ask through the caller's own client.
grant select (api_key_id, disabled_at) on public.delivery_channels to authenticated;

create index if not exists routines_api_key_idx
  on public.routines (api_key_id) where api_key_id is not null;
create index if not exists delivery_channels_api_key_idx
  on public.delivery_channels (api_key_id) where api_key_id is not null;
create index if not exists routine_triggers_api_key_idx
  on public.routine_triggers (api_key_id) where api_key_id is not null;

-- ---- a routine's key is the database's to write ----------------------------
--
-- For a client: on insert, whatever the token says (null for a browser
-- session); on update, whatever it already was. The service role and definer
-- functions are trusted, as in 0085, and told apart the same way.
--
-- And for everyone: a routine cannot be pointed at a disabled channel. The
-- policies only ask whose the channel is.

create or replace function public.routines_guard_key_and_channel()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      new.api_key_id := public.request_api_key();
    else
      new.api_key_id := old.api_key_id;
    end if;
  end if;

  if (tg_op = 'INSERT' or new.delivery_channel_id is distinct from old.delivery_channel_id)
     and exists (select 1 from public.delivery_channels dc
                  where dc.id = new.delivery_channel_id and dc.disabled_at is not null) then
    raise exception 'that delivery channel was disabled when the API key that made it was revoked'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

revoke all on function public.routines_guard_key_and_channel() from public;

drop trigger if exists trg_routines_guard_key_and_channel on public.routines;
create trigger trg_routines_guard_key_and_channel
  before insert or update on public.routines
  for each row execute function public.routines_guard_key_and_channel();

-- ---- revoking a key stops what it started ----------------------------------

create or replace function public.api_keys_stop_what_the_key_started()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.delivery_channels
     set disabled_at = now()
   where api_key_id = new.id
     and disabled_at is null;

  update public.routines
     set status = 'paused',
         paused_reason = 'The API key that set this up was revoked.',
         updated_at = now()
   where status = 'active'
     and (api_key_id = new.id
          or delivery_channel_id in (
            select id from public.delivery_channels where api_key_id = new.id));

  delete from public.routine_triggers where api_key_id = new.id;

  return new;
end;
$$;

revoke all on function public.api_keys_stop_what_the_key_started() from public, anon;

drop trigger if exists trg_api_keys_stop_what_the_key_started on public.api_keys;
create trigger trg_api_keys_stop_what_the_key_started
  after update of revoked_at on public.api_keys
  for each row
  when (old.revoked_at is null and new.revoked_at is not null)
  execute function public.api_keys_stop_what_the_key_started();

-- ---- revoked, never deleted ---------------------------------------------------

revoke delete on public.api_keys from anon, authenticated;
drop policy if exists "api_keys_delete_own" on public.api_keys;
