-- A document that writes itself: a long document is written section by
-- section, in the background, and survives the tab that asked for it.
--
-- Before this, a report was one blocking model call (`routes/reports.ts`):
-- 8,192 output tokens, nothing on screen for two or three minutes, and nothing
-- at all if the request died. And a person who asked the agent for a report in
-- chat got none — the agent had no way to make a document, so it wrote the
-- report as a reply, and a reply that dies mid-way leaves no row
-- (covan-ai/covan-cloud#331).
--
-- A job here is the plan for one document: an outline, then one model call per
-- section, each section written to its own row the moment it is done. Whoever
-- advances the job — a Durable Object alarm, a timer on Node, the open tab's
-- poll, the cron tick — does exactly one unit of work and lets go, so a worker
-- that dies loses at most the section it was writing. When the last section is
-- in, the sections are joined and filed into a knowledge bundle as an ordinary
-- `documents` row, and `document_id` points at it.
--
-- ---------------------------------------------------------------------------
-- WHY THE READ POLICY IS THE REQUESTER'S, NOT THE SESSION'S.
--
-- `browser_tasks`' argument (0073), unchanged: a job spends the allowance of
-- ONE person, and `requested_by` is whose. The finished document is filed into
-- a bundle and is visible to the workspace through the documents' own
-- policies, which is the right place for that to be decided.
--
-- ---------------------------------------------------------------------------
-- WHY NO CLIENT WRITES.
--
-- `paused_turns`' reason (0060): every column is the worker's account of what
-- it did with somebody's money. A client that could insert a section could put
-- words into a document the agent then reads back as its own. Stopping and
-- retrying go through the API, which checks the caller and writes with the
-- service role.

create table if not exists public.document_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  -- Where the finished document is filed. Checked writable with the caller's
  -- own client before the job is created; see `lib/docs/enqueue.ts`.
  bundle_id uuid not null references public.knowledge_bundles (id) on delete cascade,
  agent_id uuid not null references public.agents (id) on delete cascade,
  -- The conversation it was asked from. Nullable so a future caller with no
  -- conversation (a routine) does not need a second table.
  session_id uuid references public.chat_sessions (id) on delete cascade,
  requested_by uuid not null references auth.users (id) on delete cascade,
  origin text not null check (origin in ('tool', 'button')),
  instruction text not null,
  title text not null,
  -- What every section is written from, taken once when the job is created so
  -- that section six is grounded in the same passages as section one.
  history jsonb not null default '[]'::jsonb,
  sources text not null default '',
  -- `[{heading, brief}]`, written by the outline call.
  outline jsonb,
  -- The next section to write.
  cursor int not null default 0,
  status text not null default 'queued'
    check (status in ('queued', 'writing', 'filing', 'ready', 'failed', 'stopped')),
  document_id uuid references public.documents (id) on delete set null,
  error text,
  attempts int not null default 0,
  -- Who is working on it right now, and until when. A lease rather than a
  -- flag, because a worker that dies holding one must not hold it forever.
  lease_until timestamptz,
  next_run_at timestamptz not null default now(),
  prompt_tokens int not null default 0,
  completion_tokens int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);

comment on table public.document_jobs is
  'A long document written section by section in the background, outliving '
  'the request that asked for it; filed into bundle_id as a documents row '
  'when the last section is in (0102).';

create table if not exists public.document_sections (
  job_id uuid not null references public.document_jobs (id) on delete cascade,
  idx int not null,
  heading text not null,
  brief text not null default '',
  body text not null default '',
  status text not null default 'pending' check (status in ('pending', 'done')),
  updated_at timestamptz not null default now(),
  primary key (job_id, idx)
);

comment on table public.document_sections is
  'One section of a document_jobs row, written by its own model call and '
  'saved the moment it is done (0102).';

-- The cron's query. Partial: a job that has finished will never run again.
create index if not exists document_jobs_due_idx
  on public.document_jobs (next_run_at)
  where status in ('queued', 'writing', 'filing');

create index if not exists document_jobs_session_idx
  on public.document_jobs (session_id, created_at desc);

-- The three references a job carries must name one workspace. The API checks
-- this before it inserts, and this is the second half of the same guard, for
-- anything else that holds the service role (0092's reasoning).
create or replace function public.document_jobs_stay_in_their_workspace()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if not exists (
    select 1 from public.knowledge_bundles b
     where b.id = new.bundle_id and b.workspace_id = new.workspace_id
  ) then
    raise exception 'document_jobs: bundle is not in the job''s workspace';
  end if;
  if not exists (
    select 1 from public.agents a
     where a.id = new.agent_id and a.workspace_id = new.workspace_id
  ) then
    raise exception 'document_jobs: agent is not in the job''s workspace';
  end if;
  if new.session_id is not null and not exists (
    select 1 from public.chat_sessions s
     where s.id = new.session_id and s.workspace_id = new.workspace_id
  ) then
    raise exception 'document_jobs: session is not in the job''s workspace';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_document_jobs_stay_in_their_workspace on public.document_jobs;
create trigger trg_document_jobs_stay_in_their_workspace
  before insert or update of workspace_id, bundle_id, agent_id, session_id
  on public.document_jobs
  for each row execute function public.document_jobs_stay_in_their_workspace();

alter table public.document_jobs enable row level security;
alter table public.document_sections enable row level security;

drop policy if exists "document_jobs_read" on public.document_jobs;
create policy "document_jobs_read"
  on public.document_jobs for select
  using (requested_by = auth.uid() and public.is_workspace_member(workspace_id));

drop policy if exists "document_sections_read" on public.document_sections;
create policy "document_sections_read"
  on public.document_sections for select
  using (exists (
    select 1 from public.document_jobs j
     where j.id = document_sections.job_id
       and j.requested_by = auth.uid()
       and public.is_workspace_member(j.workspace_id)
  ));

-- 0087's restrictive policy, for the table that carries a workspace and the
-- one that reaches it through its job.
drop policy if exists document_jobs_request_workspace on public.document_jobs;
create policy document_jobs_request_workspace on public.document_jobs
  as restrictive for all to authenticated
  using ((select public.request_workspace()) is null
         or workspace_id = (select public.request_workspace()));

drop policy if exists document_sections_request_workspace on public.document_sections;
create policy document_sections_request_workspace on public.document_sections
  as restrictive for all to authenticated
  using ((select public.request_workspace()) is null or exists (
    select 1 from public.document_jobs j
     where j.id = document_sections.job_id
       and j.workspace_id = (select public.request_workspace())));

revoke all on public.document_jobs from anon, authenticated;
revoke all on public.document_sections from anon, authenticated;
-- `history` and `sources` are left out: they are the prompt the sections were
-- written from, which is the conversation and the passages retrieved for it.
-- The screen has no use for them, and a member who can see the job but not
-- every document behind those passages should not read them through it.
grant select (
  id, workspace_id, bundle_id, agent_id, session_id, requested_by, origin,
  instruction, title, outline, cursor, status, document_id, error,
  created_at, updated_at, finished_at
) on public.document_jobs to authenticated;
grant select on public.document_sections to authenticated;
grant select, insert, update, delete on public.document_jobs to service_role;
grant select, insert, update, delete on public.document_sections to service_role;

-- ---- claim_document_job --------------------------------------------------
-- Take one job for one unit of work, or nothing if somebody else holds it.
-- Every clock that advances a job calls this first, so the Durable Object, the
-- open tab and the cron can all fire at once and only one of them writes the
-- section.
create or replace function public.claim_document_job(
  p_id uuid,
  p_lease interval default interval '5 minutes'
)
returns setof public.document_jobs
language sql
security definer
set search_path = pg_catalog, public
as $$
  update public.document_jobs j
  set lease_until = now() + p_lease,
      updated_at = now()
  where j.id = p_id
    and j.status in ('queued', 'writing', 'filing')
    and (j.lease_until is null or j.lease_until < now())
  returning j.*;
$$;

revoke all on function public.claim_document_job(uuid, interval) from public, anon, authenticated;
grant execute on function public.claim_document_job(uuid, interval) to service_role;

-- ---- claim_due_document_jobs -----------------------------------------------
-- The cron's fallback: jobs whose clock stopped (no Durable Object bound, the
-- tab closed, a worker died holding the lease). The status filter sits inside
-- the `for update skip locked` sub-select for 0055's reason.
create or replace function public.claim_due_document_jobs(
  p_limit int default 2,
  p_lease interval default interval '5 minutes'
)
returns setof public.document_jobs
language sql
security definer
set search_path = pg_catalog, public
as $$
  update public.document_jobs j
  set lease_until = now() + p_lease,
      updated_at = now()
  where j.id in (
    select id from public.document_jobs
    where status in ('queued', 'writing', 'filing')
      and next_run_at <= now()
      and (lease_until is null or lease_until < now())
    order by next_run_at
    for update skip locked
    limit p_limit
  )
  returning j.*;
$$;

revoke all on function public.claim_due_document_jobs(int, interval) from public, anon, authenticated;
grant execute on function public.claim_due_document_jobs(int, interval) to service_role;
