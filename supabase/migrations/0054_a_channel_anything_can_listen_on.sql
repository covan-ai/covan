-- =========================================================================
-- A channel anything can listen on
--
-- Routines have been able to deliver to two places since 0012: a Slack
-- incoming webhook and an email address. Both are destinations a person reads.
-- Neither is a destination a *system* reads, which is what it takes for a
-- routine's output to become an input somewhere else — a deploy, a ticket, a
-- row in someone's own database.
--
-- So: a third kind, `webhook`. It POSTs a signed JSON body to a URL the
-- workspace chose. Nothing here is specific to a vendor, which is the point —
-- the width comes from the adapter rather than from a list of named
-- integrations that has to be maintained one connector at a time.
--
-- WHAT THIS MIGRATION IS NOT. There is no new column. The signing secret
-- shares `secret_ciphertext` with the URL, as one JSON object encrypted under
-- the existing envelope (`lib/secret-box.ts`):
--
--   {"v":1,"url":"https://…","signingSecret":"whsec_…"}
--
-- Two reasons, and the second is the deciding one. `secret_ciphertext` keeps
-- its property of being the one column on this table carrying a secret, so
-- 0023's column-level grant keeps being the whole answer to what a client may
-- read. And the signing secret must not be derived from ROUTINE_SECRET_KEY,
-- tempting as that is: that key also opens every other delivery channel and
-- every OAuth token in `connections`, so one receiver's leaked copy of a
-- derived secret would force a rotation of all of them. Per-channel means
-- per-channel rotation.
--
-- WHY 0023'S GRANT IS NOT TOUCHED HERE, so nobody "fixes" it later: that grant
-- is `select (id, workspace_id, user_id, kind, label, created_at)` — a column
-- list, deliberately. This migration adds no column and removes none, so the
-- list is still exactly right. A `webhook` row is selectable by its owner in
-- the same six columns as the other two kinds, and its secret is selectable by
-- nobody, the same way.
-- =========================================================================

-- ---- delivery_channels.kind: 'webhook' -----------------------------------
-- Found rather than named, the way 0047 widened routines.source_kind: 0012
-- wrote this check inline on the column, so its name is whatever Postgres
-- generated — `delivery_channels_kind_check` on a database that has only ever
-- run these migrations in order, and something else anywhere the column was
-- rebuilt. A `drop constraint if exists` against a guessed name fails quietly
-- when it guesses wrong: it skips, the new constraint is added beside the old
-- one, and every webhook channel is then refused by a constraint nobody is
-- looking at.
--
-- The pattern is `%kind in (%` rather than 0047's looser `%kind%`. This table
-- has one check constraint today and a loose pattern would find it, but it
-- would also find any future constraint whose body merely mentions the word —
-- `check (kind <> 'email' or label ~ '@')`, say — and drop it on the way past,
-- silently, in a migration about something else. Matching the shape of the
-- constraint being replaced is what keeps this to the one it means.
do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select con.conname
    from pg_constraint con
    where con.conrelid = 'public.delivery_channels'::regclass
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%kind in (%'
  loop
    execute format('alter table public.delivery_channels drop constraint %I', constraint_name);
  end loop;
end;
$$;

alter table public.delivery_channels
  add constraint delivery_channels_kind_check
  check (kind in ('slack_webhook', 'email', 'webhook'));

comment on column public.delivery_channels.kind is
  'slack_webhook | email | webhook. Decides how secret_ciphertext is read: a Slack URL, an address, or a JSON object {"v":1,"url":…,"signingSecret":…} for a signed POST to an arbitrary endpoint.';

comment on column public.delivery_channels.secret_ciphertext is
  'AES-GCM under ROUTINE_SECRET_KEY, via lib/secret-box.ts. Granted to no client role. Shape depends on kind — see the comment on kind.';
