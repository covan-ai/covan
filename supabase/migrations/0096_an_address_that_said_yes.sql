-- An address that said yes: an email delivery channel sends to an address
-- only once that address has confirmed it wants the messages.
--
-- A channel of kind 'email' took any address and the routine engine mailed it
-- -- a digest, a test message, a "paused" notice -- under Covan's name, with a
-- subject the routine's owner wrote. Any free account could aim that at
-- anybody. Now an address is either the owner's own confirmed sign-in address
-- (the API stamps it confirmed when it sees that) or it has opened a link sent
-- to it and said yes.
--
--   confirmed_at            when the address confirmed, or the API saw it was
--                           the owner's own. Null on an email channel means
--                           nothing is sent to it. Not used by the other kinds:
--                           a webhook's or a Slack URL's owner is whoever set
--                           it up, and a URL cannot be mailed a question.
--   confirmation_hash       SHA-256 hex of the token in the confirmation link,
--                           cleared once used. Never granted to a client.
--   confirmation_sent_at    when the last link went out: a link older than
--                           seven days confirms nothing, and a new one is not
--                           sent more than once a day per channel.
--
-- Existing email channels start unconfirmed. The first delivery after this
-- confirms the ones addressed to their owner's own sign-in address on the spot
-- and mails a link to every other one, so a digest a person sends themselves
-- carries on and one aimed at somebody else waits for them to agree.

alter table public.delivery_channels
  add column if not exists confirmed_at timestamptz,
  add column if not exists confirmation_hash text,
  add column if not exists confirmation_sent_at timestamptz;

create unique index if not exists delivery_channels_confirmation_hash_key
  on public.delivery_channels (confirmation_hash)
  where confirmation_hash is not null;

-- How many links a person has sent today is counted per owner.
create index if not exists delivery_channels_confirmation_sent_idx
  on public.delivery_channels (user_id, confirmation_sent_at)
  where confirmation_sent_at is not null;

grant select (confirmed_at) on public.delivery_channels to authenticated;
