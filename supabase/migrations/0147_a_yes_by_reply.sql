-- =========================================================================
-- A yes by reply
--
-- The request email (0144) links to a page with two buttons. Somebody reading
-- it on a phone at 07:00 would rather type "yes" and send. So the email's
-- Reply-To is an address on `INBOUND_EMAIL_DOMAIN` that names the request,
-- signed like a report's (`lib/inbound-email/address.ts`), and a reply to it
-- is an answer — through `answer_approval_as` (0143), the service role's door,
-- which decides owner-or-admin in Postgres exactly as the app's does.
--
-- What the worker requires before it opens that door, every one of them:
-- the delivery is Resend's (signature), the sender's domain passed DMARC —
-- strictly, so the From is aligned with what was checked — the sender is the
-- owner's own account address, and the first line they wrote, quotes cut, is
-- one of a short list of words for yes or no. No model reads it; anything
-- else gets "open the link" back.
--
-- **This is as strong as the owner's mailbox and no stronger.** A delegate
-- with access to it, a mailbox somebody else has taken over, or a rule that
-- forwards and replies, can say yes on the owner's behalf, and nothing here
-- can tell. So it is a switch per person, on by default like the email it
-- answers, and the email says so in its footnote.
-- =========================================================================

alter table public.notification_preferences
  add column if not exists approve_by_reply boolean not null default true;

-- An upsert keyed on user_id: the same columns both ways (0094).
grant insert (approve_by_reply) on public.notification_preferences to authenticated;
grant update (approve_by_reply) on public.notification_preferences to authenticated;
