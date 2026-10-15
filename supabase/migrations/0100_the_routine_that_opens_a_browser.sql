-- =========================================================================
-- The routine that opens a browser
--
-- Until now `browse` refused every scheduled run: "a browser task reports back
-- into a conversation and a scheduled run has none". Both halves of that were
-- true. A browser task's answer arrives minutes after the turn that asked for
-- it, and the routine engine delivered its report the moment the turn ended,
-- so there was nowhere for the answer to go; and `browse` asks a person before
-- it runs, and a tick has nobody to ask.
--
-- This migration gives a routine the two things it was missing.
--
-- ---------------------------------------------------------------------------
-- PERMISSION, ASKED ONCE AND KEPT ON THE ROUTINE.
--
--   browser_access   'off' (the default, and every routine that exists),
--                    'all' or 'site'. Turning it on is the approval the card
--                    would have asked for, given once by the routine's owner
--                    for every run, which is the only shape an approval can
--                    take when nobody is watching.
--   browser_site     with 'site', the one host whose saved login a run may
--                    carry. Normalised the way `browser_tasks.login_host` is
--                    (0080), so it is compared with a saved `site_host`
--                    without a second normaliser.
--
-- What the two words decide is what the run CARRIES, because that is the
-- part of an unattended browser that a stranger's text could steer. A feed
-- entry or a watched page reaches the model as material, and the model writes
-- the browser's instruction:
--
--   'all'   what a conversation's browser carries: the owner's cookie jar and
--           any login saved for a site the task names, by the rules `browse`
--           already applies in chat.
--   'site'  no cookie jar at all — the run's browser opens without a profile,
--           so nothing the owner signed into by hand is reachable — and only
--           `browser_site`'s saved login, typed only on that site (the
--           bindings `credentialsFor` builds already lock it there).
--
-- Written by the owner's own client through `PATCH /routines/:id`, so 0094's
-- column grant gains the two columns; `routines_update_own` already decides
-- whose row it is. `tests/rls/grant-ratchet.test.ts` holds the new list.
--
-- ---------------------------------------------------------------------------
-- A CONVERSATION THE BROWSER CAN REPORT INTO.
--
--   browser_conversation_id   the owner's conversation a routine's browser
--                             runs beside. Opened by the engine the first
--                             time a run browses, and reused after, so every
--                             run's browser tasks land in one thread the owner
--                             can open — to watch, to take over at a sign-in,
--                             to read what the browser said word for word.
--
-- Everything `lib/browser/` built is keyed on a conversation — one
-- `browser_sessions` row per conversation and person (0078), the line (0080),
-- the panel, the take-over, the sweep — and a routine borrowing one gets all
-- of it unchanged. The alternative was making `browser_tasks.session_id`
-- nullable, which would have meant teaching each of those a second owner.
-- `on delete set null`, so a conversation somebody deletes is simply opened
-- again on the next run that browses.
--
-- ---------------------------------------------------------------------------
-- A RUN THAT WAITS FOR ITS BROWSER.
--
--   routine_runs.status 'waiting'   the turn has ended and the report is
--                                   written, but a browser task it started
--                                   has not answered yet. `summary` holds the
--                                   draft. Nothing has been delivered.
--   routine_runs.held_claimed_at    the claim on finishing it. Two things can
--                                   see the last task end — the open tab and
--                                   the cron, as 0078 says of every settle —
--                                   and the report must go out once, so the
--                                   finish begins with a conditional update
--                                   of this column, as `settleBrowserTask`'s
--                                   begins with one of `status`.
--
-- The report is sent once, with the browser's answers in it, rather than
-- twice — a digest now and an addendum later. A schedule nobody is watching
-- is read as one message, and a second one minutes after the first reads as a
-- correction.
--
--   browser_tasks.routine_run_id    which waiting run a task answers. Not a
--                                   foreign key, deliberately: the run's row
--                                   is written when the turn ENDS (`finish`
--                                   in `lib/routines/executor.ts`), and the
--                                   task is recorded during it, so the id is
--                                   chosen first and the row arrives after.
--                                   A task whose run is gone is a task whose
--                                   answer stays in the conversation, which
--                                   is where every browser answer goes.
--   browser_tasks.jarless           the run may not carry the owner's cookie
--                                   jar ('site'). On the row rather than read
--                                   back off the routine, because a task that
--                                   waits in line (0080) starts later, from
--                                   the queue, and must start the way it was
--                                   asked for even if the setting changed in
--                                   between.
--
-- A take-over's free retry (`retry_of`) answers the same run as the task it
-- retries, and is jarless if that was. A trigger says so, so neither of the
-- two places that record a retry has to remember.
-- =========================================================================

alter table public.routines
  add column if not exists browser_access text not null default 'off';

alter table public.routines
  drop constraint if exists routines_browser_access_known;
alter table public.routines
  add constraint routines_browser_access_known
  check (browser_access in ('off', 'all', 'site'));

alter table public.routines
  add column if not exists browser_site text;

alter table public.routines
  drop constraint if exists routines_browser_site_host;
alter table public.routines
  add constraint routines_browser_site_host
  check (
    browser_site is null
    or (browser_site = lower(browser_site) and browser_site !~ '[/:@\s]' and browser_site <> '')
  );

alter table public.routines
  drop constraint if exists routines_browser_site_named;
alter table public.routines
  add constraint routines_browser_site_named
  check (browser_access <> 'site' or browser_site is not null);

alter table public.routines
  add column if not exists browser_conversation_id uuid
    references public.chat_sessions (id) on delete set null;

comment on column public.routines.browser_access is
  'Whether a scheduled run may use the browser, and what it carries: off; all '
  '(the owner''s cookie jar and saved logins, as in chat); or site (no jar, '
  'only browser_site''s saved login). Turning it on is the owner''s approval '
  'for every run (0100).';

comment on column public.routines.browser_site is
  'With browser_access = site, the one host whose saved login a run may carry.';

comment on column public.routines.browser_conversation_id is
  'The owner''s conversation this routine''s browser runs beside. Opened by '
  'the engine on the first run that browses. Written by the service role only.';

grant update (browser_access, browser_site) on public.routines to authenticated;

alter table public.routine_runs drop constraint if exists routine_runs_status_check;
alter table public.routine_runs
  add constraint routine_runs_status_check
  check (status in ('ok', 'skipped', 'failed', 'waiting'));

alter table public.routine_runs
  add column if not exists held_claimed_at timestamptz;

comment on column public.routine_runs.held_claimed_at is
  'The claim on finishing a waiting run, taken by whichever settle saw its '
  'last browser task end. Null on every run that never waited (0100).';

-- The sweep's question: which runs have waited too long.
create index if not exists routine_runs_waiting_idx
  on public.routine_runs (started_at)
  where status = 'waiting';

alter table public.browser_tasks
  add column if not exists routine_run_id uuid;

alter table public.browser_tasks
  add column if not exists jarless boolean not null default false;

comment on column public.browser_tasks.routine_run_id is
  'The waiting routine run this task answers, or null for a conversation''s '
  'own task. Not a foreign key: the run row is written after the task (0100).';

comment on column public.browser_tasks.jarless is
  'The run must not carry the owner''s cookie jar (a routine with '
  'browser_access = site). Read again when a waiting task starts (0100).';

create index if not exists browser_tasks_routine_run_idx
  on public.browser_tasks (routine_run_id)
  where routine_run_id is not null;

-- ---- a retry answers what it retries ----------------------------------------
create or replace function public.browser_task_retry_inherits()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  original record;
begin
  if new.retry_of is not null then
    -- Into a record of its own: a `select ... into new.x` that finds no row
    -- sets its targets to null, and `jarless` is not null.
    select o.routine_run_id, o.jarless into original
      from public.browser_tasks o
      where o.id = new.retry_of;
    if found then
      new.routine_run_id := coalesce(new.routine_run_id, original.routine_run_id);
      new.jarless := new.jarless or original.jarless;
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.browser_task_retry_inherits() from public, anon;

drop trigger if exists browser_task_retry_inherits on public.browser_tasks;
create trigger browser_task_retry_inherits
  before insert on public.browser_tasks
  for each row execute function public.browser_task_retry_inherits();
