-- =========================================================================
-- What the agent actually did
--
-- Two tables. One records the steps a reply took, so an answer is something a
-- person can check rather than something they have to trust. The other holds a
-- turn that stopped to ask permission, so the question can be answered later
-- by a person who was not watching.
--
-- WHY `messages.role` IS NOT WIDENED, which is the obvious alternative and the
-- wrong one. That column is `check (role in ('user','assistant'))` (0001) and
-- two security constraints branch on the value: `messages_grounding_valid`
-- (0039) and `messages_version_valid` (0050), whose own comments each call the
-- assistant branch "the security half". Adding a third role means relaxing
-- both of them — a transcript gains a row shape those checks were never
-- written against, and the two places that decide what an assistant row may
-- claim start having to say "unless it is a tool row". A separate table costs
-- one join and relaxes nothing.
-- =========================================================================

-- ---- message_steps -------------------------------------------------------
--
-- One row per tool the agent ran while writing one reply. Written whether the
-- tool worked or not: what an agent TRIED is as much a part of the record as
-- what it managed, which is the same reasoning 0058 gives for recording
-- refused capability calls.
create table if not exists public.message_steps (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages (id) on delete cascade,
  -- Order within the reply, from zero. Not a timestamp: two tools asked for in
  -- one pass start in the same millisecond and the order the model wrote them
  -- in is the order a person should read them in.
  step_index int not null check (step_index >= 0),
  tool text not null,
  -- The arguments the model sent, parsed. Never anything a person typed, and
  -- never a credential — a tool is given a connection id, and the secret is
  -- resolved from it on the worker.
  request jsonb not null default '{}'::jsonb,
  -- The first part of what came back, trimmed by the worker. Deliberately not
  -- the whole result: this is read on every transcript load, and a person
  -- checking the agent's work needs the shape of the answer rather than all of
  -- it.
  result_excerpt text,
  -- `pending` is a step that asked for confirmation and has not had it yet.
  -- It becomes `ok`, `failed` or `refused` when the person answers, and stays
  -- `pending` forever if they never do — which is a true record.
  status text not null check (status in ('ok', 'failed', 'refused', 'pending')),
  duration_ms int check (duration_ms >= 0),
  -- Tokens attributable to this step, when they can be attributed at all.
  -- Usually null: a provider bills a pass, not a tool, and inventing a split
  -- would be a number that looks precise and is not.
  tokens int check (tokens >= 0),
  created_at timestamptz not null default now()
);

comment on table public.message_steps is
  'The tools one reply ran, in order. Written for failures too - what an agent '
  'tried is part of the record.';

create unique index if not exists message_steps_order_idx
  on public.message_steps (message_id, step_index);

-- ---- who may see a step --------------------------------------------------
--
-- The message's own door, and nothing new. A step is part of a reply: if the
-- reply is visible the steps behind it are, and if it is not they are not.
--
-- `security definer` for the reason every policy helper in this schema is one
-- (0031): a policy on this table must not re-enter `messages`' own policies,
-- which would evaluate `session_is_visible` a second time for the same answer.
create or replace function public.message_is_visible(p_message_id uuid)
returns boolean
language sql
security definer
stable
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.messages m
    where m.id = p_message_id
      and public.session_is_visible(m.session_id)
  );
$$;

revoke all on function public.message_is_visible(uuid) from public, anon;
-- `authenticated` must hold EXECUTE or the policy below fails outright for
-- everybody: a policy is evaluated as the caller.
grant execute on function public.message_is_visible(uuid) to authenticated, service_role;

alter table public.message_steps enable row level security;

drop policy if exists "message_steps_read" on public.message_steps;
create policy "message_steps_read"
  on public.message_steps for select
  using (public.message_is_visible(message_id));

-- No INSERT, UPDATE or DELETE policy for any client role, deliberately. A step
-- is the worker's account of what it did, and an account the subject can edit
-- is not an account. The rows are written with the service-role client
-- `routes/chat.ts` already holds for assistant messages — which is why this
-- adds no FILE to `service-client.static.test.ts`'s allowlist, only a second
-- reason for an entry that is already there.
revoke all on public.message_steps from anon, authenticated;
grant select on public.message_steps to authenticated;
grant select, insert, update, delete on public.message_steps to service_role;

-- ---- paused_turns --------------------------------------------------------
--
-- A turn that asked for permission, parked until somebody answers.
--
-- WHY THIS IS GENERAL AND NOT ABOUT SCHEDULING. The first tool that needs it
-- proposes a routine, so the shape could have been `pending_routines` with the
-- draft in columns. It is not, because 0058's `ask -> pending -> approved`
-- needs exactly this mechanism and building it twice means going through every
-- tool a second time. `tool_call` and `proposal` are opaque here on purpose.
--
-- WHY A SCHEDULED RUN DOES NOT WAIT. Nobody is watching one, and a tick has
-- nowhere to wait: a claim goes stale in thirty minutes
-- (`lib/routines/dispatcher.ts`). So an unattended run writes the row, ends,
-- and the person finds it later. That is 0058's own argument for why a
-- capability call is a record rather than a block.
create table if not exists public.paused_turns (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.chat_sessions (id) on delete cascade,
  -- The question this turn is answering. Null for a run that nobody asked --
  -- a routine has no message to hang off.
  message_id uuid references public.messages (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  agent_id uuid not null references public.agents (id) on delete cascade,
  -- Who may answer. Not "who may see it": a shared session shows the pending
  -- question to everyone in it, and the worker still only accepts the answer
  -- from this person, because the tool will run with their standing.
  user_id uuid not null references auth.users (id) on delete cascade,
  tool text not null,
  -- The call as the provider sent it: {id, name, arguments}. Opaque.
  tool_call jsonb not null,
  -- One sentence a person reads, and the machine-readable thing they are
  -- agreeing to. The card renders the second; the first is what it is titled.
  summary text not null,
  proposal jsonb,
  -- Everything the model has been shown so far, including the assistant turn
  -- that asked. Resuming replays this rather than rebuilding it, so the second
  -- half of the turn sees exactly what the first half did.
  messages jsonb not null,
  -- The steps already taken, so a resumed turn continues the budget instead of
  -- starting a fresh one. Without it, approving repeatedly buys an unbounded
  -- loop.
  steps jsonb not null default '[]'::jsonb,
  -- Which model was answering. A resumed turn must not quietly change models
  -- halfway through, and the agent's setting may have moved since.
  model text,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'declined', 'expired')),
  -- A pending turn holds a whole prompt in `messages`, and a prompt that is a
  -- day old is answering a conversation that has moved on. An hour is long
  -- enough for somebody to come back from a meeting and short enough that the
  -- transcript still means what it meant.
  expires_at timestamptz not null default now() + interval '1 hour',
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

comment on table public.paused_turns is
  'An agent turn stopped to ask a person for permission. Deliberately general: '
  'this is the mechanism 0058 needs for ask -> pending -> approved.';

create index if not exists paused_turns_session_idx
  on public.paused_turns (session_id, created_at desc);

-- The sweeper's query. Partial, because everything that is not pending is
-- already answered and will never be swept.
create index if not exists paused_turns_pending_idx
  on public.paused_turns (expires_at)
  where status = 'pending';

alter table public.paused_turns enable row level security;

-- Visible to whoever can see the conversation it belongs to. Answering is a
-- narrower right than seeing and is checked in the worker against `user_id`,
-- not here — the policy cannot express "and the person pressing the button is
-- the one whose standing the tool will run with", because the button is a POST
-- to the worker rather than an UPDATE from the browser.
drop policy if exists "paused_turns_read" on public.paused_turns;
create policy "paused_turns_read"
  on public.paused_turns for select
  using (public.session_is_visible(session_id));

-- No write policy of any kind for a client role. Every column here is the
-- worker's account of a turn it is in the middle of, and `messages` is the
-- prompt itself — a client that could write this could rewrite what the model
-- is about to be shown, which is a prompt injection with a database behind it.
--
-- The column grant withholds `messages` and `tool_call` for the same reason a
-- credential is withheld elsewhere: the screen needs the summary and the
-- proposal to draw a card, and has no use for the transcript of the prompt.
revoke all on public.paused_turns from anon, authenticated;
grant select (
  id, session_id, message_id, workspace_id, agent_id, user_id, tool, summary,
  proposal, status, expires_at, created_at, resolved_at
) on public.paused_turns to authenticated;
grant select, insert, update, delete on public.paused_turns to service_role;
