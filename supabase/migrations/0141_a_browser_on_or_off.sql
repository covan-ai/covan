-- =========================================================================
-- A browser on or off
--
-- A routine's browser had three settings (0100): off; `all`, carrying what a
-- conversation's browser would; and `site`, a browser with none of the
-- owner's sign-ins and one saved login, typed on one host. The third was a
-- second permission model inside the first, and it is gone with the rest of
-- the per-operation detail (0140): a routine may use the browser, or it may
-- not.
--
-- Rows on `site` become `off`, not `all`. Turning on the owner's whole
-- cookie jar for a routine they had narrowed to one site would be widening a
-- permission nobody asked to widen; the owner turns it back on, on the
-- routine's page, if they want it.
-- =========================================================================

update public.routines set browser_access = 'off' where browser_access = 'site';

alter table public.routines drop constraint if exists routines_browser_site_named;
alter table public.routines drop constraint if exists routines_browser_site_host;
alter table public.routines drop constraint if exists routines_browser_access_known;
alter table public.routines
  add constraint routines_browser_access_known check (browser_access in ('off', 'all'));

alter table public.routines drop column if exists browser_site;

comment on column public.routines.browser_access is
  'off | all. all: a scheduled run may use the browser, carrying what the owner''s '
  'browser in a conversation would. Turning it on is the owner''s approval for every run '
  '(0100, 0141).';
