-- =========================================================================
-- What a Slack install was allowed to hear
--
-- Until now the Slack app asked for what answering a question needs: to see a
-- mention, to read a direct message, to post a reply, to look a person up. A
-- routine that starts when somebody writes in a channel, or reacts to a
-- message, needs three scopes more — `channels:history`, `groups:history`,
-- `reactions:read` — and Slack grants scopes per install. An install made
-- before this change keeps working exactly as before and hears none of those
-- events until somebody reinstalls it.
--
-- So the install records which scopes Slack actually granted (`scopes`, from
-- `oauth.v2.access`), and two things read it:
--
--   * the Integrations page, which says "reconnect Slack" when an event the
--     workspace could use needs a scope its install does not have; and
--   * the Slack event adapter (`lib/routines/events/slack.ts`), which refuses
--     to set up a routine its install cannot hear, with that same sentence,
--     rather than leaving it "listening" to a channel Slack never tells it
--     about.
--
-- Null means the row was written before this migration, which is the same as
-- "not granted": nothing before it asked for these scopes.
--
-- WHAT THIS DELIBERATELY DOES NOT DO.
--
--   * It does not backfill. There is nothing to backfill from: the only way to
--     learn an install's scopes is to ask Slack with its token, and the only
--     answer that changes anything is the one a reinstall brings.
--
--   * It does not let a client write the column. It is written by the install
--     route as the service role, beside the token, and read by members the way
--     every other non-secret column of the row is (0044).
-- =========================================================================

alter table public.slack_installations
  add column if not exists scopes text[];

grant select (scopes) on public.slack_installations to authenticated;
